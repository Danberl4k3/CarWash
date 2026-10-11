import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { buildApp } from '../dist/app.js';
import { createDatabase } from '../dist/db.js';

const executablePath = process.env.BROWSER_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

async function runE2E() {
  await mkdir('artifacts', { recursive: true });
  console.log('Iniciando servidor de pruebas para E2E...');
  process.env.ADMIN_USERNAME = 'admin-e2e';
  process.env.ADMIN_PASSWORD = 'password-e2e-1234';

  const { db } = createDatabase(':memory:');
  const app = await buildApp({ db, cookieSecret: 'cookie-secret-for-browser-e2e-testing-32chars' });
  await app.listen({ port: 3399, host: '127.0.0.1' });
  const baseUrl = 'http://127.0.0.1:3399';
  console.log(`Servidor activo en ${baseUrl}`);

  console.log('Lanzando navegador Edge / Chromium en modo headless...');
  const browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  try {
    console.log('1. Navegando a la página de inicio...');
    await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });

    // Verificar título y estructura
    const title = await page.title();
    console.log(`✓ Título de la página: "${title}"`);

    // Verificar orden de leyendas 1..5
    const legends = await page.$$eval('legend', (els) => els.map((e) => e.textContent.trim()));
    console.log('✓ Secciones encontradas en la página:', legends);
    if (!legends[0].includes('Tus datos')) throw new Error('Sección 1 no es Tus datos');
    if (!legends[1].includes('¿Qué vehículo traes?')) throw new Error('Sección 2 no es ¿Qué vehículo traes?');
    if (!legends[2].includes('Horario')) throw new Error('Sección 3 no es Horario');
    if (!legends[3].includes('Elige el lavado')) throw new Error('Sección 4 no es Elige el lavado');
    if (!legends[4].includes('Agrega un cuidado extra')) throw new Error('Sección 5 no es Agrega un cuidado extra');

    console.log('2. Probando botón de Modo Oscuro...');
    const themeBtn = page.locator('.theme-toggle-btn');
    await themeBtn.click();
    const isDark = await page.evaluate(() => document.documentElement.getAttribute('data-theme') === 'dark');
    assert.equal(isDark, true);
    console.log(`✓ Modo oscuro activado: ${isDark}`);
    await themeBtn.click(); // Regresar a claro

    console.log('2.5. Probando consulta de placa SUNARP y autocompletado...');
    await page.fill('input[name="plate"]', 'SUV-001');
    await page.click('#btn-lookup-plate');
    await page.waitForTimeout(800);
    const feedbackText = await page.textContent('#plate-feedback');
    console.log(`✓ Feedback de consulta de placa: "${feedbackText?.trim()}"`);
    const modelValue = await page.inputValue('input[name="model"]');
    console.log(`✓ Modelo autocompletado: "${modelValue}"`);
    const isSmallSuv = await page.locator('input[name="vehicleType"][value="small_suv"]').isChecked();
    assert.equal(isSmallSuv, true);
    assert.match(feedbackText, /demostración/);
    assert.match(modelValue, /Sportage/i);
    console.log(`✓ SUV Compacta seleccionada automáticamente: ${isSmallSuv}`);

    console.log('3. Llenando formulario de reserva...');
    assert.equal(await page.locator('input[name="paymentStatus"]:checked').inputValue(), 'pending');
    await page.locator('label.payment-option:has(input[name="paymentStatus"][value="paid"])').click();
    assert.equal(await page.locator('input[name="paymentStatus"]:checked').inputValue(), 'paid');
    await page.locator('label.payment-option:has(input[name="paymentMethod"][value="plin"])').click();
    assert.equal(await page.locator('input[name="paymentMethod"]:checked').inputValue(), 'plin');
    await page.locator('input[name="paymentMethod"][value="plin"]').focus();
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.locator('input[name="paymentMethod"]:checked').inputValue(), 'yape');
    await page.fill('input[name="plate"]', 'tst-999');
    await page.fill('input[name="model"]', 'toyota yaris');
    await page.fill('input[name="name"]', 'pedro infante');
    await page.fill('input[name="phone"]', '999888777');

    // Seleccionar vehículo Auto
    await page.locator('input[name="vehicleType"][value="car"]').check({ force: true });

    // Probar atajo de horario de recojo (+ 1 hora)
    const btn1Hora = page.locator('button[data-pickup-offset="60"]');
    await btn1Hora.click();
    const pickupVal = await page.inputValue('#pickup-time');
    console.log(`✓ Hora estimada de recojo establecida con atajo: "${pickupVal}"`);

    // Seleccionar servicio
    const completeWash = page.locator('input[data-slug="complete"]');
    await completeWash.check({ force: true });

    // Seleccionar adicional cera
    const waxAddon = page.locator('label[data-addon-slug="wax"] input');
    await waxAddon.check({ force: true });

    const totalText = await page.textContent('#booking-total');
    assert.match(totalText, /30\.00/);
    await themeBtn.click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: 'artifacts/public-payment-choice.png', fullPage: true });
    await themeBtn.click();
    console.log(`✓ Total calculado en pantalla: "${totalText?.trim()}"`);

    console.log('4. Enviando formulario de reserva...');
    await Promise.all([
      page.waitForNavigation(),
      page.click('button[type="submit"]'),
    ]);

    const confirmationUrl = page.url();
    console.log(`✓ Redirigido exitosamente a: ${confirmationUrl}`);
    if (!confirmationUrl.includes('/reserva/DASAV-')) {
      throw new Error(`URL de confirmación inesperada: ${confirmationUrl}`);
    }

    const cardText = await page.textContent('.confirmation-card');
    if (!cardText.includes('TST-999')) throw new Error('No se encontró placa TST-999 en el comprobante');
    console.log('✓ Comprobante verificado con placa y código de reserva.');
    assert.match(await page.locator('#tracker-payment-badge').textContent(), /Pagado/);
    assert.deepEqual(db.prepare('SELECT payment_status, amount_paid_cents, total_cents, created_by_admin FROM bookings b JOIN vehicles v ON v.id = b.vehicle_id WHERE v.plate = ?').get('TST-999'), { payment_status: 'paid', amount_paid_cents: 3000, total_cents: 3000, created_by_admin: 0 });

    console.log('5. Accediendo al Panel Administrativo...');
    await page.goto(`${baseUrl}/admin/login`);
    await page.fill('input[name="username"]', 'admin-e2e');
    await page.fill('input[name="password"]', 'password-e2e-1234');
    await Promise.all([
      page.waitForNavigation(),
      page.click('button[type="submit"]'),
    ]);

    const adminHeading = await page.textContent('h1');
    console.log(`✓ Panel administrativo cargado: "${adminHeading?.trim()}"`);

    const boardContent = await page.textContent('body');
    if (!boardContent.includes('TST-999')) {
      throw new Error('La reserva creada no figura en el panel de administración');
    }
    console.log('✓ La reserva figura visiblemente en el panel del administrador.');

    console.log('6. Registrando una nueva reserva ya pagada desde recepción...');
    await page.goto(`${baseUrl}/`);
    assert.equal(await page.locator('input[name="paymentStatus"]:checked').inputValue(), 'pending');
    await page.fill('input[name="plate"]', 'PAG-321');
    await page.locator('input[data-slug="complete"]').check({ force: true });
    await page.locator('label[data-addon-slug="wax"] input').check({ force: true });
    await page.locator('label.payment-option:has(input[name="paymentMethod"][value="cash"])').click();
    await page.locator('label.payment-option:has(input[name="paymentStatus"][value="paid"])').click();
    await Promise.all([
      page.waitForURL('**/reserva/DASAV-*'),
      page.click('button[type="submit"]'),
    ]);
    assert.match(await page.locator('#tracker-payment-badge').textContent(), /Pagado/);
    const paid = db.prepare('SELECT payment_status, amount_paid_cents, total_cents FROM bookings b JOIN vehicles v ON v.id = b.vehicle_id WHERE v.plate = ?').get('PAG-321');
    assert.deepEqual(paid, { payment_status: 'paid', amount_paid_cents: 3000, total_cents: 3000 });
    await page.goto(`${baseUrl}/admin`);
    const paidCard = page.locator('.vehicle-card').filter({ hasText: 'PAG-321' });
    assert.equal(await paidCard.getAttribute('data-payment-status'), 'paid');
    console.log('✓ El comprobante y el panel muestran el pago completo de S/ 30.00.');

    console.log('7. Registrando una nueva reserva sin pago desde el formulario administrativo...');
    await page.goto(`${baseUrl}/admin/reservas/nueva`);
    assert.equal(await page.locator('input[name="paymentStatus"]:checked').inputValue(), 'pending');
    await page.fill('input[name="plate"]', 'NPG-321');
    await page.selectOption('select[name="vehicleType"]', 'car');
    await page.selectOption('select[name="baseServiceId"]', { label: 'Lavado completo' });
    await Promise.all([
      page.waitForURL(/\/admin\/reservas\/\d+(?:\?|$)/, { timeout: 5000 }),
      page.click('#booking-form button.primary-button[type="submit"]'),
    ]);
    const unpaid = db.prepare('SELECT payment_status, amount_paid_cents, total_cents FROM bookings b JOIN vehicles v ON v.id = b.vehicle_id WHERE v.plate = ?').get('NPG-321');
    assert.deepEqual(unpaid, { payment_status: 'pending', amount_paid_cents: 0, total_cents: 2000 });
    assert.equal(await page.locator('select[name="paymentStatus"]').inputValue(), 'pending');
    console.log('✓ La reserva queda pendiente con S/ 0.00 cobrado.');

    console.log('8. Editando minutos y registrando un abono...');
    const unpaidId = Number(new URL(page.url()).pathname.split('/').pop());
    await page.fill('input[name="dropoffMinute"]', '37');
    await page.fill('input[name="pickupMinute"]', '49');
    await page.fill('input[name="amountPaid"]', '5');
    await page.fill('textarea[name="notes"]', 'Abono de prueba');
    await Promise.all([page.waitForURL('**/admin?**'), page.click('#booking-form button.primary-button[type="submit"]')]);
    assert.equal(db.prepare('SELECT amount_paid_cents FROM bookings WHERE id = ?').get(unpaidId).amount_paid_cents, 500);
    const card = page.locator(`#booking-${unpaidId}`);
    await card.locator('button[value="next_status"]').click();
    await page.waitForFunction(id => document.querySelector(`#booking-${id}`)?.dataset.status === 'in_progress', unpaidId);
    assert.equal(db.prepare('SELECT amount_paid_cents FROM bookings WHERE id = ?').get(unpaidId).amount_paid_cents, 500);
    assert.ok(db.prepare('SELECT started_washing_at FROM bookings WHERE id = ?').get(unpaidId).started_washing_at);

    console.log('9. Comprobando filtros después de la actualización en tiempo real...');
    await page.locator('[data-summary-filter="in_progress"]').click();
    assert.equal(await card.isVisible(), true);
    assert.equal(await paidCard.isVisible(), false);
    await page.locator('[data-summary-filter="all"]').click();
    await page.fill('#board-search', 'NPG-321');
    assert.equal(await card.isVisible(), true);
    assert.equal(await paidCard.isVisible(), false);
    await page.fill('#board-search', '');
    await card.locator('button[value="toggle_payment"]').click();
    await page.waitForFunction(id => document.querySelector(`#booking-${id}`)?.dataset.paymentStatus === 'paid', unpaidId);
    assert.equal(db.prepare('SELECT amount_paid_cents FROM bookings WHERE id = ?').get(unpaidId).amount_paid_cents, 2000);
    await card.locator('button[value="next_status"]').click();
    await page.waitForFunction(id => document.querySelector(`#booking-${id}`)?.dataset.status === 'completed', unpaidId);
    assert.equal(await card.isVisible(), false);
    await page.locator('[data-summary-filter="completed"]').click();
    assert.equal(await card.isVisible(), true);

    console.log('10. Comprobando ticket, descarga CSV y QR...');
    const popupPromise = page.waitForEvent('popup');
    await card.locator('.ticket-btn').click();
    const ticket = await popupPromise;
    await ticket.waitForLoadState('domcontentloaded');
    assert.match(await ticket.locator('body').textContent(), /NPG-321/);
    await ticket.close();
    const downloadPromise = page.waitForEvent('download');
    await page.locator('.export-csv-btn').click();
    const download = await downloadPromise;
    assert.match(download.suggestedFilename(), /\.csv$/);
    assert.equal(await download.failure(), null);
    await page.locator('button[data-open-qr="hugo"]').click();
    assert.equal(await page.locator('#yape-qr-modal').isVisible(), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#yape-qr-modal').isVisible(), false);

    console.log('11. Comprobando escape de datos y privacidad en el formulario público...');
    db.prepare('UPDATE vehicles SET model = ? WHERE plate = ?').run('<img src=x onerror="window.__xss=1">', 'NPG-321');
    await page.goto(`${baseUrl}/`);
    await page.fill('input[name="plate"]', 'NPG-321');
    await page.click('#btn-lookup-plate');
    await page.waitForFunction(() => document.querySelector('#plate-feedback')?.textContent.includes('<img'));
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    assert.equal(await page.locator('#plate-feedback img').count(), 0);

    console.log('12. Comprobando móvil y selección de servicios para moto...');
    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await mobile.goto(`${baseUrl}/`);
    assert.equal(await mobile.locator('input[name="paymentStatus"]').count(), 2);
    await mobile.locator('label.payment-option:has(input[name="paymentMethod"][value="cash"])').click();
    await mobile.locator('label.payment-option:has(input[name="paymentStatus"][value="paid"])').click();
    assert.equal(await mobile.locator('input[name="paymentMethod"]:checked').inputValue(), 'cash');
    assert.equal(await mobile.locator('input[name="paymentStatus"]:checked').inputValue(), 'paid');
    assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await mobile.locator('input[name="vehicleType"][value="motorcycle"]').check({ force: true });
    assert.equal(await mobile.locator('input[name="baseServiceId"]:checked').getAttribute('data-slug'), 'motorcycle-wash');
    const anon = await mobile.request.get(`${baseUrl}/api/vehiculo-lookup?plate=NPG-321`);
    assert.equal((await anon.json()).phone, null);
    await mobile.waitForTimeout(300);
    assert.equal(await mobile.locator('input[name="vehicleType"][value="motorcycle"]').isChecked(), true);
    await mobile.screenshot({ path: 'artifacts/full-test-mobile.png', fullPage: true });
    await mobile.close();

    console.log('13. Comprobando que un reloj adelantado no cause recargas continuas...');
    db.prepare("UPDATE bookings SET status = 'in_progress', started_washing_at = ? WHERE id = ?").run(new Date(Date.now() - 29 * 60000).toISOString(), unpaidId);
    await page.addInitScript(() => { const original = Date.now; Date.now = () => original() + 120000; });
    let dashboardRequests = 0;
    const countDashboard = request => { if (request.method() === 'GET' && new URL(request.url()).pathname === '/admin') dashboardRequests++; };
    page.on('request', countDashboard);
    await page.goto(`${baseUrl}/admin`);
    await page.waitForTimeout(6500);
    assert.ok(dashboardRequests <= 2, `Recargas inesperadas: ${dashboardRequests}`);
    page.off('request', countDashboard);
    await page.screenshot({ path: 'artifacts/full-test-dashboard.png', fullPage: true });

    console.log('14. Comprobando las páginas administrativas y cierre de sesión...');
    for (const path of ['/admin/clientes', '/admin/servicios', '/admin/capacidad', '/admin/seguridad']) {
      assert.equal((await page.goto(`${baseUrl}${path}`)).status(), 200);
    }
    await Promise.all([page.waitForURL('**/admin/login'), page.locator('form[action="/admin/logout"] button').click()]);
    await page.goto(`${baseUrl}/admin`);
    assert.equal(new URL(page.url()).pathname, '/admin/login');

    console.log('\n========================================');
    console.log('🎉 TODAS LAS PRUEBAS E2E PASARON CON ÉXITO');
    console.log('========================================\n');
  } finally {
    await browser.close();
    await app.close();
    db.close();
  }
}

runE2E().catch((err) => {
  console.error('Error en pruebas E2E:', err);
  process.exit(1);
});


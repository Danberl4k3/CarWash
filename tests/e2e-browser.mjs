import { chromium } from 'playwright-core';
import { buildApp } from '../dist/app.js';
import { createDatabase } from '../dist/db.js';

const executablePath = process.env.BROWSER_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

async function runE2E() {
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
    console.log(`✓ Modo oscuro activado: ${isDark}`);
    await themeBtn.click(); // Regresar a claro

    console.log('3. Llenando formulario de reserva...');
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


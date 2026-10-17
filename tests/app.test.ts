import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { createBooking } from '../src/domain/bookings.js';
import { getLimaNow } from '../src/time.js';

describe('aplicación web', () => {
  let app: FastifyInstance;
  let db: Database.Database;

  beforeEach(async () => {
    process.env.ADMIN_USERNAME = 'admin-test';
    process.env.ADMIN_PASSWORD = 'password-seguro-test';
    db = createDatabase(':memory:').db;
    app = await buildApp({ db, cookieSecret: 'test-cookie-secret-with-more-than-32-chars' });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
    delete process.env.ADMIN_USERNAME;
    delete process.env.ADMIN_PASSWORD;
  });

  it('renderiza el formulario público', async () => {
    const response = await app.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Separa tu turno');
    expect(response.body).toContain('Lavado completo');
    expect(response.body).toContain('Hugo');
    expect(response.body).toContain('Roxana');
    expect(response.body).toContain('yape-qr-modal');
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
  });

  it('mantiene habilitado el formulario de reservas los domingos', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-04T15:00:00Z'));
    try {
      const response = await app.inject({ method: 'GET', url: '/' });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('Lun–Dom');
      expect(response.body).not.toContain('Hoy no atendemos reservas.');
      expect(response.body).toMatch(/<form id="booking-form"[^>]*>/);
      expect(response.body.match(/<form id="booking-form"[^>]*>/)?.[0]).not.toContain('inert');
      const submit = response.body.match(/<button class="[^"]*global-submit-btn[^"]*" type="submit"[^>]*>/)?.[0];
      expect(submit).toBeDefined();
      expect(submit).not.toContain('disabled');
    } finally {
      vi.useRealTimers();
    }
  });
  it('expone un endpoint de salud', async () => {
    const response = await app.inject({ method: 'GET', url: '/salud' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', service: 'DASAV Car Wash' });
  });

  it('rechaza acciones administrativas sin CSRF', async () => {
    const login = await app.inject({
      method: 'POST', url: '/admin/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'username=admin-test&password=password-seguro-test',
    });
    const cookie = login.cookies[0];
    const response = await app.inject({
      method: 'POST', url: '/admin/logout',
      headers: { cookie: `${cookie.name}=${cookie.value}`, 'content-type': 'application/x-www-form-urlencoded' },
      payload: '',
    });
    expect(response.statusCode).toBe(403);
  });

  it('protege el panel y permite iniciar sesión', async () => {
    const anonymous = await app.inject({ method: 'GET', url: '/admin' });
    expect(anonymous.statusCode).toBe(302);
    expect(anonymous.headers.location).toBe('/admin/login');

    const login = await app.inject({
      method: 'POST',
      url: '/admin/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'username=admin-test&password=password-seguro-test',
    });
    expect(login.statusCode).toBe(302);
    const cookie = login.cookies[0];
    expect(cookie?.name).toBe('cw_admin_session');

    const dashboard = await app.inject({
      method: 'GET',
      url: '/admin',
      headers: { cookie: `${cookie.name}=${cookie.value}` },
    });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.body).toContain('Panel de recojos');
    expect(dashboard.body).toContain('Sin vehículos programados');
    expect(dashboard.body).not.toContain('class="pickup-column');
  });

  it('muestra cobrado, pendiente y facturado con abonos parciales y sin canceladas', async () => {
    const serviceId = (db.prepare('SELECT id FROM services WHERE slug = ?').get('exterior') as { id: number }).id;
    const now = getLimaNow();
    const create = (plate: string) => createBooking(db, {
      plate, vehicleType: 'car', baseServiceId: serviceId, addonServiceIds: [],
      dropoffHour: 7, pickupHour: 8, paymentMethod: 'cash', phone: '999999999', name: 'Panel test', notes: '',
    }, { now: { ...now, weekday: 'Mon' }, allowPastSlot: true });
    const partial = create('FIN-001');
    create('FIN-002');
    const cancelled = create('FIN-003');
    db.prepare('UPDATE bookings SET amount_paid_cents = 400 WHERE id = ?').run(partial.id);
    db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(cancelled.id);

    const login = await app.inject({ method: 'POST', url: '/admin/login', payload: { username: 'admin-test', password: 'password-seguro-test' } });
    const cookie = login.cookies[0];
    const dashboard = await app.inject({ method: 'GET', url: '/admin', headers: { cookie: `${cookie.name}=${cookie.value}` } });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.body).toMatch(/Falta cobrar<\/small>\s*<strong>S\/\s*16\.00<\/strong>/);
    expect(dashboard.body).toMatch(/Se cobró<\/small>\s*<strong>S\/\s*4\.00<\/strong>/);
    expect(dashboard.body).toMatch(/Total facturado<\/small>\s*<strong>S\/\s*20\.00<\/strong>/);
  });

  it('consulta saldos anteriores por placa solo para administración', async () => {
    const serviceId = (db.prepare('SELECT id FROM services WHERE slug = ?').get('exterior') as { id: number }).id;
    const now = getLimaNow();
    const create = (plate: string) => createBooking(db, {
      plate, vehicleType: 'car', baseServiceId: serviceId, addonServiceIds: [],
      dropoffHour: 7, pickupHour: 8, paymentMethod: 'cash', phone: '', name: '', notes: '',
    }, { now: { ...now, weekday: 'Mon' }, allowPastSlot: true });
    const partial = create('DEU-123');
    const unpaid = create('DEU-123');
    const paid = create('DEU-123');
    const cancelled = create('DEU-123');
    create('OTR-999');
    db.prepare('UPDATE bookings SET booking_date = ?, amount_paid_cents = 400 WHERE id = ?').run('2026-09-12', partial.id);
    db.prepare('UPDATE bookings SET booking_date = ? WHERE id = ?').run('2026-10-02', unpaid.id);
    db.prepare("UPDATE bookings SET payment_status = 'paid', amount_paid_cents = total_cents WHERE id = ?").run(paid.id);
    db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(cancelled.id);

    const url = '/admin/api/placa-saldos?plate=deu-123';
    const anonymous = await app.inject({ method: 'GET', url });
    expect(anonymous.statusCode).toBe(401);

    const login = await app.inject({ method: 'POST', url: '/admin/login', payload: { username: 'admin-test', password: 'password-seguro-test' } });
    const cookie = login.cookies[0];
    const response = await app.inject({ method: 'GET', url, headers: { cookie: `${cookie.name}=${cookie.value}` } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      plate: 'DEU-123', totalPendingCents: 1600,
      balances: [
        { bookingId: unpaid.id, date: '2026-10-02', pendingCents: 1000 },
        { bookingId: partial.id, date: '2026-09-12', pendingCents: 600 },
      ],
    });
  });

  it('refleja en el panel una reserva creada para hoy', async () => {
    const serviceId = (db.prepare('SELECT id FROM services WHERE slug = ?').get('exterior') as { id: number }).id;
    const now = getLimaNow();
    createBooking(db, {
      plate: 'TAB-001', vehicleType: 'car', baseServiceId: serviceId, addonServiceIds: [],
      dropoffHour: 7, pickupHour: 8, paymentMethod: 'cash', phone: '999999999', name: 'Panel test', notes: '',
    }, { now: { ...now, weekday: 'Mon' }, allowPastSlot: true });
    const inProgress = createBooking(db, {
      plate: 'TAB-002', vehicleType: 'car', baseServiceId: serviceId, addonServiceIds: [],
      dropoffHour: 7, pickupHour: 8, paymentMethod: 'cash', phone: '999999999', name: 'Panel test 2', notes: '',
    }, { now: { ...now, weekday: 'Mon' }, allowPastSlot: true });
    const completed = createBooking(db, {
      plate: 'TAB-003', vehicleType: 'car', baseServiceId: serviceId, addonServiceIds: [],
      dropoffHour: 7, pickupHour: 8, paymentMethod: 'cash', phone: '999999999', name: 'Panel test 3', notes: '',
    }, { now: { ...now, weekday: 'Mon' }, allowPastSlot: true });
    db.prepare('UPDATE bookings SET status = ?, started_washing_at = NULL WHERE id = ?').run('in_progress', inProgress.id);
    db.prepare('UPDATE bookings SET status = ? WHERE id = ?').run('completed', completed.id);
    const login = await app.inject({
      method: 'POST', url: '/admin/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'username=admin-test&password=password-seguro-test',
    });
    const cookie = login.cookies[0];
    const dashboard = await app.inject({
      method: 'GET', url: '/admin', headers: { cookie: `${cookie.name}=${cookie.value}` },
    });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.body).toContain('TAB-001');
    expect(dashboard.body).toContain('Panel Test');
    expect(dashboard.body).toContain('Vehículos por hora');
    expect(dashboard.body).toContain('TAB-002');
    expect(dashboard.body).toContain('TAB-003');
    expect(dashboard.body).toContain('8:00 a. m. (2)');
    expect(dashboard.body.match(/class="pickup-column/g)?.length).toBe(1);
  });

  it('muestra botones de pago Yape para Hugo y Roxana en la página de confirmación y autocompleta teléfono', async () => {
    const serviceId = (db.prepare('SELECT id FROM services WHERE slug = ?').get('complete') as { id: number }).id;
    const booking = createBooking(db, {
      plate: 'YAP-100',
      name: 'Carlos Yapeador',
      phone: '987654321',
      model: 'Toyota Corolla',
      vehicleType: 'car',
      baseServiceId: serviceId,
      addonServiceIds: [],
      dropoffHour: 8,
      pickupHour: 9,
      paymentMethod: 'yape',
    });

    // 1. Verificar confirmación
    const confRes = await app.inject({ method: 'GET', url: `/reserva/${booking.code}` });
    expect(confRes.statusCode).toBe(200);
    expect(confRes.body).toContain('Hugo');
    expect(confRes.body).toContain('Roxana');
    expect(confRes.body).toContain('data-open-qr="hugo"');
    expect(confRes.body).toContain('data-open-qr="roxana"');
    expect(confRes.body).toContain('yape-qr-modal');

    // 2. Verificar que lookupVehicleByPlate devuelve teléfono y nombre
    const login = await app.inject({ method: 'POST', url: '/admin/login', payload: { username: 'admin-test', password: 'password-seguro-test' } });
    const lookupRes = await app.inject({
      method: 'POST',
      url: '/api/placa/consultar',
      headers: { cookie: login.cookies.map(c => `${c.name}=${c.value}`).join('; ') },
      payload: { placa: 'YAP-100' },
    });
    expect(lookupRes.statusCode).toBe(200);
    const data = JSON.parse(lookupRes.payload);
    expect(data.found).toBe(true);
    expect(data.name).toBe('Carlos Yapeador');
    expect(data.phone).toBe('987654321');
    expect(data.modelo).toBe('Toyota Corolla');
  });
});

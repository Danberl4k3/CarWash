import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
  });

  it('expone un endpoint de salud', async () => {
    const response = await app.inject({ method: 'GET', url: '/salud' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', service: 'DASAV Car Wash' });
  });

  it('reutiliza los datos locales de una placa sin consultar JSON.pe', async () => {
    db.prepare(`
      INSERT INTO vehicles (plate, vehicle_type, marca, modelo, color, anio, propietario)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('ABC-123', 'car', 'Toyota', 'Hilux', 'Blanco', 2020, 'Juan Pérez');

    const response = await app.inject({ method: 'GET', url: '/api/vehiculos/ABC123' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      success: true,
      source: 'local',
      data: { marca: 'Toyota', modelo: 'Hilux', color: 'Blanco', anio: 2020, propietario: 'Juan Pérez' },
    });
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
    expect(dashboard.body).toContain('5:00 p. m.');
  });

  it('refleja en el panel una reserva creada para hoy', async () => {
    const serviceId = (db.prepare('SELECT id FROM services WHERE slug = ?').get('exterior') as { id: number }).id;
    const now = getLimaNow();
    createBooking(db, {
      plate: 'TAB-001', vehicleType: 'car', baseServiceId: serviceId, addonServiceIds: [],
      dropoffHour: 7, pickupHour: 8, paymentMethod: 'cash', phone: '999999999', name: 'Panel test', notes: '',
    }, { now: { ...now, weekday: 'Mon' }, allowPastSlot: true });
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
    expect(dashboard.body).toContain('Panel test');
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { getBookingByCode, getDailyPaymentBreakdown } from '../src/domain/bookings.js';
import { getLimaNow } from '../src/time.js';

describe('pago al crear una reserva', () => {
  let db: Database.Database;
  let app: FastifyInstance;
  let cookie: string;
  let csrf: string;
  let baseServiceId: number;
  let waxId: number;
  const previousUsername = process.env.ADMIN_USERNAME;
  const previousPassword = process.env.ADMIN_PASSWORD;

  beforeEach(async () => {
    process.env.ADMIN_USERNAME = 'admin-payment';
    process.env.ADMIN_PASSWORD = 'payment-test-password';
    db = createDatabase(':memory:').db;
    app = await buildApp({ db, cookieSecret: 'initial-payment-test-cookie-secret-12345' });
    baseServiceId = (db.prepare("SELECT id FROM services WHERE slug = 'complete'").get() as { id: number }).id;
    waxId = (db.prepare("SELECT id FROM services WHERE slug = 'wax'").get() as { id: number }).id;
    const login = await app.inject({ method: 'POST', url: '/admin/login', payload: { username: 'admin-payment', password: 'payment-test-password' } });
    cookie = login.cookies.map((item) => `${item.name}=${item.value}`).join('; ');
    const page = await app.inject({ method: 'GET', url: '/', headers: { cookie } });
    const token = page.body.match(/name="_csrf" value="([^"]+)"/);
    if (!token) throw new Error('No se encontró el CSRF del formulario de recepción.');
    csrf = token[1];
  });

  afterEach(async () => {
    await app.close();
    db.close();
    if (previousUsername === undefined) delete process.env.ADMIN_USERNAME;
    else process.env.ADMIN_USERNAME = previousUsername;
    if (previousPassword === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = previousPassword;
  });

  function payload(paymentStatus?: string): Record<string, unknown> {
    return {
      _csrf: csrf, plate: 'PAY-123', vehicleType: 'car', baseServiceId,
      addonServiceIds: [waxId], dropoffHour: 10, pickupHour: 11,
      paymentMethod: 'cash', ...(paymentStatus === undefined ? {} : { paymentStatus }),
    };
  }

  it('ofrece la elección en Separa tu turno sin sesión y en los dos formularios del administrador', async () => {
    for (const url of ['/', '/admin/reservas/nueva']) {
      const response = await app.inject({ method: 'GET', url, headers: { cookie } });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('name="paymentStatus"');
      expect(response.body).toContain('No pagado');
      expect(response.body).toContain('Total cancelado');
    }
    const anonymous = await app.inject({ method: 'GET', url: '/' });
    expect(anonymous.body).toContain('name="paymentStatus"');
    expect(anonymous.body.indexOf('Método de pago')).toBeLessThan(anonymous.body.indexOf('Estado del pago'));
    expect(anonymous.body.indexOf('Estado del pago')).toBeLessThan(anonymous.body.indexOf('Confirmar reserva'));
    expect(anonymous.body).not.toContain('name="_csrf"');
  });

  it.each(['/admin/reservas', '/reservar'])('guarda el pago completo, incluidos adicionales, desde %s', async (url) => {
    const response = await app.inject({ method: 'POST', url, headers: { cookie }, payload: payload('paid') });
    expect(response.statusCode).toBe(302);
    const row = db.prepare('SELECT code, payment_status, amount_paid_cents, total_cents, created_by_admin FROM bookings').get() as {
      code: string; payment_status: string; amount_paid_cents: number; total_cents: number; created_by_admin: number;
    };
    expect(row).toMatchObject({ payment_status: 'paid', amount_paid_cents: 3000, total_cents: 3000, created_by_admin: 1 });
    const breakdown = getDailyPaymentBreakdown(db, getLimaNow().date);
    expect(breakdown.cashCents).toBe(3000);
    expect(breakdown.totalPendingCents).toBe(0);
    const confirmation = await app.inject({ method: 'GET', url: `/reserva/${row.code}` });
    expect(confirmation.body).toContain('Pagado <svg class="ui-icon');
    const status = await app.inject({ method: 'GET', url: `/api/reserva/${row.code}/status` });
    expect(status.json()).toMatchObject({ paymentStatus: 'paid', amountPaidCents: 3000 });
    const dashboard = await app.inject({ method: 'GET', url: '/admin', headers: { cookie } });
    expect(dashboard.body).toContain('data-payment-status="paid"');
  });

  it.each(['pending', undefined])('guarda cero cobrado cuando no pagó o no se envía el estado (%s)', async (paymentStatus) => {
    // Usar formbody también comprueba el envío normal de los formularios.
    const values = payload(paymentStatus);
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(values)) {
      if (Array.isArray(value)) for (const item of value) form.append(key, String(item));
      else form.append(key, String(value));
    }
    const response = await app.inject({ method: 'POST', url: '/admin/reservas', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: form.toString() });
    expect(response.statusCode).toBe(302);
    expect(db.prepare('SELECT payment_status, amount_paid_cents, total_cents FROM bookings').get()).toMatchObject({ payment_status: 'pending', amount_paid_cents: 0, total_cents: 3000 });
  });

  it('rechaza un estado inválido sin crear registros', async () => {
    const response = await app.inject({ method: 'POST', url: '/admin/reservas', headers: { cookie }, payload: payload('invalid') });
    expect(response.headers.location).toContain('error=');
    expect(db.prepare('SELECT COUNT(*) AS count FROM bookings').get()).toEqual({ count: 0 });
  });

  it.each(['cash', 'yape', 'plin'])('guarda Pagado desde Separa tu turno sin sesión, con %s', async (paymentMethod) => {
    const response = await app.inject({ method: 'POST', url: '/reservar', payload: { ...payload('paid'), paymentMethod, total: -999, amountPaid: -999, createdByAdmin: true } });
    expect(response.statusCode).toBe(302);
    const code = decodeURIComponent(String(response.headers.location).split('/').pop()!);
    expect(getBookingByCode(db, code)).toMatchObject({ payment_status: 'paid', amount_paid_cents: 3000, total_cents: 3000, created_by_admin: 0 });
    const confirmation = await app.inject({ method: 'GET', url: `/reserva/${code}` });
    expect(confirmation.body).toContain('Pagado <svg class="ui-icon');
    const status = await app.inject({ method: 'GET', url: `/api/reserva/${code}/status` });
    expect(status.json()).toMatchObject({ paymentStatus: 'paid', amountPaidCents: 3000 });
    const breakdown = getDailyPaymentBreakdown(db, getLimaNow().date);
    expect(breakdown.totalPendingCents).toBe(0);
    expect(breakdown.totalCollectedCents).toBe(3000);
  });

  it.each(['pending', undefined])('guarda No pagado desde Separa tu turno sin sesión (%s)', async paymentStatus => {
    const response = await app.inject({ method: 'POST', url: '/reservar', payload: payload(paymentStatus) });
    expect(response.headers.location).toMatch(/^\/reserva\//);
    expect(db.prepare('SELECT payment_status, amount_paid_cents, created_by_admin FROM bookings').get()).toMatchObject({ payment_status: 'pending', amount_paid_cents: 0, created_by_admin: 0 });
  });

  it('rechaza un estado de pago inválido desde Separa tu turno sin sesión', async () => {
    const response = await app.inject({ method: 'POST', url: '/reservar', payload: payload('invalid') });
    expect(response.headers.location).toContain('error=');
    expect(db.prepare('SELECT COUNT(*) AS count FROM bookings').get()).toEqual({ count: 0 });
  });

  it.each([undefined, 'invalid'])('rechaza registrar cobros en el formulario principal con CSRF ausente o inválido (%s)', async (_csrf) => {
    const values = payload('paid');
    if (_csrf === undefined) delete values._csrf;
    else values._csrf = _csrf;
    const response = await app.inject({ method: 'POST', url: '/reservar', headers: { cookie }, payload: values });
    expect(response.statusCode).toBe(403);
    expect(db.prepare('SELECT COUNT(*) AS count FROM bookings').get()).toEqual({ count: 0 });
  });
});

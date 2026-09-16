import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { buildApp } from '../src/app.js';
import { createDatabase, cleanupExpiredSessions, getServicesWithPrices } from '../src/db.js';
import { createBooking } from '../src/domain/bookings.js';

describe('Nuevas optimizaciones y funcionalidades (Puntos 2, 3, 4 y 5)', () => {
  let app: FastifyInstance;
  let db: Database.Database;
  const TEST_PASSWORD = 'password-seguro-test';

  beforeEach(async () => {
    process.env.ADMIN_USERNAME = 'admin';
    process.env.ADMIN_PASSWORD = TEST_PASSWORD;
    const ctx = createDatabase(':memory:');
    db = ctx.db;
    app = await buildApp({ db, cookieSecret: 'test-secret-123456789012345678901234' });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
    delete process.env.ADMIN_USERNAME;
    delete process.env.ADMIN_PASSWORD;
  });

  async function loginAsAdmin(): Promise<string> {
    const loginRes = await app.inject({
      method: 'POST',
      url: '/admin/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `username=admin&password=${encodeURIComponent(TEST_PASSWORD)}`,
    });
    const cookie = loginRes.cookies.find((c) => c.name === 'cw_admin_session');
    if (!cookie) throw new Error('Cookie de sesión admin no encontrada');
    return `cw_admin_session=${cookie.value}`;
  }

  describe('Punto 4: Rendimiento y Base de Datos', () => {
    it('verifica que los nuevos índices en claves foráneas existen en sqlite_master', () => {
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
        .all() as Array<{ name: string }>;
      const names = indexes.map((i) => i.name);

      expect(names).toContain('idx_vehicles_customer_id');
      expect(names).toContain('idx_bookings_vehicle_id');
      expect(names).toContain('idx_bookings_customer_id');
      expect(names).toContain('idx_service_prices_service_id');
    });

    it('ejecuta getServicesWithPrices en lote sin errores y devuelve precios por tipo de vehículo', () => {
      const services = getServicesWithPrices(db, true);
      expect(services.length).toBeGreaterThan(0);
      for (const service of services) {
        expect(service).toHaveProperty('prices');
        expect(service.prices).toHaveProperty('car');
        expect(service.prices).toHaveProperty('motorcycle');
      }
    });

    it('purga correctamente sesiones expiradas con cleanupExpiredSessions', () => {
      db.prepare(`
        INSERT INTO admin_sessions (token_hash, admin_id, csrf_token, expires_at)
        VALUES ('expired_hash_123', 1, 'csrf_old', datetime('now', '-1 hour'))
      `).run();

      const purged = cleanupExpiredSessions(db);
      expect(purged).toBeGreaterThanOrEqual(1);

      const check = db.prepare("SELECT 1 FROM admin_sessions WHERE token_hash = 'expired_hash_123'").get();
      expect(check).toBeUndefined();
    });
  });

  describe('Punto 3: Experiencia del Cliente (Portal de Reservas)', () => {
    it('permite autocompletar datos de vehículo por placa con /api/vehiculo-lookup', async () => {
      createBooking(db, {
        plate: 'XYZ-777',
        name: 'Carlos Mendoza',
        phone: '987654321',
        model: 'Corolla',
        vehicleType: 'car',
        baseServiceId: 2,
        addonServiceIds: [],
        dropoffHour: 9,
        dropoffMinute: 0,
        pickupHour: 10,
        pickupMinute: 0,
        paymentMethod: 'cash',
      });

      const lookupRes = await app.inject({
        method: 'GET',
        url: '/api/vehiculo-lookup?plate=XYZ-777',
      });

      expect(lookupRes.statusCode).toBe(200);
      const data = lookupRes.json();
      expect(data.found).toBe(true);
      expect(data.plate).toBe('XYZ-777');
      expect(data.name).toBe('Carlos Mendoza');
      expect(data.model).toBe('Corolla');
      expect(data.vehicleType).toBe('car');
    });

    it('retorna found: false para placas no registradas', async () => {
      const lookupRes = await app.inject({
        method: 'GET',
        url: '/api/vehiculo-lookup?plate=NUE-000',
      });

      expect(lookupRes.statusCode).toBe(200);
      const data = lookupRes.json();
      expect(data.found).toBe(false);
    });

    it('provee endpoint de estado en vivo para el Live Tracker en /api/reserva/:code/status', async () => {
      const created = createBooking(db, {
        plate: 'TRK-100',
        name: 'Ana Ramos',
        phone: '999888777',
        model: 'Tucson',
        vehicleType: 'small_suv',
        baseServiceId: 2,
        addonServiceIds: [],
        dropoffHour: 11,
        dropoffMinute: 0,
        pickupHour: 12,
        pickupMinute: 0,
        paymentMethod: 'yape',
      });

      const statusRes = await app.inject({
        method: 'GET',
        url: `/api/reserva/${created.code}/status`,
      });

      expect(statusRes.statusCode).toBe(200);
      const statusData = statusRes.json();
      expect(statusData.code).toBe(created.code);
      expect(statusData.status).toBe('pending');
      expect(statusData.statusLabel).toBe('Pendiente');
      expect(statusData.durationMinutes).toBe(45);
      expect(statusData.totalCents).toBeGreaterThan(0);
    });

    it('la página de confirmación incluye elementos del Live Tracker y PWA', async () => {
      const created = createBooking(db, {
        plate: 'PWA-999',
        name: 'Cliente PWA',
        phone: '911222333',
        model: 'Yaris',
        vehicleType: 'car',
        baseServiceId: 2,
        addonServiceIds: [],
        dropoffHour: 14,
        dropoffMinute: 0,
        pickupHour: 15,
        pickupMinute: 0,
        paymentMethod: 'plin',
      });

      const pageRes = await app.inject({
        method: 'GET',
        url: `/reserva/${created.code}`,
      });

      expect(pageRes.statusCode).toBe(200);
      expect(pageRes.body).toContain('tracker-stepper');
      expect(pageRes.body).toContain('tracker.js');
      expect(pageRes.body).toContain('manifest.json');
      expect(pageRes.body).toContain('Compartir reserva por WhatsApp');
    });
  });

  describe('Punto 2: Control de Pista y Operación Administrativa', () => {
    it('permite filtrar el panel administrativo por fecha específica y muestra el cierre de caja', async () => {
      const cookieHeader = await loginAsAdmin();

      createBooking(db, {
        plate: 'HOY-123',
        name: 'Cliente Hoy',
        phone: '955444333',
        model: 'RAV4',
        vehicleType: 'small_suv',
        baseServiceId: 2,
        addonServiceIds: [],
        dropoffHour: 8,
        dropoffMinute: 0,
        pickupHour: 9,
        pickupMinute: 0,
        paymentMethod: 'yape',
      });

      const res = await app.inject({
        method: 'GET',
        url: '/admin?date=2026-09-16',
        headers: { cookie: cookieHeader },
      });

      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('Cierre de caja');
      expect(res.body).toContain('Yape');
      expect(res.body).toContain('Plin');
      expect(res.body).toContain('Efectivo');
      expect(res.body).toContain('HOY-123');
      expect(res.body).toContain('Exportar CSV');
    });

    it('permite descargar el reporte en CSV con /admin/export-csv', async () => {
      const cookieHeader = await loginAsAdmin();

      createBooking(db, {
        plate: 'CSV-888',
        name: 'Maria Torres',
        phone: '944332211',
        model: 'Picanto',
        vehicleType: 'car',
        baseServiceId: 2,
        addonServiceIds: [],
        dropoffHour: 10,
        dropoffMinute: 0,
        pickupHour: 11,
        pickupMinute: 0,
        paymentMethod: 'cash',
      });

      const csvRes = await app.inject({
        method: 'GET',
        url: '/admin/export-csv?date=2026-09-16',
        headers: { cookie: cookieHeader },
      });

      expect(csvRes.statusCode).toBe(200);
      expect(csvRes.headers['content-type']).toContain('text/csv');
      expect(csvRes.headers['content-disposition']).toContain('carwash-reservas-2026-09-16.csv');
      expect(csvRes.body).toContain('Código,Fecha,Ingreso,Recojo,Placa');
      expect(csvRes.body).toContain('CSV-888');
      expect(csvRes.body).toContain('Maria Torres');
    });

    it('protege /admin/export-csv requiriendo autenticación', async () => {
      const csvRes = await app.inject({
        method: 'GET',
        url: '/admin/export-csv',
      });
      expect(csvRes.statusCode).toBe(302);
      expect(csvRes.headers.location).toBe('/admin/login');
    });
  });
});

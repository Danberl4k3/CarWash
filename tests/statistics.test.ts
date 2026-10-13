import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import { createBooking } from '../src/domain/bookings.js';
import { getStatisticsData } from '../src/domain/statistics.js';
import { getLimaNow } from '../src/time.js';

describe('Módulo de Estadísticas y Pronóstico', () => {
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

  describe('Cálculos del dominio (getStatisticsData)', () => {
    it('no falla con base vacía y devuelve métricas iniciales seguras', () => {
      const stats = getStatisticsData(db, { period: '7d' });
      expect(stats.totalBookings).toBe(0);
      expect(stats.totalRevenueCents).toBe(0);
      expect(stats.averageTicketCents).toBe(0);
      expect(stats.forecast.next7Days.length).toBe(7);
      expect(stats.hourlyDistribution.length).toBe(12); // 7 to 18
      expect(stats.dailyTrend.length).toBe(7);
    });

    it('calcula KPIs, horas pico y pronóstico con reservas registradas', () => {
      const now = getLimaNow();
      const services = db.prepare('SELECT id, name FROM services ORDER BY id').all() as Array<{ id: number; name: string }>;
      const baseService = services.find((s) => s.name.toLowerCase().includes('exterior') || s.name.toLowerCase().includes('completo')) ?? services[1];

      // Insertar reserva para hoy (Auto pagado S/ 30 con Yape)
      createBooking(db, {
        plate: 'ABC-123',
        vehicleType: 'car',
        baseServiceId: baseService.id,
        addonServiceIds: [],
        dropoffHour: 10,
        pickupHour: 11,
        dropoffMinute: 0,
        pickupMinute: 30,
        paymentMethod: 'yape',
        paymentStatus: 'paid',
        name: 'Carlos Perez',
        phone: '987654321',
        notes: '',
      }, { now });

      // Insertar reserva en proceso para hoy (SUV pagado S/ 40 en efectivo)
      const b2 = createBooking(db, {
        plate: 'SUV-999',
        vehicleType: 'large_suv',
        baseServiceId: baseService.id,
        addonServiceIds: [],
        dropoffHour: 10,
        pickupHour: 12,
        dropoffMinute: 15,
        pickupMinute: 0,
        paymentMethod: 'cash',
        paymentStatus: 'paid',
        name: 'Maria Lopez',
        phone: '912345678',
        notes: '',
      }, { now });

      // Actualizar a completado con timestamp de lavado
      db.prepare(`
        UPDATE bookings 
        SET status = 'completed', started_washing_at = ?, updated_at = ?
        WHERE id = ?
      `).run(
        new Date(Date.now() - 40 * 60 * 1000).toISOString(),
        new Date().toISOString(),
        b2.id
      );

      const stats = getStatisticsData(db, { period: '7d' });
      expect(stats.totalBookings).toBe(2);
      expect(stats.completedBookings).toBe(1);
      expect(stats.totalRevenueCents).toBeGreaterThan(0);
      expect(stats.averageWashTimeMinutes).toBeGreaterThan(0);

      // Horas pico en las 10:00
      const hour10 = stats.hourlyDistribution.find((h) => h.hour === 10);
      expect(hour10?.count).toBe(2);
      expect(hour10?.isPeak).toBe(true);

      // Métodos de pago
      const yape = stats.paymentMethods.find((p) => p.method === 'yape');
      const cash = stats.paymentMethods.find((p) => p.method === 'cash');
      expect(yape?.count).toBe(1);
      expect(cash?.count).toBe(1);

      // Pronóstico de 7 días
      expect(stats.forecast.next7Days.length).toBe(7);
      expect(stats.forecast.totalExpectedVehiclesWeek).toBeGreaterThan(0);
      expect(stats.forecast.projectedMonthEnd.projectedTotalRevenueCents).toBeGreaterThan(0);
    });
  });

  describe('Rutas HTTP administrativas (/admin/estadisticas)', () => {
    it('bloquea acceso no autenticado y redirige al login', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/admin/estadisticas',
      });
      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toContain('/admin/login');
    });

    it('bloquea API JSON sin autenticación', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/admin/api/estadisticas',
      });
      expect(response.statusCode).toBe(302);
    });

    it('renderiza la vista HTML completa con sesión administrativa válida', async () => {
      // Iniciar sesión
      const loginRes = await app.inject({
        method: 'POST',
        url: '/admin/login',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({
          username: 'admin-test',
          password: 'password-seguro-test',
        }).toString(),
      });
      const cookie = loginRes.headers['set-cookie'];

      const response = await app.inject({
        method: 'GET',
        url: '/admin/estadisticas',
        headers: { cookie: Array.isArray(cookie) ? cookie.join('; ') : cookie },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('Estadísticas y Pronóstico');
      expect(response.body).toContain('Pronóstico de Demanda para los Próximos 7 Días');
      expect(response.body).toContain('Evolución Diaria de Vehículos e Ingresos');
      expect(response.body).toContain('Carga por Hora en Pista');
      expect(response.body).toContain('Mix de Vehículos');
      expect(response.body).toContain('Métodos de Pago');
      expect(response.body).toContain('Servicios Más Solicitados');
      expect(response.body).toContain('7 días');
      expect(response.body).toContain('30 días');
      expect(response.body).toContain('Este mes');
    });

    it('responde JSON con los datos estructurados en /admin/api/estadisticas', async () => {
      const loginRes = await app.inject({
        method: 'POST',
        url: '/admin/login',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({
          username: 'admin-test',
          password: 'password-seguro-test',
        }).toString(),
      });
      const cookie = loginRes.headers['set-cookie'];

      const response = await app.inject({
        method: 'GET',
        url: '/admin/api/estadisticas?period=30d',
        headers: { cookie: Array.isArray(cookie) ? cookie.join('; ') : cookie },
      });

      expect(response.statusCode).toBe(200);
      const json = response.json();
      expect(json).toHaveProperty('totalBookings');
      expect(json).toHaveProperty('totalRevenueCents');
      expect(json).toHaveProperty('forecast');
      expect(json.forecast).toHaveProperty('next7Days');
      expect(json.period).toBe('30d');
    });
  });
});

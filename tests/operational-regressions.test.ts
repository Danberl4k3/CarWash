import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createDatabase } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { createBooking, getBooking, updateBookingByAdmin, checkAndAutoCompleteBookings } from '../src/domain/bookings.js';
import { appEvents } from '../src/events.js';
import { processPlateOcr } from '../src/services/plate-ocr.js';
import { consultarPlacaJsonPe } from '../src/services/json-pe.js';

describe('regresiones operativas verificadas', () => {
  let db: Database.Database;
  let app: FastifyInstance;
  let cookie: string;
  let csrf: string;
  let baseServiceId: number;
  beforeEach(async () => {
    process.env.ADMIN_USERNAME = 'regression-admin';
    process.env.ADMIN_PASSWORD = 'regression-password';
    db = createDatabase(':memory:').db;
    baseServiceId = (db.prepare("SELECT id FROM services WHERE slug = 'exterior'").get() as { id: number }).id;
    app = await buildApp({ db, cookieSecret: 'regression-secret-with-more-than-32-characters' });
    const login = await app.inject({ method: 'POST', url: '/admin/login', payload: { username: 'regression-admin', password: 'regression-password' } });
    cookie = login.cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const form = await app.inject({ method: 'GET', url: '/', headers: { cookie } });
    csrf = form.body.match(/name="_csrf" value="([^"]+)"/)![1];
  });
  afterEach(async () => {
    await app.close(); db.close();
    delete process.env.ADMIN_USERNAME; delete process.env.ADMIN_PASSWORD;
  });
  const input = () => ({ name: 'Ana Original', phone: '987654321', model: 'Toyota Yaris', plate: 'REG-123', vehicleType: 'car', baseServiceId, addonServiceIds: [], dropoffHour: 10, dropoffMinute: 37, pickupHour: 11, pickupMinute: 49, paymentMethod: 'cash' });
  const edit = () => ({ ...input(), status: 'pending', paymentStatus: 'pending', amountPaid: 0, total: 10, notes: '' });
  const post = (id: number, action: string, payload: object) => app.inject({ method: 'POST', url: `/admin/reservas/${id}/${action}`, headers: { cookie }, payload: { _csrf: csrf, ...payload } });

  it('conserva minutos al editar sin campos nuevos y permite cambiarlos explícitamente', () => {
    const { id } = createBooking(db, input());
    const { dropoffMinute, pickupMinute, ...legacyEdit } = edit();
    updateBookingByAdmin(db, id, legacyEdit);
    expect(getBooking(db, id)).toMatchObject({ dropoff_minute: 637, pickup_minute: 709 });
    updateBookingByAdmin(db, id, { ...edit(), dropoffMinute: 12, pickupMinute: 23 });
    expect(getBooking(db, id)).toMatchObject({ dropoff_minute: 612, pickup_minute: 683 });
  });
  it('iniciar desde edición crea temporizador y volver a pendiente lo limpia', () => {
    const { id } = createBooking(db, input());
    updateBookingByAdmin(db, id, { ...edit(), status: 'in_progress' });
    expect(Date.parse(getBooking(db, id)!.started_washing_at!)).toBeGreaterThan(Date.now() - 5000);
    updateBookingByAdmin(db, id, edit());
    expect(getBooking(db, id)!.started_washing_at).toBeNull();
  });
  it('cambiar estado conserva el abono e inicia temporizador', async () => {
    const { id } = createBooking(db, input());
    db.prepare('UPDATE bookings SET amount_paid_cents = 400 WHERE id = ?').run(id);
    expect((await post(id, 'estado', { status: 'in_progress', paymentStatus: 'pending' })).statusCode).toBe(302);
    expect(getBooking(db, id)).toMatchObject({ amount_paid_cents: 400, payment_status: 'pending', status: 'in_progress' });
    expect(getBooking(db, id)!.started_washing_at).toBeTruthy();
  });
  it('reabrir un lavado terminado reinicia tiempo y mantiene la fecha del panel', async () => {
    const { id } = createBooking(db, input(), { now: { date: '2026-10-01', hour: 10, minute: 0, weekday: 'Thu' } });
    db.prepare("UPDATE bookings SET status = 'completed', started_washing_at = ? WHERE id = ?").run(new Date(Date.now() - 3600000).toISOString(), id);
    const response = await post(id, 'quick-action', { action: 'prev_status' });
    expect(response.headers.location).toContain('date=2026-10-01');
    expect(Date.parse(getBooking(db, id)!.started_washing_at!)).toBeGreaterThan(Date.now() - 5000);
    checkAndAutoCompleteBookings(db);
    expect(getBooking(db, id)!.status).toBe('in_progress');
  });
  it('nuevas reservas y ediciones no cambian los datos del comprobante anterior', () => {
    const first = createBooking(db, input());
    const second = createBooking(db, { ...input(), name: 'Otra Persona', model: 'Otro Modelo', vehicleType: 'small_suv' }, { createdByAdmin: true });
    expect(getBooking(db, first.id)).toMatchObject({ customer_name: 'Ana Original', vehicle_model: 'Toyota Yaris', vehicle_type: 'car' });
    updateBookingByAdmin(db, second.id, { ...edit(), name: 'Nueva Persona', model: 'Nuevo Modelo', vehicleType: 'large_suv' });
    expect(getBooking(db, first.id)).toMatchObject({ customer_name: 'Ana Original', vehicle_model: 'Toyota Yaris', vehicle_type: 'car' });
    expect(getBooking(db, second.id)).toMatchObject({ customer_name: 'Nueva Persona', vehicle_type: 'large_suv' });
  });
  it('una reserva pública no sobrescribe el perfil registrado', () => {
    createBooking(db, input(), { createdByAdmin: true });
    const next = createBooking(db, { ...input(), name: 'Visitante', model: 'Otro', vehicleType: 'small_suv' });
    expect(db.prepare('SELECT name FROM customers WHERE phone = ?').get('987654321')).toMatchObject({ name: 'Ana Original' });
    expect(db.prepare('SELECT model, vehicle_type FROM vehicles WHERE plate = ?').get('REG-123')).toMatchObject({ model: 'Toyota Yaris', vehicle_type: 'car' });
    expect(getBooking(db, next.id)).toMatchObject({ customer_name: 'Visitante', vehicle_type: 'small_suv' });
  });
  it('editar notas después de cambiar precios conserva el precio histórico', () => {
    const { id } = createBooking(db, input());
    db.prepare("UPDATE service_prices SET price_cents = 9000 WHERE service_id = ? AND vehicle_type = 'car'").run(baseServiceId);
    updateBookingByAdmin(db, id, { ...edit(), notes: 'Nota adicional' });
    expect(db.prepare('SELECT price_cents FROM booking_services WHERE booking_id = ?').get(id)).toMatchObject({ price_cents: 1000 });
    expect(getBooking(db, id)!.total_cents).toBe(1000);
  });
  it.each(['GET', 'POST'])('consulta %s oculta nombre/teléfono al visitante y los ofrece al administrador', async method => {
    createBooking(db, input());
    const options = method === 'GET' ? { method: 'GET' as const, url: '/api/vehiculo-lookup?plate=REG-123' } : { method: 'POST' as const, url: '/api/placa/consultar', payload: { placa: 'REG-123' } };
    expect((await app.inject(options)).json()).toMatchObject({ found: true, name: null, phone: null });
    expect((await app.inject({ ...options, headers: { cookie } })).json()).toMatchObject({ name: 'Ana Original', phone: '987654321' });
  });
  it('CSV protege valores interpretados como fórmulas', async () => {
    createBooking(db, { ...input(), name: '=HYPERLINK("https://example.test")', model: '@SUM(1)' });
    const csv = await app.inject({ method: 'GET', url: '/admin/export-csv', headers: { cookie } });
    expect(csv.statusCode).toBe(200);
    expect(csv.body.toLowerCase()).toContain("'=hyperlink");
    expect(csv.body.toLowerCase()).toContain("'@sum");
  });
  it('cambiar contraseña revoca sesiones anteriores y conserva la nueva sesión', async () => {
    const second = await app.inject({ method: 'POST', url: '/admin/login', payload: { username: 'regression-admin', password: 'regression-password' } });
    const otherCookie = second.cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const changed = await app.inject({ method: 'POST', url: '/admin/seguridad', headers: { cookie }, payload: { _csrf: csrf, currentPassword: 'regression-password', newPassword: 'new-regression-password' } });
    expect(changed.headers.location).toContain('success=');
    for (const old of [cookie, otherCookie]) expect((await app.inject({ method: 'GET', url: '/admin', headers: { cookie: old } })).headers.location).toBe('/admin/login');
    const fresh = changed.cookies.map(c => `${c.name}=${c.value}`).join('; ');
    expect((await app.inject({ method: 'GET', url: '/admin', headers: { cookie: fresh } })).statusCode).toBe(200);
  });
  it('reiniciar conserva capacidad y servicios eliminados; migra historiales existentes', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'carwash-restart-')), 'test.db');
    let persistent = createDatabase(path).db;
    try {
      const created = createBooking(persistent, input());
      persistent.prepare('DELETE FROM booking_snapshots WHERE booking_id = ?').run(created.id);
      persistent.prepare("DELETE FROM service_prices WHERE service_id IN (SELECT id FROM services WHERE slug = 'wax')").run();
      persistent.prepare("DELETE FROM services WHERE slug = 'wax'").run();
      persistent.prepare('UPDATE capacity_slots SET max_slots = 1 WHERE hour = 10').run();
      persistent.close(); persistent = createDatabase(path).db;
      expect(persistent.prepare("SELECT id FROM services WHERE slug = 'wax'").get()).toBeUndefined();
      expect(persistent.prepare('SELECT max_slots FROM capacity_slots WHERE hour = 10').get()).toMatchObject({ max_slots: 1 });
      expect(getBooking(persistent, created.id)).toMatchObject({ customer_name: 'Ana Original' });
      expect(persistent.pragma('foreign_key_check')).toEqual([]);
    } finally { persistent.close(); }
  });
  it('backup y restauración recuperan el contenido incluso con WAL y conexión abierta', () => {
    const folder = mkdtempSync(join(tmpdir(), 'carwash-restore-'));
    const path = join(folder, 'test.db'); const backup = join(folder, 'snapshot.db');
    const persistent = createDatabase(path).db;
    const env = { ...process.env, DATABASE_PATH: path, DOTENV_CONFIG_PATH: join(folder, 'nonexistent.env') };
    try {
      const created = createBooking(persistent, input());
      const run = (script: string, args: string[]) => spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8', timeout: 15000 });
      const saved = run('scripts/backup.mjs', [backup]);
      expect(saved.status, saved.stderr).toBe(0);
      persistent.prepare('DELETE FROM bookings WHERE id = ?').run(created.id);
      expect(getBooking(persistent, created.id)).toBeUndefined();
      const restored = run('scripts/restore.mjs', [backup]);
      expect(restored.status, restored.stderr).toBe(0);
      expect(getBooking(persistent, created.id)).toMatchObject({ plate: 'REG-123' });
      expect(persistent.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    } finally { persistent.close(); }
  });
  it('SSE recibe eventos y libera oyentes al desconectarse', async () => {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const baseline = appEvents.listenerCount('app_event');
    for (let i = 0; i < 12; i++) {
      const controller = new AbortController();
      const response = await fetch(`${address}/admin/events`, { headers: { cookie }, signal: controller.signal });
      const reader = response.body!.getReader();
      const connected = await reader.read();
      expect(new TextDecoder().decode(connected.value)).toContain('event: connected');
      expect(appEvents.listenerCount('app_event')).toBe(baseline + 1);
      appEvents.emitAppEvent('booking_updated', { id: 123 });
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('booking_updated');
      controller.abort(); await reader.cancel().catch(() => {});
      for (let n = 0; n < 50 && appEvents.listenerCount('app_event') !== baseline; n++) await new Promise(r => setTimeout(r, 10));
      expect(appEvents.listenerCount('app_event')).toBe(baseline);
    }
    const response = await fetch(`${address}/admin/events`, { headers: { cookie } });
    const reader = response.body!.getReader();
    await reader.read();
    db.prepare('DELETE FROM admin_sessions').run();
    appEvents.emitAppEvent('booking_updated', { id: 456 });
    expect((await reader.read()).done).toBe(true);
    expect(appEvents.listenerCount('app_event')).toBe(baseline);
  });
  it('rechaza JSON malformado con 400 y conserva el código de error', async () => {
    const invalid = await app.inject({ method: 'POST', url: '/api/placa/consultar', headers: { 'content-type': 'application/json' }, payload: '{bad-json' });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toHaveProperty('error');
  });
  it('una reserva desde sesión administrativa exige CSRF aunque se omita el pago', async () => {
    const response = await app.inject({ method: 'POST', url: '/reservar', headers: { cookie }, payload: input() });
    expect(response.statusCode).toBe(403);
    expect(db.prepare('SELECT id FROM bookings').get()).toBeUndefined();
  });
  it('limita reservas con 429 sin permitir evasión por X-Forwarded-For', async () => {
    const previous = process.env.TRUST_PROXY;
    process.env.TRUST_PROXY = 'false';
    const isolated = await buildApp({ db, cookieSecret: 'rate-limit-regression-cookie-secret-1234' });
    if (previous === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = previous;
    try {
      for (let i = 0; i < 10; i++) {
        const response = await isolated.inject({ method: 'POST', url: '/reservar', headers: { 'x-forwarded-for': `203.0.113.${i}` }, payload: input() });
        expect(response.statusCode).toBe(302);
        expect(response.headers.location).toMatch(/^\/reserva\//);
      }
      const limited = await isolated.inject({ method: 'POST', url: '/reservar', headers: { 'x-forwarded-for': '203.0.113.100' }, payload: input() });
      expect(limited.statusCode).toBe(429);
    } finally { await isolated.close(); }
  });
  it('rechaza un backup inválido y el origen igual al destino sin alterar la base', () => {
    const folder = mkdtempSync(join(tmpdir(), 'carwash-invalid-restore-'));
    const path = join(folder, 'test.db'); const bad = join(folder, 'invalid.db');
    const persistent = createDatabase(path).db;
    try {
      const created = createBooking(persistent, input());
      writeFileSync(bad, 'not a SQLite database');
      for (const source of [bad, path]) {
        const result = spawnSync(process.execPath, ['scripts/restore.mjs', source], { env: { ...process.env, DATABASE_PATH: path, DOTENV_CONFIG_PATH: join(folder, 'nonexistent.env') }, encoding: 'utf8', timeout: 15000 });
        expect(result.status).not.toBe(0);
        expect(getBooking(persistent, created.id)).toMatchObject({ plate: 'REG-123' });
      }
    } finally { persistent.close(); }
  });
  it('la migración de horas antiguas conserva reservas, snapshots, servicios e índices', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'carwash-legacy-')), 'test.db');
    let persistent = createDatabase(path).db;
    try {
      const { id } = createBooking(persistent, input());
      const sql = (persistent.prepare("SELECT sql FROM sqlite_master WHERE name = 'bookings' AND type = 'table'").get() as { sql: string }).sql;
      const legacySql = sql.replace('CREATE TABLE bookings', 'CREATE TABLE bookings_legacy').replaceAll('BETWEEN 0 AND 23', 'BETWEEN 7 AND 17');
      persistent.pragma('foreign_keys = OFF');
      persistent.exec(`${legacySql}; INSERT INTO bookings_legacy SELECT * FROM bookings; DROP TABLE bookings; ALTER TABLE bookings_legacy RENAME TO bookings;`);
      persistent.pragma('foreign_keys = ON');
      persistent.close(); persistent = createDatabase(path).db;
      expect(getBooking(persistent, id)).toMatchObject({ plate: 'REG-123', customer_name: 'Ana Original', dropoff_minute: 637 });
      expect(persistent.prepare('SELECT price_cents FROM booking_services WHERE booking_id = ?').get(id)).toMatchObject({ price_cents: 1000 });
      const indexes = persistent.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[];
      expect(indexes.map(x => x.name)).toEqual(expect.arrayContaining(['idx_bookings_vehicle_id', 'idx_bookings_customer_id']));
      expect(persistent.pragma('foreign_key_check')).toEqual([]);
      createBooking(persistent, { ...input(), dropoffHour: 22, pickupHour: 23 });
    } finally { persistent.close(); }
  });
  it('migrar pickup antiguo conserva precio y usa SUV grande en temporizador y formularios', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'carwash-pickup-')), 'test.db');
    let persistent = createDatabase(path).db;
    try {
      const { id } = createBooking(persistent, input());
      persistent.prepare("UPDATE vehicles SET vehicle_type = 'pickup' WHERE plate = 'REG-123'").run();
      persistent.prepare("UPDATE booking_snapshots SET vehicle_type = 'pickup' WHERE booking_id = ?").run(id);
      persistent.prepare("UPDATE bookings SET status = 'in_progress', started_washing_at = ? WHERE id = ?").run(new Date(Date.now() - 35 * 60000).toISOString(), id);
      persistent.close(); persistent = createDatabase(path).db;
      expect(getBooking(persistent, id)).toMatchObject({ vehicle_type: 'large_suv', total_cents: 1000 });
      checkAndAutoCompleteBookings(persistent);
      expect(getBooking(persistent, id)!.status).toBe('in_progress');
    } finally { persistent.close(); }
  });
  it('producción no presenta consultas ni OCR simulados como datos reales', async () => {
    const names = ['NODE_ENV', 'GEMINI_API_KEY', 'JSON_PE_TOKEN', 'JSON_PE_API_KEY'] as const;
    const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
    process.env.NODE_ENV = 'production';
    for (const name of names.slice(1)) delete process.env[name];
    try {
      const vehicle = await consultarPlacaJsonPe('SUV-001');
      expect(vehicle.found).toBe(false);
      expect(vehicle.source).not.toBe('mock');
      expect((await processPlateOcr('SIMULATE_CLEAR_IMAGE_ABC-123')).legible).toBe(false);
    } finally {
      for (const name of names) if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
    }
  });
});

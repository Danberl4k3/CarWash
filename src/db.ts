import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { VEHICLE_TYPES, type VehicleType } from './constants.js';
import { dropoffHours } from './time.js';

export interface DatabaseContext {
  db: Database.Database;
  bootstrapPassword: string | null;
  path: string;
}

const schema = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,
  admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('base', 'addon')),
  incompatible_with_interior INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS service_prices (
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  vehicle_type TEXT NOT NULL CHECK (vehicle_type IN ('motorcycle', 'car', 'small_suv', 'large_suv', 'pickup')),
  price_cents INTEGER NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  PRIMARY KEY (service_id, vehicle_type)
);

CREATE TABLE IF NOT EXISTS capacity_slots (
  hour INTEGER PRIMARY KEY CHECK (hour BETWEEN 7 AND 17),
  max_slots INTEGER NOT NULL DEFAULT 6 CHECK (max_slots BETWEEN 1 AND 50)
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  phone TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS vehicles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plate TEXT NOT NULL UNIQUE,
  vehicle_type TEXT NOT NULL CHECK (vehicle_type IN ('motorcycle', 'car', 'small_suv', 'large_suv', 'pickup')),
  model TEXT,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  booking_date TEXT NOT NULL,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
  dropoff_hour INTEGER NOT NULL CHECK (dropoff_hour BETWEEN 0 AND 23),
  pickup_hour INTEGER NOT NULL CHECK (pickup_hour BETWEEN 0 AND 23),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'in_progress', 'completed', 'cancelled')),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('yape', 'plin', 'cash')),
  payment_status TEXT NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending', 'paid')),
  amount_paid_cents INTEGER NOT NULL DEFAULT 0 CHECK (amount_paid_cents >= 0),
  total_cents INTEGER NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  notes TEXT,
  started_washing_at TEXT,
  created_by_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS booking_services (
  booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  service_id INTEGER REFERENCES services(id) ON DELETE SET NULL,
  service_name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('base', 'addon')),
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  PRIMARY KEY (booking_id, service_name)
);

CREATE INDEX IF NOT EXISTS idx_bookings_date_dropoff ON bookings(booking_date, dropoff_hour);
CREATE INDEX IF NOT EXISTS idx_bookings_date_pickup ON bookings(booking_date, pickup_hour);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
CREATE INDEX IF NOT EXISTS idx_vehicles_customer_id ON vehicles(customer_id);
CREATE INDEX IF NOT EXISTS idx_bookings_vehicle_id ON bookings(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_bookings_customer_id ON bookings(customer_id);
CREATE INDEX IF NOT EXISTS idx_service_prices_service_id ON service_prices(service_id);
`;

const defaultServices = [
  ['motorcycle-wash', 'Lavado simple', 'base', 0, 5],
  ['interior', 'Lavado interior', 'base', 0, 10],
  ['exterior', 'Lavado exterior', 'base', 0, 20],
  ['complete', 'Lavado completo', 'base', 0, 30],
  ['engine', 'Lavado de motor', 'addon', 0, 40],
  ['leather', 'Crema para cuero', 'addon', 0, 50],
  ['wax', 'Cera', 'addon', 1, 60],
] as const;

const defaultPrices: Record<string, Partial<Record<VehicleType, number>>> = {
  'motorcycle-wash': { motorcycle: 1500 },
  interior: { car: 1000, small_suv: 1500, large_suv: 2000 },
  exterior: { car: 1000, small_suv: 1500, large_suv: 2000 },
  complete: { car: 2000, small_suv: 3000, large_suv: 4000 },
  engine: { car: 1500, small_suv: 1500, large_suv: 1500 },
  leather: { car: 1500, small_suv: 1500, large_suv: 1500 },
  wax: { car: 1000, small_suv: 1000, large_suv: 1000 },
};

export function createDatabase(databasePath?: string): DatabaseContext {
  let target = databasePath ?? process.env.DATABASE_PATH;
  if (!target) {
    if (process.env.RAILWAY_VOLUME_MOUNT_PATH) {
      target = `${process.env.RAILWAY_VOLUME_MOUNT_PATH}/carwash.db`;
    } else {
      target = './data/carwash.db';
    }
  }
  const isMemory = target === ':memory:';
  const resolvedPath = isMemory ? target : resolve(target);
  if (!isMemory) mkdirSync(dirname(resolvedPath), { recursive: true });
  const db = new Database(resolvedPath);
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  // Minute precision was added after the original hourly schema. Keep hourly
  // columns for compatibility and backfill the new values for old bookings.
  for (const statement of [
    'ALTER TABLE bookings ADD COLUMN dropoff_minute INTEGER',
    'ALTER TABLE bookings ADD COLUMN pickup_minute INTEGER',
    'ALTER TABLE vehicles ADD COLUMN model TEXT',
    'ALTER TABLE bookings ADD COLUMN started_washing_at TEXT',
  ]) {
    try { db.exec(statement); } catch { /* column already exists */ }
  }
  const bookingsSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='bookings'").get() as { sql: string } | undefined)?.sql;
  if (bookingsSql && (bookingsSql.includes('BETWEEN 8 AND 18') || bookingsSql.includes('BETWEEN 7 AND 17'))) {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN TRANSACTION;
      CREATE TABLE bookings_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL UNIQUE,
        booking_date TEXT NOT NULL,
        customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
        vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
        dropoff_hour INTEGER NOT NULL CHECK (dropoff_hour BETWEEN 0 AND 23),
        pickup_hour INTEGER NOT NULL CHECK (pickup_hour BETWEEN 0 AND 23),
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'in_progress', 'completed', 'cancelled')),
        payment_method TEXT NOT NULL CHECK (payment_method IN ('yape', 'plin', 'cash')),
        payment_status TEXT NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending', 'paid')),
        amount_paid_cents INTEGER NOT NULL DEFAULT 0 CHECK (amount_paid_cents >= 0),
        total_cents INTEGER NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
        notes TEXT,
        started_washing_at TEXT,
        created_by_admin INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        dropoff_minute INTEGER,
        pickup_minute INTEGER
      );
      INSERT INTO bookings_new (id, code, booking_date, customer_id, vehicle_id, dropoff_hour, pickup_hour, status, payment_method, payment_status, amount_paid_cents, total_cents, notes, started_washing_at, created_by_admin, created_at, updated_at, dropoff_minute, pickup_minute)
        SELECT id, code, booking_date, customer_id, vehicle_id, dropoff_hour, pickup_hour, status, payment_method, payment_status, amount_paid_cents, total_cents, notes, started_washing_at, created_by_admin, created_at, updated_at, dropoff_minute, pickup_minute FROM bookings;
      DROP TABLE bookings;
      ALTER TABLE bookings_new RENAME TO bookings;
      CREATE INDEX IF NOT EXISTS idx_bookings_date_dropoff ON bookings(booking_date, dropoff_hour);
      CREATE INDEX IF NOT EXISTS idx_bookings_date_pickup ON bookings(booking_date, pickup_hour);
      CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
  }

  db.exec(`
    UPDATE bookings SET dropoff_minute = dropoff_hour * 60 WHERE dropoff_minute IS NULL;
    UPDATE bookings SET pickup_minute = pickup_hour * 60 WHERE pickup_minute IS NULL;
    UPDATE capacity_slots SET max_slots = 6 WHERE max_slots = 1;
  `);

  const insertService = db.prepare(`
    INSERT OR IGNORE INTO services
      (slug, name, category, incompatible_with_interior, sort_order)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertPrice = db.prepare(`
    INSERT OR IGNORE INTO service_prices (service_id, vehicle_type, price_cents)
    VALUES (?, ?, ?)
  `);
  const seedServices = db.transaction(() => {
    for (const item of defaultServices) {
      insertService.run(...item);
      const row = db.prepare('SELECT id FROM services WHERE slug = ?').get(item[0]) as { id: number };
      for (const vehicleType of VEHICLE_TYPES) insertPrice.run(row.id, vehicleType, defaultPrices[item[0]]?.[vehicleType] ?? 0);
    }
    const insertCapacity = db.prepare('INSERT OR IGNORE INTO capacity_slots (hour, max_slots) VALUES (?, 6)');
    for (const hour of dropoffHours()) insertCapacity.run(hour);
  });
  seedServices();

  const adminCount = (db.prepare('SELECT COUNT(*) AS count FROM admins').get() as { count: number }).count;
  let bootstrapPassword: string | null = null;
  if (adminCount === 0) {
    const username = process.env.ADMIN_USERNAME?.trim() || 'admin';
    bootstrapPassword = process.env.ADMIN_PASSWORD?.trim() || randomBytes(9).toString('base64url');
    const passwordHash = bcrypt.hashSync(bootstrapPassword, 12);
    db.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)').run(username, passwordHash);
  }

  db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').run(new Date().toISOString());
  return { db, bootstrapPassword, path: resolvedPath };
}

export interface ServiceRow {
  id: number;
  slug: string;
  name: string;
  category: 'base' | 'addon';
  incompatible_with_interior: number;
  active: number;
  sort_order: number;
}

export interface ServiceWithPrices extends ServiceRow {
  prices: Record<VehicleType, number>;
}

export function getServicesWithPrices(db: Database.Database, onlyActive = false): ServiceWithPrices[] {
  const services = db
    .prepare(`SELECT * FROM services ${onlyActive ? 'WHERE active = 1' : ''} ORDER BY sort_order, id`)
    .all() as ServiceRow[];
  const allPrices = db
    .prepare('SELECT service_id, vehicle_type, price_cents FROM service_prices')
    .all() as Array<{ service_id: number; vehicle_type: VehicleType; price_cents: number }>;
  const priceMap = new Map<number, Record<VehicleType, number>>();
  for (const row of allPrices) {
    let entry = priceMap.get(row.service_id);
    if (!entry) {
      entry = {} as Record<VehicleType, number>;
      priceMap.set(row.service_id, entry);
    }
    entry[row.vehicle_type] = row.price_cents;
  }
  return services.map((service) => ({
    ...service,
    prices: priceMap.get(service.id) ?? ({} as Record<VehicleType, number>),
  }));
}

export function cleanupExpiredSessions(db: Database.Database): number {
  const result = db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').run(new Date().toISOString());
  return result.changes;
}

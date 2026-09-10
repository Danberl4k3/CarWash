import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DEFAULT_CAPACITY_PER_HOUR, VEHICLE_TYPES, type VehicleType } from './constants.js';
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
  max_slots INTEGER NOT NULL DEFAULT 10 CHECK (max_slots BETWEEN 1 AND 10)
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
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  marca TEXT,
  modelo TEXT,
  color TEXT,
  anio INTEGER,
  propietario TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  booking_date TEXT NOT NULL,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
  dropoff_hour INTEGER NOT NULL CHECK (dropoff_hour BETWEEN 7 AND 17),
  pickup_hour INTEGER NOT NULL CHECK (pickup_hour BETWEEN 8 AND 18),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'in_progress', 'completed', 'cancelled')),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('yape', 'plin', 'cash')),
  payment_status TEXT NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending', 'paid')),
  amount_paid_cents INTEGER NOT NULL DEFAULT 0 CHECK (amount_paid_cents >= 0),
  total_cents INTEGER NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  notes TEXT,
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
`;

const defaultServices = [
  ['motorcycle-wash', 'Lavado de moto', 'base', 0, 5],
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
  const target = databasePath ?? process.env.DATABASE_PATH ?? './data/carwash.db';
  const isMemory = target === ':memory:';
  const resolvedPath = isMemory ? target : resolve(target);
  if (!isMemory) mkdirSync(dirname(resolvedPath), { recursive: true });
  const db = new Database(resolvedPath);
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(schema);
  const vehicleColumns = db.prepare('PRAGMA table_info(vehicles)').all() as Array<{ name: string }>;
  const existingVehicleColumns = new Set(vehicleColumns.map((column) => column.name));
  for (const [name, definition] of [['marca', 'TEXT'], ['modelo', 'TEXT'], ['color', 'TEXT'], ['anio', 'INTEGER'], ['propietario', 'TEXT']] as const) {
    if (!existingVehicleColumns.has(name)) db.exec(`ALTER TABLE vehicles ADD COLUMN ${name} ${definition}`);
  }
  // Minute precision was added after the original hourly schema. Keep hourly
  // columns for compatibility and backfill the new values for old bookings.
  for (const statement of [
    'ALTER TABLE bookings ADD COLUMN dropoff_minute INTEGER',
    'ALTER TABLE bookings ADD COLUMN pickup_minute INTEGER',
  ]) {
    try { db.exec(statement); } catch { /* column already exists */ }
  }
  db.exec('UPDATE bookings SET dropoff_minute = dropoff_hour * 60 WHERE dropoff_minute IS NULL; UPDATE bookings SET pickup_minute = pickup_hour * 60 WHERE pickup_minute IS NULL;');

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
    const insertCapacity = db.prepare('INSERT OR IGNORE INTO capacity_slots (hour, max_slots) VALUES (?, ?)');
    for (const hour of dropoffHours()) insertCapacity.run(hour, DEFAULT_CAPACITY_PER_HOUR);
  });
  seedServices();
  db.prepare('UPDATE capacity_slots SET max_slots = ? WHERE max_slots = 1').run(DEFAULT_CAPACITY_PER_HOUR);

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

export interface VehicleLookupRow {
  plate: string;
  vehicle_type: string;
  marca: string | null;
  modelo: string | null;
  color: string | null;
  anio: number | null;
  propietario: string | null;
}

export function getVehicleByPlate(db: Database.Database, plate: string): VehicleLookupRow | undefined {
  const normalized = plate.replace(/[\s-]/g, '').toUpperCase();
  return db.prepare(`
    SELECT plate, vehicle_type, marca, modelo, color, anio, propietario
    FROM vehicles
    WHERE REPLACE(REPLACE(UPPER(plate), '-', ''), ' ', '') = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(normalized) as VehicleLookupRow | undefined;
}

export function getServicesWithPrices(db: Database.Database, onlyActive = false): ServiceWithPrices[] {
  const services = db
    .prepare(`SELECT * FROM services ${onlyActive ? 'WHERE active = 1' : ''} ORDER BY sort_order, id`)
    .all() as ServiceRow[];
  const priceStatement = db.prepare('SELECT vehicle_type, price_cents FROM service_prices WHERE service_id = ?');
  return services.map((service) => {
    const prices = Object.fromEntries(
      (priceStatement.all(service.id) as Array<{ vehicle_type: VehicleType; price_cents: number }>).map((row) => [
        row.vehicle_type,
        row.price_cents,
      ]),
    ) as Record<VehicleType, number>;
    return { ...service, prices };
  });
}

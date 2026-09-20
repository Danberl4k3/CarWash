import type Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  BOOKING_STATUSES,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  VEHICLE_TYPES,
  type BookingStatus,
  type PaymentMethod,
  type PaymentStatus,
  type VehicleType,
} from '../constants.js';
import { getServicesWithPrices, type ServiceWithPrices } from '../db.js';
import { getLimaNow, toMinutes, type LimaNow } from '../time.js';

function capitalizeWords(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

const optionalText = z
  .string()
  .trim()
  .max(200)
  .optional()
  .transform((value) => value || null);

export const bookingSchema = z.object({
  name: optionalText.transform((value) => capitalizeWords(value)),
  model: optionalText.transform((value) => capitalizeWords(value)),
  phone: z
    .string()
    .trim()
    .max(20)
    .optional()
    .transform((value) => value || null),
  plate: z
    .string()
    .trim()
    .min(3, 'Ingresa una placa válida.')
    .max(12, 'La placa es demasiado larga.')
    .regex(/^[A-Za-z0-9-]+$/, 'La placa solo puede contener letras, números y guiones.')
    .transform((value) => value.toUpperCase()),
  vehicleType: z.enum(VEHICLE_TYPES, { message: 'Selecciona un tipo de vehículo.' }),
  baseServiceId: z.coerce.number().int().positive('Selecciona un servicio.'),
  addonServiceIds: z.array(z.coerce.number().int().positive()).default([]),
  dropoffHour: z.coerce.number().int().min(0).max(23),
  pickupHour: z.coerce.number().int().min(0).max(23).default(0),
  dropoffMinute: z.coerce.number().int().min(0).max(59).default(0),
  pickupMinute: z.coerce.number().int().min(0).max(59).default(0),
  paymentMethod: z.enum(PAYMENT_METHODS, { message: 'Selecciona un método de pago.' }),
  notes: z
    .string()
    .trim()
    .max(1000)
    .optional()
    .transform((value) => value || null),
});

export interface BookingInput {
  name: string | null;
  model?: string | null;
  phone: string | null;
  plate: string;
  vehicleType: VehicleType;
  baseServiceId: number;
  addonServiceIds: number[];
  dropoffHour: number;
  pickupHour: number;
  dropoffMinute: number;
  pickupMinute: number;
  paymentMethod: PaymentMethod;
  notes: string | null;
}

export interface CreateBookingOptions {
  now?: LimaNow;
  createdByAdmin?: boolean;
  allowPastSlot?: boolean;
}

export class BookingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BookingValidationError';
  }
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)];
}

function selectedServices(
  services: ServiceWithPrices[],
  input: BookingInput,
): { base: ServiceWithPrices; addons: ServiceWithPrices[] } {
  const base = services.find((service) => service.id === input.baseServiceId && service.category === 'base');
  if (!base) throw new BookingValidationError('El servicio principal no está disponible.');
  if (input.vehicleType === 'motorcycle' && base.slug !== 'motorcycle-wash') {
    throw new BookingValidationError('Para motos solo está disponible el lavado simple.');
  }
  if (input.vehicleType !== 'motorcycle' && base.slug === 'motorcycle-wash') {
    throw new BookingValidationError('El lavado para motos solo corresponde a motos.');
  }
  if (input.vehicleType === 'motorcycle' && input.addonServiceIds.length > 0) {
    throw new BookingValidationError('Para motos no hay servicios adicionales disponibles.');
  }
  const addonIds = uniqueNumbers(input.addonServiceIds);
  const addons = addonIds.map((id) => services.find((service) => service.id === id && service.category === 'addon'));
  if (addons.some((service) => !service)) {
    throw new BookingValidationError('Uno de los adicionales no está disponible.');
  }
  const resolvedAddons = addons as ServiceWithPrices[];
  if (base.slug === 'interior' && resolvedAddons.some((service) => service.incompatible_with_interior)) {
    throw new BookingValidationError('La cera no está disponible con el lavado interior.');
  }
  return { base, addons: resolvedAddons };
}

export function validateBookingRules(input: BookingInput, _now: LimaNow, _allowPastSlot = false): void {
  if (input.phone && !/^\+?[0-9 ()-]{7,20}$/.test(input.phone)) {
    throw new BookingValidationError('Ingresa un teléfono válido.');
  }
}

function createCode(db: Database.Database, date: string): string {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const suffix = randomBytes(3).toString('hex').toUpperCase();
    const code = `DASAV-${date.replaceAll('-', '')}-${suffix}`;
    const exists = db.prepare('SELECT 1 FROM bookings WHERE code = ?').get(code);
    if (!exists) return code;
  }
  throw new Error('No se pudo generar un código de reserva único.');
}

export function createBooking(
  db: Database.Database,
  rawInput: unknown,
  options: CreateBookingOptions = {},
): { id: number; code: string; totalCents: number } {
  const parsed = bookingSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new BookingValidationError(parsed.error.issues[0]?.message ?? 'Revisa los datos de la reserva.');
  }
  const input = parsed.data as BookingInput;
  const now = options.now ?? getLimaNow();
  validateBookingRules(input, now, options.allowPastSlot ?? false);

  const services = getServicesWithPrices(db, true);
  const selection = selectedServices(services, input);
  const allSelected = [selection.base, ...selection.addons];
  const totalCents = allSelected.reduce(
    (total, service) => total + (service.prices[input.vehicleType] ?? 0),
    0,
  );
  const transaction = db.transaction(() => {
    let vehicle = db.prepare('SELECT id, customer_id FROM vehicles WHERE plate = ?').get(input.plate) as
      | { id: number; customer_id: number | null }
      | undefined;
    let customerId = vehicle?.customer_id ?? null;

    if (customerId) {
      db.prepare(`
        UPDATE customers
        SET name = COALESCE(?, name), phone = COALESCE(?, phone), updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(input.name, input.phone, customerId);
    } else {
      const customerResult = db
        .prepare('INSERT INTO customers (name, phone) VALUES (?, ?)')
        .run(input.name, input.phone);
      customerId = Number(customerResult.lastInsertRowid);
    }

    if (vehicle) {
      db.prepare(`
        UPDATE vehicles SET vehicle_type = ?, model = COALESCE(?, model), customer_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(input.vehicleType, input.model ?? null, customerId, vehicle.id);
    } else {
      const vehicleResult = db
        .prepare('INSERT INTO vehicles (plate, vehicle_type, model, customer_id) VALUES (?, ?, ?, ?)')
        .run(input.plate, input.vehicleType, input.model ?? null, customerId);
      vehicle = { id: Number(vehicleResult.lastInsertRowid), customer_id: customerId };
    }

    const code = createCode(db, now.date);
    const bookingResult = db.prepare(`
      INSERT INTO bookings (
        code, booking_date, customer_id, vehicle_id, dropoff_hour, pickup_hour, dropoff_minute, pickup_minute,
        payment_method, total_cents, notes, created_by_admin
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      code,
      now.date,
      customerId,
      vehicle.id,
      input.dropoffHour,
      input.pickupHour,
      toMinutes(input.dropoffHour, input.dropoffMinute),
      toMinutes(input.pickupHour, input.pickupMinute),
      input.paymentMethod,
      totalCents,
      input.notes,
      options.createdByAdmin ? 1 : 0,
    );
    const bookingId = Number(bookingResult.lastInsertRowid);
    const insertBookingService = db.prepare(`
      INSERT INTO booking_services (booking_id, service_id, service_name, category, price_cents)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const service of allSelected) {
      insertBookingService.run(
        bookingId,
        service.id,
        service.name,
        service.category,
        service.prices[input.vehicleType] ?? 0,
      );
    }
    return { id: bookingId, code, totalCents };
  });
  return transaction();
}

export interface BookingDetailRow {
  id: number;
  code: string;
  booking_date: string;
  customer_id: number | null;
  customer_name: string | null;
  phone: string | null;
  vehicle_id: number;
  plate: string;
  vehicle_type: VehicleType;
  vehicle_model: string | null;
  dropoff_hour: number;
  pickup_hour: number;
  dropoff_minute: number | null;
  pickup_minute: number | null;
  status: BookingStatus;
  payment_method: PaymentMethod;
  payment_status: PaymentStatus;
  amount_paid_cents: number;
  total_cents: number;
  notes: string | null;
  started_washing_at: string | null;
  created_by_admin: number;
  created_at: string;
  updated_at: string;
  services: string;
}

export function getBooking(db: Database.Database, id: number): BookingDetailRow | undefined {
  return db.prepare(`
    SELECT b.*, c.name AS customer_name, c.phone, v.plate, v.vehicle_type, v.model AS vehicle_model,
      GROUP_CONCAT(bs.service_name, ' · ') AS services
    FROM bookings b
    JOIN vehicles v ON v.id = b.vehicle_id
    LEFT JOIN customers c ON c.id = b.customer_id
    LEFT JOIN booking_services bs ON bs.booking_id = b.id
    WHERE b.id = ?
    GROUP BY b.id
  `).get(id) as BookingDetailRow | undefined;
}

export function getBookingByCode(db: Database.Database, code: string): BookingDetailRow | undefined {
  return db.prepare(`
    SELECT b.*, c.name AS customer_name, c.phone, v.plate, v.vehicle_type, v.model AS vehicle_model,
      GROUP_CONCAT(bs.service_name, ' · ') AS services
    FROM bookings b
    JOIN vehicles v ON v.id = b.vehicle_id
    LEFT JOIN customers c ON c.id = b.customer_id
    LEFT JOIN booking_services bs ON bs.booking_id = b.id
    WHERE b.code = ?
    GROUP BY b.id
  `).get(code) as BookingDetailRow | undefined;
}

export function getBookingServiceIds(
  db: Database.Database,
  bookingId: number,
): { baseServiceId: number | null; addonServiceIds: number[] } {
  const rows = db.prepare(`
    SELECT service_id, category FROM booking_services WHERE booking_id = ? ORDER BY category, service_name
  `).all(bookingId) as Array<{ service_id: number | null; category: 'base' | 'addon' }>;
  return {
    baseServiceId: rows.find((row) => row.category === 'base')?.service_id ?? null,
    addonServiceIds: rows
      .filter((row) => row.category === 'addon' && row.service_id)
      .map((row) => row.service_id as number),
  };
}

export function listBookingsForDate(db: Database.Database, date: string): BookingDetailRow[] {
  return db.prepare(`
    SELECT b.*, c.name AS customer_name, c.phone, v.plate, v.vehicle_type, v.model AS vehicle_model,
      GROUP_CONCAT(bs.service_name, ' · ') AS services
    FROM bookings b
    JOIN vehicles v ON v.id = b.vehicle_id
    LEFT JOIN customers c ON c.id = b.customer_id
    LEFT JOIN booking_services bs ON bs.booking_id = b.id
    WHERE b.booking_date = ?
    GROUP BY b.id
    ORDER BY b.pickup_hour, b.dropoff_hour, b.created_at
  `).all(date) as BookingDetailRow[];
}

export interface AdminBookingUpdate {
  name: string | null;
  phone: string | null;
  plate: string;
  vehicleType: VehicleType;
  dropoffHour: number;
  pickupHour: number;
  status: BookingStatus;
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  amountPaidCents: number;
  totalCents: number;
  notes: string | null;
  baseServiceId: number;
  addonServiceIds: number[];
}

export function updateBookingByAdmin(db: Database.Database, id: number, raw: unknown): void {
  const schema = z.object({
    name: optionalText.transform((value) => capitalizeWords(value)),
    model: optionalText.transform((value) => capitalizeWords(value)),
    phone: z.string().trim().max(20).optional().transform((value) => value || null),
    plate: z.string().trim().min(3).max(12).regex(/^[A-Za-z0-9-]+$/).transform((value) => value.toUpperCase()),
    vehicleType: z.enum(VEHICLE_TYPES),
    baseServiceId: z.coerce.number().int().positive(),
    addonServiceIds: z.array(z.coerce.number().int().positive()).default([]),
    dropoffHour: z.coerce.number().int().min(0).max(23),
    pickupHour: z.coerce.number().int().min(0).max(23),
    dropoffMinute: z.coerce.number().int().min(0).max(59).default(0),
    pickupMinute: z.coerce.number().int().min(0).max(59).default(0),
    status: z.enum(BOOKING_STATUSES),
    paymentMethod: z.enum(PAYMENT_METHODS),
    paymentStatus: z.enum(PAYMENT_STATUSES),
    amountPaid: z.coerce.number().min(0),
    total: z.coerce.number().min(0),
    notes: z.string().trim().max(1000).optional().transform((value) => value || null),
  });
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new BookingValidationError(parsed.error.issues[0]?.message ?? 'Datos inválidos.');
  if (parsed.data.phone && !/^\+?[0-9 ()-]{7,20}$/.test(parsed.data.phone)) {
    throw new BookingValidationError('Ingresa un teléfono válido.');
  }
  const booking = getBooking(db, id);
  if (!booking) throw new BookingValidationError('Reserva no encontrada.');
  const update = parsed.data;
  const totalCents = Math.round(update.total * 100);
  const amountPaidCents = Math.round(update.amountPaid * 100);
  if (amountPaidCents > totalCents) {
    throw new BookingValidationError('El monto pagado no puede superar el total.');
  }
  if (update.paymentStatus === 'paid' && amountPaidCents !== totalCents) {
    throw new BookingValidationError('Una reserva pagada debe tener el total cancelado.');
  }
  const selection = selectedServices(getServicesWithPrices(db), update as BookingInput);
  const allSelected = [selection.base, ...selection.addons];
  db.transaction(() => {
    // 1. Manejo seguro de cliente sin afectar otras reservas duplicadas o compartidas
    let targetCustomerId: number | null = booking.customer_id;

    if (update.phone || update.name) {
      const existingCustomer = update.phone
        ? (db.prepare('SELECT id FROM customers WHERE phone = ?').get(update.phone) as { id: number } | undefined)
        : undefined;

      if (existingCustomer) {
        targetCustomerId = existingCustomer.id;
        if (update.name) {
          db.prepare('UPDATE customers SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
            update.name,
            targetCustomerId,
          );
        }
      } else if (booking.customer_id) {
        const otherBookingsWithCustomer = (
          db.prepare('SELECT COUNT(*) AS count FROM bookings WHERE customer_id = ? AND id != ?').get(booking.customer_id, id) as { count: number }
        ).count;

        if (otherBookingsWithCustomer === 0) {
          targetCustomerId = booking.customer_id;
          db.prepare('UPDATE customers SET name = COALESCE(?, name), phone = COALESCE(?, phone), updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
            update.name,
            update.phone,
            targetCustomerId,
          );
        } else {
          const insertCust = db.prepare('INSERT INTO customers (name, phone) VALUES (?, ?)').run(
            update.name,
            update.phone,
          );
          targetCustomerId = Number(insertCust.lastInsertRowid);
        }
      } else {
        const insertCust = db.prepare('INSERT INTO customers (name, phone) VALUES (?, ?)').run(
          update.name,
          update.phone,
        );
        targetCustomerId = Number(insertCust.lastInsertRowid);
      }
    }

    // 2. Manejo seguro de vehículo: si se comparte o duplica, aislar solo esta reserva
    const otherBookingsWithVehicle = (
      db.prepare('SELECT COUNT(*) AS count FROM bookings WHERE vehicle_id = ? AND id != ?').get(booking.vehicle_id, id) as { count: number }
    ).count;

    const targetVehicle = db.prepare('SELECT id, customer_id FROM vehicles WHERE plate = ?').get(update.plate) as
      | { id: number; customer_id: number | null }
      | undefined;

    let targetVehicleId: number;

    if (targetVehicle) {
      targetVehicleId = targetVehicle.id;
      db.prepare(`
        UPDATE vehicles
        SET vehicle_type = ?, model = COALESCE(?, model), customer_id = COALESCE(?, customer_id), updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(update.vehicleType, update.model ?? null, targetCustomerId, targetVehicleId);
    } else if (otherBookingsWithVehicle === 0) {
      targetVehicleId = booking.vehicle_id;
      db.prepare(`
        UPDATE vehicles
        SET plate = ?, vehicle_type = ?, model = COALESCE(?, model), customer_id = COALESCE(?, customer_id), updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(update.plate, update.vehicleType, update.model ?? null, targetCustomerId, targetVehicleId);
    } else {
      const insertVeh = db.prepare(`
        INSERT INTO vehicles (plate, vehicle_type, model, customer_id)
        VALUES (?, ?, ?, ?)
      `).run(update.plate, update.vehicleType, update.model ?? null, targetCustomerId);
      targetVehicleId = Number(insertVeh.lastInsertRowid);
    }

    // 3. Actualizar exclusivamente la reserva
    db.prepare(`
      UPDATE bookings SET
        vehicle_id = ?,
        customer_id = ?,
        dropoff_hour = ?,
        pickup_hour = ?,
        dropoff_minute = ?,
        pickup_minute = ?,
        status = ?,
        payment_method = ?,
        payment_status = ?,
        amount_paid_cents = ?,
        total_cents = ?,
        notes = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      targetVehicleId,
      targetCustomerId,
      update.dropoffHour,
      update.pickupHour,
      toMinutes(update.dropoffHour, update.dropoffMinute),
      toMinutes(update.pickupHour, update.pickupMinute),
      update.status,
      update.paymentMethod,
      update.paymentStatus,
      amountPaidCents,
      totalCents,
      update.notes,
      id,
    );

    // 4. Actualizar los servicios seleccionados exclusivamente para esta reserva
    db.prepare('DELETE FROM booking_services WHERE booking_id = ?').run(id);
    const insertBookingService = db.prepare(`
      INSERT INTO booking_services (booking_id, service_id, service_name, category, price_cents)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const service of allSelected) {
      insertBookingService.run(
        id,
        service.id,
        service.name,
        service.category,
        service.prices[update.vehicleType] ?? 0,
      );
    }
  })();
}

export const WASH_DURATION_MINUTES: Record<VehicleType, number> = {
  motorcycle: 30,
  car: 30,
  small_suv: 45,
  large_suv: 45,
};

export function checkAndAutoCompleteBookings(db: Database.Database): number {
  const inProgress = db.prepare(`
    SELECT b.id, b.started_washing_at, v.vehicle_type
    FROM bookings b
    JOIN vehicles v ON b.vehicle_id = v.id
    WHERE b.status = 'in_progress' AND b.started_washing_at IS NOT NULL
  `).all() as Array<{ id: number; started_washing_at: string; vehicle_type: VehicleType }>;

  const nowMs = Date.now();
  let updatedCount = 0;
  const completeStmt = db.prepare(`
    UPDATE bookings SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `);

  for (const item of inProgress) {
    const startedMs = Date.parse(item.started_washing_at);
    if (isNaN(startedMs)) continue;
    const durationMinutes = (item.vehicle_type === 'small_suv' || item.vehicle_type === 'large_suv') ? 45 : 30;
    const elapsedMinutes = (nowMs - startedMs) / (60 * 1000);
    if (elapsedMinutes >= durationMinutes) {
      completeStmt.run(item.id);
      updatedCount++;
    }
  }

  return updatedCount;
}

export interface VehicleLookupResult {
  found: boolean;
  plate?: string;
  vehicleType?: VehicleType;
  model?: string | null;
  name?: string | null;
  phone?: string | null;
}

export function lookupVehicleByPlate(db: Database.Database, plate: string): VehicleLookupResult {
  const normalized = plate.trim().toUpperCase();
  if (normalized.length < 3) return { found: false };

  const row = db.prepare(`
    SELECT v.plate, v.vehicle_type, v.model, c.name AS customer_name, c.phone AS customer_phone
    FROM vehicles v
    LEFT JOIN customers c ON c.id = v.customer_id
    WHERE v.plate = ?
    LIMIT 1
  `).get(normalized) as { plate: string; vehicle_type: VehicleType; model: string | null; customer_name: string | null; customer_phone: string | null } | undefined;

  if (!row) return { found: false };
  return {
    found: true,
    plate: row.plate,
    vehicleType: row.vehicle_type,
    model: row.model,
    name: row.customer_name,
    phone: row.customer_phone,
  };
}

export interface PaymentBreakdown {
  yapeCents: number;
  plinCents: number;
  cashCents: number;
  totalCollectedCents: number;
  totalPendingCents: number;
  totalExpectedCents: number;
}

export function getDailyPaymentBreakdown(db: Database.Database, date: string): PaymentBreakdown {
  const rows = db.prepare(`
    SELECT payment_method, payment_status, amount_paid_cents, total_cents
    FROM bookings
    WHERE booking_date = ? AND status != 'cancelled'
  `).all(date) as Array<{
    payment_method: PaymentMethod;
    payment_status: PaymentStatus;
    amount_paid_cents: number;
    total_cents: number;
  }>;

  let yapeCents = 0;
  let plinCents = 0;
  let cashCents = 0;
  let totalCollectedCents = 0;
  let totalExpectedCents = 0;

  for (const row of rows) {
    totalCollectedCents += row.amount_paid_cents;
    totalExpectedCents += row.total_cents;
    if (row.payment_method === 'yape') yapeCents += row.amount_paid_cents;
    else if (row.payment_method === 'plin') plinCents += row.amount_paid_cents;
    else if (row.payment_method === 'cash') cashCents += row.amount_paid_cents;
  }

  return {
    yapeCents,
    plinCents,
    cashCents,
    totalCollectedCents,
    totalPendingCents: Math.max(0, totalExpectedCents - totalCollectedCents),
    totalExpectedCents,
  };
}

export function deleteBooking(db: Database.Database, id: number): boolean {
  const txn = db.transaction(() => {
    db.prepare('DELETE FROM booking_services WHERE booking_id = ?').run(id);
    const result = db.prepare('DELETE FROM bookings WHERE id = ?').run(id);
    return result.changes > 0;
  });
  return txn();
}

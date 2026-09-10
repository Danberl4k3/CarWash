import type Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  BOOKING_STATUSES,
  BUSINESS,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  VEHICLE_TYPES,
  type BookingStatus,
  type PaymentMethod,
  type PaymentStatus,
  type VehicleType,
} from '../constants.js';
import { getServicesWithPrices, type ServiceWithPrices } from '../db.js';
import { getLimaNow, isBusinessDay, isDropoffInPast, phoneIsRequired, toMinutes, type LimaNow } from '../time.js';

const optionalText = z
  .string()
  .trim()
  .max(200)
  .optional()
  .transform((value) => value || null);

const optionalYear = z.preprocess(
  (value) => value === undefined || value === null || value === '' ? null : value,
  z.coerce.number().int().min(1900).max(2100).nullable(),
);

export const bookingSchema = z.object({
  name: optionalText,
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
  vehicleMake: optionalText,
  vehicleModel: optionalText,
  vehicleColor: optionalText,
  vehicleYear: optionalYear,
  vehicleOwner: optionalText,
  vehicleType: z.enum(VEHICLE_TYPES, { message: 'Selecciona un tipo de vehículo.' }),
  baseServiceId: z.coerce.number().int().positive('Selecciona un servicio.'),
  addonServiceIds: z.array(z.coerce.number().int().positive()).default([]),
  dropoffHour: z.coerce.number().int().min(BUSINESS.openHour).max(BUSINESS.lastDropoffHour),
  pickupHour: z.coerce.number().int().min(BUSINESS.openHour + 1).max(BUSINESS.closeHour),
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
  phone: string | null;
  plate: string;
  vehicleMake: string | null;
  vehicleModel: string | null;
  vehicleColor: string | null;
  vehicleYear: number | null;
  vehicleOwner: string | null;
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
    throw new BookingValidationError('Para motos solo está disponible el lavado de moto.');
  }
  if (input.vehicleType !== 'motorcycle' && base.slug === 'motorcycle-wash') {
    throw new BookingValidationError('El lavado de moto solo corresponde a motos.');
  }
  const addonIds = uniqueNumbers(input.addonServiceIds);
  const addons = addonIds.map((id) => services.find((service) => service.id === id && service.category === 'addon'));
  if (addons.some((service) => !service)) {
    throw new BookingValidationError('Uno de los adicionales no está disponible.');
  }
  const resolvedAddons = addons as ServiceWithPrices[];
  if (input.vehicleType === 'motorcycle' && resolvedAddons.length > 0) {
    throw new BookingValidationError('Las motos no pueden tener servicios adicionales.');
  }
  if (base.slug === 'interior' && resolvedAddons.some((service) => service.incompatible_with_interior)) {
    throw new BookingValidationError('La cera no está disponible con el lavado interior.');
  }
  return { base, addons: resolvedAddons };
}

export function validateBookingRules(input: BookingInput, now: LimaNow, allowPastSlot = false): void {
  if (!isBusinessDay(now)) throw new BookingValidationError('Las reservas están disponibles de lunes a sábado.');
  const dropoffTotal = toMinutes(input.dropoffHour, input.dropoffMinute);
  const pickupTotal = toMinutes(input.pickupHour, input.pickupMinute);
  if (input.dropoffMinute % 10 !== 0 || input.pickupMinute % 10 !== 0) {
    throw new BookingValidationError('Las horas deben estar en intervalos de 10 minutos.');
  }
  if (dropoffTotal >= BUSINESS.closeHour * 60 || pickupTotal > BUSINESS.closeHour * 60) {
    throw new BookingValidationError('El horario seleccionado está fuera de atención.');
  }
  if (pickupTotal <= dropoffTotal) {
    throw new BookingValidationError('La hora de recojo debe ser posterior a la hora de ingreso.');
  }
  if (!allowPastSlot && dropoffTotal <= toMinutes(now.hour, now.minute)) {
    throw new BookingValidationError('Selecciona una hora de ingreso futura.');
  }
  if (phoneIsRequired(now, input.pickupHour, input.pickupMinute) && !input.phone) {
    throw new BookingValidationError('El teléfono es obligatorio después de las 2 p. m. o para recojos desde las 4 p. m.');
  }
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
  const capacity = db.prepare('SELECT max_slots FROM capacity_slots WHERE hour = ?').get(input.dropoffHour) as
    | { max_slots: number }
    | undefined;
  if (!capacity) throw new BookingValidationError('Ese horario no está configurado.');

  const used = db
    .prepare(`
      SELECT COUNT(*) AS count FROM bookings
      WHERE booking_date = ? AND dropoff_hour = ? AND status NOT IN ('completed', 'cancelled')
    `)
    .get(now.date, input.dropoffHour) as { count: number };
  if (used.count >= capacity.max_slots) {
    throw new BookingValidationError('Ese horario acaba de llenarse. Elige otro turno.');
  }

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
        UPDATE vehicles SET vehicle_type = ?, customer_id = ?, marca = ?, modelo = ?, color = ?, anio = ?, propietario = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(input.vehicleType, customerId, input.vehicleMake, input.vehicleModel, input.vehicleColor, input.vehicleYear, input.vehicleOwner, vehicle.id);
    } else {
      const vehicleResult = db
        .prepare('INSERT INTO vehicles (plate, vehicle_type, customer_id, marca, modelo, color, anio, propietario) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(input.plate, input.vehicleType, customerId, input.vehicleMake, input.vehicleModel, input.vehicleColor, input.vehicleYear, input.vehicleOwner);
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
  marca: string | null;
  modelo: string | null;
  color: string | null;
  anio: number | null;
  propietario: string | null;
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
  created_by_admin: number;
  created_at: string;
  updated_at: string;
  services: string;
}

export function getBooking(db: Database.Database, id: number): BookingDetailRow | undefined {
  return db.prepare(`
    SELECT b.*, c.name AS customer_name, c.phone, v.plate, v.vehicle_type, v.marca, v.modelo, v.color, v.anio, v.propietario,
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
    SELECT b.*, c.name AS customer_name, c.phone, v.plate, v.vehicle_type, v.marca, v.modelo, v.color, v.anio, v.propietario,
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
    SELECT b.*, c.name AS customer_name, c.phone, v.plate, v.vehicle_type, v.marca, v.modelo, v.color, v.anio, v.propietario,
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
  vehicleMake: string | null;
  vehicleModel: string | null;
  vehicleColor: string | null;
  vehicleYear: number | null;
  vehicleOwner: string | null;
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
    name: optionalText,
    phone: z.string().trim().max(20).optional().transform((value) => value || null),
    plate: z.string().trim().min(3).max(12).regex(/^[A-Za-z0-9-]+$/).transform((value) => value.toUpperCase()),
    vehicleMake: optionalText,
    vehicleModel: optionalText,
    vehicleColor: optionalText,
    vehicleYear: optionalYear,
    vehicleOwner: optionalText,
    vehicleType: z.enum(VEHICLE_TYPES),
    baseServiceId: z.coerce.number().int().positive(),
    addonServiceIds: z.array(z.coerce.number().int().positive()).default([]),
    dropoffHour: z.coerce.number().int().min(7).max(17),
    pickupHour: z.coerce.number().int().min(8).max(18),
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
  if (toMinutes(parsed.data.pickupHour, parsed.data.pickupMinute) <= toMinutes(parsed.data.dropoffHour, parsed.data.dropoffMinute)) {
    throw new BookingValidationError('La hora de recojo debe ser posterior al ingreso.');
  }
  const booking = getBooking(db, id);
  if (!booking) throw new BookingValidationError('Reserva no encontrada.');
  const update = parsed.data;
  if (toMinutes(update.pickupHour, update.pickupMinute) > BUSINESS.closeHour * 60) {
    throw new BookingValidationError('El recojo no puede superar las 6 p. m.');
  }
  if (update.dropoffMinute % 10 !== 0 || update.pickupMinute % 10 !== 0) {
    throw new BookingValidationError('Las horas deben estar en intervalos de 10 minutos.');
  }
  if (
    update.status !== 'completed'
    && update.status !== 'cancelled'
    && (update.dropoffHour !== booking.dropoff_hour || booking.status === 'completed' || booking.status === 'cancelled')
  ) {
    const capacity = db.prepare('SELECT max_slots FROM capacity_slots WHERE hour = ?').get(update.dropoffHour) as
      | { max_slots: number }
      | undefined;
    if (!capacity) throw new BookingValidationError('Ese horario no está configurado.');
    const used = db.prepare(`
      SELECT COUNT(*) AS count FROM bookings
      WHERE booking_date = ? AND dropoff_hour = ? AND status NOT IN ('completed', 'cancelled') AND id != ?
    `).get(booking.booking_date, update.dropoffHour, id) as { count: number };
    if (used.count >= capacity.max_slots) {
      throw new BookingValidationError('No hay cupos disponibles en el nuevo horario.');
    }
  }
  const selection = selectedServices(getServicesWithPrices(db), update as BookingInput);
  const allSelected = [selection.base, ...selection.addons];
  db.transaction(() => {
    db.prepare(`UPDATE customers SET name = ?, phone = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(
      update.name,
      update.phone,
      booking.customer_id,
    );
    db.prepare(`UPDATE vehicles SET plate = ?, vehicle_type = ?, marca = ?, modelo = ?, color = ?, anio = ?, propietario = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(
      update.plate,
      update.vehicleType,
      update.vehicleMake,
      update.vehicleModel,
      update.vehicleColor,
      update.vehicleYear,
      update.vehicleOwner,
      booking.vehicle_id,
    );
    db.prepare(`
      UPDATE bookings SET dropoff_hour = ?, pickup_hour = ?, dropoff_minute = ?, pickup_minute = ?, status = ?, payment_method = ?,
        payment_status = ?, amount_paid_cents = ?, total_cents = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      update.dropoffHour,
      update.pickupHour,
      toMinutes(update.dropoffHour, update.dropoffMinute),
      toMinutes(update.pickupHour, update.pickupMinute),
      update.status,
      update.paymentMethod,
      update.paymentStatus,
      Math.round(update.amountPaid * 100),
      Math.round(update.total * 100),
      update.notes,
      id,
    );
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

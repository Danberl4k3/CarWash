import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { createDatabase } from '../src/db.js';
import {
  BookingValidationError,
  checkAndAutoCompleteBookings,
  createBooking,
  getBooking,
  getBookingServiceIds,
  updateBookingByAdmin,
} from '../src/domain/bookings.js';
import type { LimaNow } from '../src/time.js';

const mondayAt = (hour: number): LimaNow => ({
  date: '2026-09-07',
  hour,
  minute: 0,
  weekday: 'Mon',
});

describe('reglas de reserva', () => {
  let db: Database.Database;
  let interiorId: number;
  let exteriorId: number;
  let waxId: number;
  let motorcycleWashId: number;

  beforeEach(() => {
    db = createDatabase(':memory:').db;
    const service = (slug: string) =>
      (db.prepare('SELECT id FROM services WHERE slug = ?').get(slug) as { id: number }).id;
    interiorId = service('interior');
    exteriorId = service('exterior');
    waxId = service('wax');
    motorcycleWashId = service('motorcycle-wash');
  });

  afterEach(() => db.close());

  const validInput = () => ({
    name: 'Ana',
    phone: '',
    plate: 'abc-123',
    vehicleType: 'car',
    baseServiceId: exteriorId,
    addonServiceIds: [],
    dropoffHour: 10,
    pickupHour: 11,
    paymentMethod: 'yape',
    notes: '',
  });

  it('crea un código y normaliza la placa', () => {
    const result = createBooking(db, validInput(), { now: mondayAt(8) });
    const booking = getBooking(db, result.id);
    expect(result.code).toMatch(/^DASAV-20260907-[A-F0-9]{6}$/);
    expect(booking?.plate).toBe('ABC-123');
    expect(result.totalCents).toBe(1000);
  });

  it('ofrece una sola opción para motos a S/ 15', () => {
    const result = createBooking(db, {
      ...validInput(),
      plate: 'MOTO-01',
      vehicleType: 'motorcycle',
      baseServiceId: motorcycleWashId,
    }, { now: mondayAt(8) });
    expect(result.totalCents).toBe(1500);
  });



  it('no permite cera con lavado interior', () => {
    const input = { ...validInput(), baseServiceId: interiorId, addonServiceIds: [waxId] };
    expect(() => createBooking(db, input, { now: mondayAt(8) })).toThrow(/cera/i);
  });

  it('permite varias reservas aunque la capacidad configurada sea uno', () => {
    const slot = db.prepare('SELECT max_slots FROM capacity_slots WHERE hour = 10').get() as { max_slots: number };
    expect(slot.max_slots).toBe(6);

    db.prepare('UPDATE capacity_slots SET max_slots = 1 WHERE hour = 10').run();
    const first = createBooking(db, validInput(), { now: mondayAt(8) });
    const second = createBooking(db, { ...validInput(), plate: 'XYZ-987' }, { now: mondayAt(8) });
    expect(first.id).toBeGreaterThan(0);
    expect(second.id).toBeGreaterThan(0);
  });

  it('permite reservar en domingo, en una hora pasada y no configurada', () => {
    const booking = createBooking(
      db,
      { ...validInput(), dropoffHour: 21, dropoffMinute: 30, pickupHour: 22 },
      { now: { ...mondayAt(22), weekday: 'Sun' } },
    );
    expect(booking.id).toBeGreaterThan(0);
  });

  it('permite reservar sin teléfono en cualquier horario y valida formato si se ingresa', () => {
    const booking = createBooking(db, { ...validInput(), phone: '', dropoffHour: 15, pickupHour: 16 }, {
      now: mondayAt(14),
    });
    expect(booking.id).toBeGreaterThan(0);

    expect(() => createBooking(db, { ...validInput(), phone: '123' }, {
      now: mondayAt(8),
    })).toThrow(/teléfono válido/i);
  });

  it('permite registrar y editar reservas sin restricciones en la hora de recojo', () => {
    const booking1 = createBooking(db, { ...validInput(), dropoffHour: 15, dropoffMinute: 30, pickupHour: 15, pickupMinute: 30 }, {
      now: mondayAt(8),
    });
    expect(booking1.id).toBeGreaterThan(0);

    const booking2 = createBooking(db, { ...validInput(), dropoffHour: 17, pickupHour: 9 }, {
      now: mondayAt(8),
    });
    expect(booking2.id).toBeGreaterThan(0);

    updateBookingByAdmin(db, booking1.id, {
      name: 'Ana', model: 'Toyota', phone: '', plate: 'abc-123', vehicleType: 'car',
      baseServiceId: exteriorId, addonServiceIds: [], dropoffHour: 22, pickupHour: 10,
      status: 'pending', paymentMethod: 'cash', paymentStatus: 'pending', amountPaid: 0, total: 10, notes: '',
    });
    const updated = getBooking(db, booking1.id);
    expect(updated?.dropoff_hour).toBe(22);
    expect(updated?.pickup_hour).toBe(10);
  });

  it('rechaza datos de pago inconsistentes al editar', () => {
    const result = createBooking(db, validInput(), { now: mondayAt(8) });
    expect(() => updateBookingByAdmin(db, result.id, {
      name: 'Ana', model: 'Toyota', phone: '999999999', plate: 'abc-123', vehicleType: 'car',
      baseServiceId: exteriorId, addonServiceIds: [], dropoffHour: 10, pickupHour: 11,
      status: 'pending', paymentMethod: 'cash', paymentStatus: 'paid', amountPaid: 1, total: 10, notes: '',
    })).toThrow(/pagada/i);
  });

  it('permite al administrador editar todos los datos y servicios', () => {
    const result = createBooking(db, validInput(), { now: mondayAt(8) });
    updateBookingByAdmin(db, result.id, {
      name: 'Ana actualizada',
      model: 'toyota corolla',
      phone: '999999999',
      plate: 'new-456',
      vehicleType: 'large_suv',
      baseServiceId: interiorId,
      addonServiceIds: [],
      dropoffHour: 11,
      pickupHour: 13,
      status: 'completed',
      paymentMethod: 'cash',
      paymentStatus: 'paid',
      amountPaid: 25,
      total: 25,
      notes: 'Entregado',
    });
    const booking = getBooking(db, result.id);
    expect(booking).toMatchObject({
      customer_name: 'Ana Actualizada',
      vehicle_model: 'Toyota Corolla',
      plate: 'NEW-456',
      vehicle_type: 'large_suv',
      dropoff_hour: 11,
      pickup_hour: 13,
      status: 'completed',
      payment_status: 'paid',
      amount_paid_cents: 2500,
    });
    expect(getBookingServiceIds(db, result.id)).toEqual({ baseServiceId: interiorId, addonServiceIds: [] });
  });

  it('autocompleta lavado a los 30 min para autos y 45 min para SUVs', () => {
    const carRes = createBooking(db, validInput(), { now: mondayAt(8) });
    const suvRes = createBooking(db, {
      ...validInput(),
      plate: 'SUV-999',
      vehicleType: 'small_suv',
    }, { now: mondayAt(8) });

    const twentyMinAgo = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    const thirtyFiveMinAgo = new Date(Date.now() - 35 * 60 * 1000).toISOString();
    const fiftyMinAgo = new Date(Date.now() - 50 * 60 * 1000).toISOString();

    // Set both to in_progress with 20 minutes ago
    db.prepare('UPDATE bookings SET status = ?, started_washing_at = ? WHERE id = ?').run('in_progress', twentyMinAgo, carRes.id);
    db.prepare('UPDATE bookings SET status = ?, started_washing_at = ? WHERE id = ?').run('in_progress', twentyMinAgo, suvRes.id);

    let completedCount = checkAndAutoCompleteBookings(db);
    expect(completedCount).toBe(0);
    expect(getBooking(db, carRes.id)?.status).toBe('in_progress');
    expect(getBooking(db, suvRes.id)?.status).toBe('in_progress');

    // After 35 minutes: car (30 min threshold) is completed, SUV (45 min threshold) is still in_progress
    db.prepare('UPDATE bookings SET started_washing_at = ? WHERE id = ?').run(thirtyFiveMinAgo, carRes.id);
    db.prepare('UPDATE bookings SET started_washing_at = ? WHERE id = ?').run(thirtyFiveMinAgo, suvRes.id);

    completedCount = checkAndAutoCompleteBookings(db);
    expect(completedCount).toBe(1);
    expect(getBooking(db, carRes.id)?.status).toBe('completed');
    expect(getBooking(db, suvRes.id)?.status).toBe('in_progress');

    // After 50 minutes: SUV also reaches threshold (45 min) and transitions to completed
    db.prepare('UPDATE bookings SET started_washing_at = ? WHERE id = ?').run(fiftyMinAgo, suvRes.id);
    completedCount = checkAndAutoCompleteBookings(db);
    expect(completedCount).toBe(1);
    expect(getBooking(db, suvRes.id)?.status).toBe('completed');
  });

  it('al editar una de dos reservas duplicadas, solo se modifica la editada y no ambas', () => {
    // 1. Crear dos reservas con el mismo vehículo y cliente (duplicadas sin querer)
    const booking1 = createBooking(db, {
      ...validInput(),
      plate: 'DUPLI-1',
      name: 'Cliente Original',
      model: 'Toyota Corolla',
      dropoffHour: 9,
      pickupHour: 10,
    }, { now: mondayAt(8) });

    const booking2 = createBooking(db, {
      ...validInput(),
      plate: 'DUPLI-1',
      name: 'Cliente Original',
      model: 'Toyota Corolla',
      dropoffHour: 11,
      pickupHour: 12,
    }, { now: mondayAt(8) });

    expect(getBooking(db, booking1.id)?.plate).toBe('DUPLI-1');
    expect(getBooking(db, booking2.id)?.plate).toBe('DUPLI-1');

    // 2. El administrador edita SOLO la segunda reserva para asignarle otro auto y cliente
    updateBookingByAdmin(db, booking2.id, {
      plate: 'NUEVO-99',
      name: 'Segundo Cliente',
      model: 'Hyundai Tucson',
      phone: '987111222',
      vehicleType: 'small_suv',
      baseServiceId: exteriorId,
      addonServiceIds: [],
      dropoffHour: 14,
      pickupHour: 15,
      status: 'pending',
      paymentMethod: 'cash',
      paymentStatus: 'pending',
      amountPaid: 0,
      total: 15,
      notes: 'Auto nuevo',
    });

    // 3. Comprobar que booking2 cambió a los nuevos datos
    const b2 = getBooking(db, booking2.id);
    expect(b2?.plate).toBe('NUEVO-99');
    expect(b2?.customer_name).toBe('Segundo Cliente');
    expect(b2?.vehicle_model).toBe('Hyundai Tucson');
    expect(b2?.vehicle_type).toBe('small_suv');
    expect(b2?.dropoff_hour).toBe(14);

    // 4. Comprobar que booking1 PERMANECE INTACTO con su placa, modelo y cliente original
    const b1 = getBooking(db, booking1.id);
    expect(b1?.plate).toBe('DUPLI-1');
    expect(b1?.customer_name).toBe('Cliente Original');
    expect(b1?.vehicle_model).toBe('Toyota Corolla');
    expect(b1?.vehicle_type).toBe('car');
    expect(b1?.dropoff_hour).toBe(9);
  });
});


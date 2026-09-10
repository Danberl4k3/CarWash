import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { createDatabase } from '../src/db.js';
import {
  BookingValidationError,
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

  it('requiere teléfono después de las 2 p. m.', () => {
    expect(() => createBooking(db, validInput(), { now: mondayAt(14) })).toThrow(BookingValidationError);
  });

  it('requiere teléfono para recojo desde las 4 p. m.', () => {
    const input = { ...validInput(), dropoffHour: 15, pickupHour: 16 };
    expect(() => createBooking(db, input, { now: mondayAt(8) })).toThrow(/teléfono/i);
  });

  it('no permite cera con lavado interior', () => {
    const input = { ...validInput(), baseServiceId: interiorId, addonServiceIds: [waxId] };
    expect(() => createBooking(db, input, { now: mondayAt(8) })).toThrow(/cera/i);
  });

  it('respeta la capacidad configurada por hora', () => {
    createBooking(db, validInput(), { now: mondayAt(8) });
    expect(() =>
      createBooking(db, { ...validInput(), plate: 'XYZ-987' }, { now: mondayAt(8) }),
    ).toThrow(/llenarse/i);
  });

  it('no permite reservar en domingo', () => {
    expect(() =>
      createBooking(db, validInput(), { now: { ...mondayAt(8), weekday: 'Sun' } }),
    ).toThrow(/lunes a sábado/i);
  });

  it('permite al administrador editar todos los datos y servicios', () => {
    const result = createBooking(db, validInput(), { now: mondayAt(8) });
    updateBookingByAdmin(db, result.id, {
      name: 'Ana actualizada',
      phone: '999999999',
      plate: 'NEW-456',
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
      customer_name: 'Ana actualizada',
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

  it('rechaza adicionales para motos', () => {
    expect(() => createBooking(db, {
      ...validInput(),
      plate: 'MOTO-02',
      vehicleType: 'motorcycle',
      baseServiceId: motorcycleWashId,
      addonServiceIds: [waxId],
    }, { now: mondayAt(8) })).toThrow(/motos.*adicionales/i);
  });
});

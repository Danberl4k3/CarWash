import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { BUSINESS, PAYMENT_LABELS, STATUS_LABELS, VEHICLE_LABELS, formatMoney, hourLabel } from '../constants.js';
import { getServicesWithPrices } from '../db.js';
import { BookingValidationError, createBooking, getBookingByCode, lookupVehicleByPlate } from '../domain/bookings.js';
import { appEvents } from '../events.js';
import { dropoffHours, getLimaNow, isBusinessDay, isDropoffInPast, pickupHours, roundUpTo10 } from '../time.js';

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (value === undefined || value === null || value === '') return [];
  return [String(value)];
}

export async function registerPublicRoutes(app: FastifyInstance, db: Database.Database): Promise<void> {
  app.get('/', async (request, reply) => {
    const now = getLimaNow();
    const automaticDropoff = { hour: now.hour, minute: now.minute };
    const services = getServicesWithPrices(db, true);
    const capacities = db.prepare('SELECT hour, max_slots FROM capacity_slots ORDER BY hour').all() as Array<{
      hour: number;
      max_slots: number;
    }>;
    const usedRows = db.prepare(`
      SELECT dropoff_hour AS hour, COUNT(*) AS used
      FROM bookings WHERE booking_date = ? AND status != 'cancelled'
      GROUP BY dropoff_hour
    `).all(now.date) as Array<{ hour: number; used: number }>;
    const used = new Map(usedRows.map((row) => [row.hour, row.used]));
    const slots = capacities.map((slot) => ({
      ...slot,
      used: used.get(slot.hour) ?? 0,
      available: Math.max(0, slot.max_slots - (used.get(slot.hour) ?? 0)),
      disabled: !isBusinessDay(now) || isDropoffInPast(slot.hour, now) || (used.get(slot.hour) ?? 0) >= slot.max_slots,
      label: hourLabel(slot.hour),
    }));
    return reply.view('index.ejs', {
      title: 'Reserva tu lavado',
      business: BUSINESS,
      now,
      automaticDropoff,
      openToday: isBusinessDay(now),
      services,
      serviceCatalog: JSON.stringify(services).replaceAll('<', '\\u003c'),
      slots,
      pickupSlots: pickupHours().map((hour) => ({ hour, label: hourLabel(hour) })),
      vehicleLabels: VEHICLE_LABELS,
      paymentLabels: PAYMENT_LABELS,
      error: typeof (request.query as { error?: unknown }).error === 'string' ? (request.query as { error: string }).error : null,
      formatMoney,
      hourLabel,
    });
  });

  app.get(
    '/api/vehiculo-lookup',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const plate = String((request.query as { plate?: unknown })?.plate ?? '');
      if (!plate) return reply.code(400).send({ error: 'Placa requerida' });
      const result = lookupVehicleByPlate(db, plate);
      return reply.send(result);
    },
  );

  app.post(
    '/reservar',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = request.body as Record<string, unknown>;
      try {
        const now = getLimaNow();
        const pickup = String(body.pickupTime || '').trim();
        let pickupHour: number | undefined;
        let pickupMinute: number | undefined;
        if (pickup && pickup.includes(':')) {
          const parts = pickup.split(':').map(Number);
          if (Number.isFinite(parts[0])) pickupHour = parts[0];
          if (Number.isFinite(parts[1])) pickupMinute = parts[1];
        } else if (body.pickupHour !== undefined && body.pickupHour !== '') {
          pickupHour = Number(body.pickupHour);
          pickupMinute = Number(body.pickupMinute ?? 0);
        }
        const result = createBooking(db, {
          name: body.name,
          model: body.model,
          phone: body.phone,
          plate: body.plate,
          vehicleType: body.vehicleType,
          baseServiceId: body.baseServiceId,
          addonServiceIds: stringArray(body.addonServiceIds),
          dropoffHour: now.hour,
          dropoffMinute: now.minute,
          pickupHour: Number.isFinite(pickupHour) ? (pickupHour as number) : (now.hour + 1) % 24,
          pickupMinute: Number.isFinite(pickupMinute) ? (pickupMinute as number) : 0,
          paymentMethod: body.paymentMethod,
          notes: body.notes,
        });

        // Emitir evento para el panel administrativo en tiempo real (SSE)
        appEvents.emitAppEvent('booking_created', { code: result.code, id: result.id });

        return reply.redirect(`/reserva/${encodeURIComponent(result.code)}`);
      } catch (error) {
        const message = error instanceof BookingValidationError ? error.message : 'No pudimos registrar la reserva.';
        request.log.error(error);
        return reply.redirect(`/?error=${encodeURIComponent(message)}`);
      }
    },
  );

  app.get('/api/reserva/:code/status', async (request, reply) => {
    const { code } = request.params as { code: string };
    const booking = getBookingByCode(db, code.toUpperCase());
    if (!booking) return reply.code(404).send({ error: 'Reserva no encontrada' });
    const durationMinutes = (booking.vehicle_type === 'small_suv' || booking.vehicle_type === 'large_suv') ? 45 : 30;
    return reply.send({
      code: booking.code,
      status: booking.status,
      statusLabel: STATUS_LABELS[booking.status] ?? booking.status,
      paymentStatus: booking.payment_status,
      startedWashingAt: booking.started_washing_at,
      durationMinutes,
      totalCents: booking.total_cents,
      amountPaidCents: booking.amount_paid_cents,
      updatedAt: booking.updated_at,
    });
  });

  app.get('/reserva/:code', async (request, reply) => {
    const { code } = request.params as { code: string };
    const booking = getBookingByCode(db, code.toUpperCase());
    if (!booking) return reply.code(404).view('not-found.ejs', { title: 'Reserva no encontrada' });
    const durationMinutes = (booking.vehicle_type === 'small_suv' || booking.vehicle_type === 'large_suv') ? 45 : 30;
    return reply.view('confirmation.ejs', {
      title: `Reserva ${booking.code}`,
      business: BUSINESS,
      booking,
      vehicleLabels: VEHICLE_LABELS,
      paymentLabels: PAYMENT_LABELS,
      statusLabels: STATUS_LABELS,
      durationMinutes,
      formatMoney,
      hourLabel,
    });
  });

  app.get('/salud', async () => ({ status: 'ok', service: BUSINESS.name }));
}

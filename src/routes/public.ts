import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { BUSINESS, PAYMENT_LABELS, VEHICLE_LABELS, formatMoney, hourLabel } from '../constants.js';
import { getServicesWithPrices } from '../db.js';
import { BookingValidationError, createBooking, getBookingByCode } from '../domain/bookings.js';
import { dropoffHours, getLimaNow, isBusinessDay, isDropoffInPast, pickupHours, roundUpTo10 } from '../time.js';

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (value === undefined || value === null || value === '') return [];
  return [String(value)];
}

export async function registerPublicRoutes(app: FastifyInstance, db: Database.Database): Promise<void> {
  app.get('/', async (request, reply) => {
    const now = getLimaNow();
    const automaticDropoff = roundUpTo10(now);
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

  app.post(
    '/reservar',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = request.body as Record<string, unknown>;
      try {
        const now = getLimaNow();
        const automaticDropoff = roundUpTo10(now);
        const pickup = String(body.pickupTime || '');
        const [pickupHour, pickupMinute] = pickup.split(':').map(Number);
        const result = createBooking(db, {
          name: body.name,
          phone: body.phone,
          plate: body.plate,
          vehicleType: body.vehicleType,
          baseServiceId: body.baseServiceId,
          addonServiceIds: stringArray(body.addonServiceIds),
          dropoffHour: automaticDropoff.hour,
          dropoffMinute: automaticDropoff.minute,
          pickupHour: Number.isFinite(pickupHour) ? pickupHour : body.pickupHour,
          pickupMinute: Number.isFinite(pickupMinute) ? pickupMinute : 0,
          paymentMethod: body.paymentMethod,
          notes: body.notes,
        });
        return reply.redirect(`/reserva/${encodeURIComponent(result.code)}`);
      } catch (error) {
        const message = error instanceof BookingValidationError ? error.message : 'No pudimos registrar la reserva.';
        request.log.error(error);
        return reply.redirect(`/?error=${encodeURIComponent(message)}`);
      }
    },
  );

  app.get('/reserva/:code', async (request, reply) => {
    const { code } = request.params as { code: string };
    const booking = getBookingByCode(db, code.toUpperCase());
    if (!booking) return reply.code(404).view('not-found.ejs', { title: 'Reserva no encontrada' });
    return reply.view('confirmation.ejs', {
      title: 'Reserva confirmada',
      booking,
      vehicleLabels: VEHICLE_LABELS,
      paymentLabels: PAYMENT_LABELS,
      formatMoney,
      hourLabel,
    });
  });

  app.get('/salud', async () => ({ status: 'ok', service: BUSINESS.name }));
}

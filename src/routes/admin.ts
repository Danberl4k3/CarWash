import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import {
  BOOKING_STATUSES,
  BUSINESS,
  PAYMENT_LABELS,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  STATUS_LABELS,
  VEHICLE_LABELS,
  VEHICLE_TYPES,
  formatMoney,
  hourLabel,
} from '../constants.js';
import { assertCsrf, createSession, destroySession, getSession, verifyCredentials, type AdminSession } from '../auth.js';
import { getServicesWithPrices } from '../db.js';
import {
  BookingValidationError,
  createBooking,
  getBooking,
  getBookingServiceIds,
  listBookingsForDate,
  updateBookingByAdmin,
} from '../domain/bookings.js';
import { dropoffHours, getLimaNow, pickupHours } from '../time.js';

function failRedirect(reply: FastifyReply, path: string, message: string): FastifyReply {
  return reply.redirect(`${path}${path.includes('?') ? '&' : '?'}error=${encodeURIComponent(message)}`);
}

function okRedirect(reply: FastifyReply, path: string, message: string): FastifyReply {
  return reply.redirect(`${path}${path.includes('?') ? '&' : '?'}success=${encodeURIComponent(message)}`);
}

function queryMessages(request: FastifyRequest): { error: string | null; success: string | null } {
  const query = request.query as { error?: unknown; success?: unknown };
  return {
    error: typeof query.error === 'string' ? query.error : null,
    success: typeof query.success === 'string' ? query.success : null,
  };
}

function requireAdmin(
  db: Database.Database,
  request: FastifyRequest,
  reply: FastifyReply,
): AdminSession | null {
  const session = getSession(db, request);
  if (!session) reply.redirect('/admin/login');
  return session;
}

function requirePostAuth(
  db: Database.Database,
  request: FastifyRequest,
  reply: FastifyReply,
): AdminSession | null {
  const session = requireAdmin(db, request, reply);
  if (!session) return null;
  const body = request.body as Record<string, unknown>;
  if (!assertCsrf(session, body._csrf)) {
    reply.code(403).send('La sesión o el formulario expiró. Recarga la página.');
    return null;
  }
  return session;
}

function baseView(session: AdminSession, request: FastifyRequest) {
  return {
    admin: session,
    csrfToken: session.csrfToken,
    ...queryMessages(request),
    business: BUSINESS,
    statusLabels: STATUS_LABELS,
    paymentLabels: PAYMENT_LABELS,
    vehicleLabels: VEHICLE_LABELS,
    formatMoney,
    hourLabel,
  };
}

function normalizeArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  return value === undefined || value === '' ? [] : [String(value)];
}

export async function registerAdminRoutes(app: FastifyInstance, db: Database.Database): Promise<void> {
  app.get('/admin/login', async (request, reply) => {
    if (getSession(db, request)) return reply.redirect('/admin');
    return reply.view('admin/login.ejs', { title: 'Acceso administrativo', ...queryMessages(request) });
  });

  app.post(
    '/admin/login',
    { config: { rateLimit: { max: 8, timeWindow: '5 minutes' } } },
    async (request, reply) => {
      const body = request.body as Record<string, unknown>;
      const username = String(body.username ?? '').trim();
      const password = String(body.password ?? '');
      const admin = verifyCredentials(db, username, password);
      if (!admin) return failRedirect(reply, '/admin/login', 'Usuario o contraseña incorrectos.');
      createSession(db, reply, admin.id);
      return reply.redirect('/admin');
    },
  );

  app.get('/admin', async (request, reply) => {
    const session = requireAdmin(db, request, reply);
    if (!session) return;
    const now = getLimaNow();
    const bookings = listBookingsForDate(db, now.date);
    const pickupGroups = pickupHours().map((hour) => ({
      hour,
      label: hourLabel(hour),
      bookings: bookings.filter((booking) => booking.pickup_hour === hour),
    }));
    const summary = {
      total: bookings.filter((booking) => booking.status !== 'cancelled').length,
      pending: bookings.filter((booking) => booking.status === 'pending').length,
      inProgress: bookings.filter((booking) => booking.status === 'in_progress').length,
      completed: bookings.filter((booking) => booking.status === 'completed').length,
      collected: bookings.reduce((sum, booking) => sum + booking.amount_paid_cents, 0),
    };
    return reply.view('admin/dashboard.ejs', {
      title: 'Panel de operación',
      ...baseView(session, request),
      now,
      pickupGroups,
      summary,
    });
  });

  app.post('/admin/logout', async (request, reply) => {
    const session = requirePostAuth(db, request, reply);
    if (!session) return;
    destroySession(db, request, reply);
    return reply.redirect('/admin/login');
  });

  app.get('/admin/reservas/nueva', async (request, reply) => {
    const session = requireAdmin(db, request, reply);
    if (!session) return;
    return reply.view('admin/new-booking.ejs', {
      title: 'Nueva reserva',
      ...baseView(session, request),
      services: getServicesWithPrices(db, true),
      serviceCatalog: JSON.stringify(getServicesWithPrices(db, true)).replaceAll('<', '\\u003c'),
      dropoffSlots: dropoffHours(),
      pickupSlots: pickupHours(),
      paymentMethods: PAYMENT_METHODS,
      nowHour: getLimaNow().hour,
    });
  });

  app.post('/admin/reservas', async (request, reply) => {
    const session = requirePostAuth(db, request, reply);
    if (!session) return;
    const body = request.body as Record<string, unknown>;
    try {
      const result = createBooking(
        db,
        {
          ...body,
          addonServiceIds: normalizeArray(body.addonServiceIds),
        },
        { createdByAdmin: true, allowPastSlot: true },
      );
      return okRedirect(reply, `/admin/reservas/${result.id}`, 'Reserva creada correctamente.');
    } catch (error) {
      const message = error instanceof BookingValidationError ? error.message : 'No se pudo crear la reserva.';
      request.log.error(error);
      return failRedirect(reply, '/admin/reservas/nueva', message);
    }
  });

  app.get('/admin/reservas/:id', async (request, reply) => {
    const session = requireAdmin(db, request, reply);
    if (!session) return;
    const id = Number((request.params as { id: string }).id);
    const booking = getBooking(db, id);
    if (!booking) return reply.code(404).view('not-found.ejs', { title: 'Reserva no encontrada' });
    return reply.view('admin/booking-edit.ejs', {
      title: `Reserva ${booking.code}`,
      ...baseView(session, request),
      booking,
      statuses: BOOKING_STATUSES,
      paymentMethods: PAYMENT_METHODS,
      paymentStatuses: PAYMENT_STATUSES,
      vehicleTypes: VEHICLE_TYPES,
      services: getServicesWithPrices(db),
      serviceCatalog: JSON.stringify(getServicesWithPrices(db)).replaceAll('<', '\\u003c'),
      selectedServices: getBookingServiceIds(db, id),
      dropoffSlots: dropoffHours(),
      pickupSlots: pickupHours(),
      nowHour: getLimaNow().hour,
    });
  });

  app.post('/admin/reservas/:id', async (request, reply) => {
    const session = requirePostAuth(db, request, reply);
    if (!session) return;
    const id = Number((request.params as { id: string }).id);
    try {
      const body = request.body as Record<string, unknown>;
      updateBookingByAdmin(db, id, {
        ...body,
        addonServiceIds: normalizeArray(body.addonServiceIds),
      });
      return okRedirect(reply, `/admin/reservas/${id}`, 'Cambios guardados.');
    } catch (error) {
      const message = error instanceof BookingValidationError ? error.message : 'No se pudieron guardar los cambios.';
      request.log.error(error);
      return failRedirect(reply, `/admin/reservas/${id}`, message);
    }
  });

  app.post('/admin/reservas/:id/estado', async (request, reply) => {
    const session = requirePostAuth(db, request, reply);
    if (!session) return;
    const id = Number((request.params as { id: string }).id);
    const body = request.body as Record<string, unknown>;
    const parsed = z.enum(BOOKING_STATUSES).safeParse(body.status);
    if (!parsed.success) return failRedirect(reply, '/admin', 'Estado inválido.');
    db.prepare('UPDATE bookings SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(parsed.data, id);
    return reply.redirect('/admin');
  });

  app.post('/admin/reservas/:id/cobro', async (request, reply) => {
    const session = requirePostAuth(db, request, reply);
    if (!session) return;
    const id = Number((request.params as { id: string }).id);
    db.prepare(`UPDATE bookings SET payment_status = 'paid', amount_paid_cents = total_cents, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
    return reply.redirect('/admin');
  });

  app.get('/admin/servicios', async (request, reply) => {
    const session = requireAdmin(db, request, reply);
    if (!session) return;
    return reply.view('admin/services.ejs', {
      title: 'Servicios y precios',
      ...baseView(session, request),
      services: getServicesWithPrices(db),
      vehicleTypes: VEHICLE_TYPES,
    });
  });

  app.post('/admin/servicios/nuevo', async (request, reply) => {
    const session = requirePostAuth(db, request, reply);
    if (!session) return;
    const body = request.body as Record<string, unknown>;
    const parsed = z.object({
      name: z.string().trim().min(2).max(80),
      category: z.enum(['base', 'addon']),
    }).safeParse(body);
    if (!parsed.success) return failRedirect(reply, '/admin/servicios', 'Revisa el nombre y tipo del servicio.');
    const slug = `${parsed.data.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-')}-${Date.now()}`;
    try {
      db.transaction(() => {
        const result = db.prepare(`
          INSERT INTO services (slug, name, category, sort_order) VALUES (?, ?, ?, 999)
        `).run(slug, parsed.data.name, parsed.data.category);
        const id = Number(result.lastInsertRowid);
        const insert = db.prepare('INSERT INTO service_prices (service_id, vehicle_type, price_cents) VALUES (?, ?, 0)');
        for (const vehicleType of VEHICLE_TYPES) insert.run(id, vehicleType);
      })();
      return okRedirect(reply, '/admin/servicios', 'Servicio agregado.');
    } catch (error) {
      request.log.error(error);
      return failRedirect(reply, '/admin/servicios', 'No se pudo agregar el servicio.');
    }
  });

  app.post('/admin/servicios/:id', async (request, reply) => {
    const session = requirePostAuth(db, request, reply);
    if (!session) return;
    const id = Number((request.params as { id: string }).id);
    const body = request.body as Record<string, unknown>;
    const name = String(body.name ?? '').trim();
    if (name.length < 2 || name.length > 80) return failRedirect(reply, '/admin/servicios', 'Nombre inválido.');
    const category = body.category === 'addon' ? 'addon' : 'base';
    try {
      db.transaction(() => {
        db.prepare(`
          UPDATE services SET name = ?, category = ?, active = ?, incompatible_with_interior = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(name, category, body.active ? 1 : 0, body.incompatibleWithInterior ? 1 : 0, id);
        const upsert = db.prepare(`
          INSERT INTO service_prices (service_id, vehicle_type, price_cents) VALUES (?, ?, ?)
          ON CONFLICT(service_id, vehicle_type) DO UPDATE SET price_cents = excluded.price_cents
        `);
        for (const vehicleType of VEHICLE_TYPES) {
          const amount = Number(body[`price_${vehicleType}`] ?? 0);
          if (!Number.isFinite(amount) || amount < 0) throw new Error('Precio inválido');
          upsert.run(id, vehicleType, Math.round(amount * 100));
        }
      })();
      return okRedirect(reply, '/admin/servicios', 'Servicio actualizado.');
    } catch (error) {
      request.log.error(error);
      return failRedirect(reply, '/admin/servicios', 'Revisa los precios ingresados.');
    }
  });

  app.get('/admin/capacidad', async (request, reply) => {
    const session = requireAdmin(db, request, reply);
    if (!session) return;
    const slots = db.prepare('SELECT hour, max_slots FROM capacity_slots ORDER BY hour').all();
    return reply.view('admin/capacity.ejs', {
      title: 'Capacidad por turno',
      ...baseView(session, request),
      slots,
    });
  });

  app.post('/admin/capacidad', async (request, reply) => {
    const session = requirePostAuth(db, request, reply);
    if (!session) return;
    const body = request.body as Record<string, unknown>;
    try {
      db.transaction(() => {
        const update = db.prepare('UPDATE capacity_slots SET max_slots = ? WHERE hour = ?');
        for (const hour of dropoffHours()) {
          const value = Number(body[`capacity_${hour}`]);
          if (!Number.isInteger(value) || value < 1 || value > 50) throw new Error('Capacidad inválida');
          update.run(value, hour);
        }
      })();
      return okRedirect(reply, '/admin/capacidad', 'Capacidad actualizada.');
    } catch {
      return failRedirect(reply, '/admin/capacidad', 'Usa valores entre 1 y 50.');
    }
  });

  app.get('/admin/clientes', async (request, reply) => {
    const session = requireAdmin(db, request, reply);
    if (!session) return;
    const search = String((request.query as { q?: unknown }).q ?? '').trim();
    const like = `%${search}%`;
    const customers = db.prepare(`
      SELECT c.id, c.name, c.phone, c.notes, GROUP_CONCAT(DISTINCT v.plate) AS plates,
        COUNT(DISTINCT b.id) AS booking_count, MAX(b.booking_date) AS last_booking
      FROM customers c
      LEFT JOIN vehicles v ON v.customer_id = c.id
      LEFT JOIN bookings b ON b.customer_id = c.id
      WHERE ? = '' OR c.name LIKE ? OR c.phone LIKE ? OR v.plate LIKE ?
      GROUP BY c.id ORDER BY last_booking DESC, c.id DESC
    `).all(search, like, like, like);
    return reply.view('admin/customers.ejs', {
      title: 'Clientes',
      ...baseView(session, request),
      customers,
      search,
    });
  });

  app.get('/admin/clientes/:id', async (request, reply) => {
    const session = requireAdmin(db, request, reply);
    if (!session) return;
    const id = Number((request.params as { id: string }).id);
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
    const vehicles = db.prepare('SELECT * FROM vehicles WHERE customer_id = ? ORDER BY plate').all(id);
    const bookings = db.prepare(`
      SELECT b.*, v.plate FROM bookings b JOIN vehicles v ON v.id = b.vehicle_id
      WHERE b.customer_id = ? ORDER BY b.booking_date DESC, b.dropoff_hour DESC
    `).all(id);
    if (!customer) return reply.code(404).view('not-found.ejs', { title: 'Cliente no encontrado' });
    return reply.view('admin/customer-edit.ejs', {
      title: 'Editar cliente',
      ...baseView(session, request),
      customer,
      vehicles,
      bookings,
    });
  });

  app.post('/admin/clientes/:id', async (request, reply) => {
    const session = requirePostAuth(db, request, reply);
    if (!session) return;
    const id = Number((request.params as { id: string }).id);
    const body = request.body as Record<string, unknown>;
    const name = String(body.name ?? '').trim() || null;
    const phone = String(body.phone ?? '').trim() || null;
    const notes = String(body.notes ?? '').trim() || null;
    if (name && name.length > 200) return failRedirect(reply, `/admin/clientes/${id}`, 'El nombre es demasiado largo.');
    if (phone && !/^\+?[0-9 ()-]{7,20}$/.test(phone)) {
      return failRedirect(reply, `/admin/clientes/${id}`, 'Ingresa un teléfono válido.');
    }
    if (notes && notes.length > 2000) return failRedirect(reply, `/admin/clientes/${id}`, 'La nota es demasiado larga.');
    db.prepare(`UPDATE customers SET name = ?, phone = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(
      name,
      phone,
      notes,
      id,
    );
    return okRedirect(reply, `/admin/clientes/${id}`, 'Cliente actualizado.');
  });

  app.get('/admin/seguridad', async (request, reply) => {
    const session = requireAdmin(db, request, reply);
    if (!session) return;
    return reply.view('admin/security.ejs', {
      title: 'Seguridad',
      ...baseView(session, request),
    });
  });

  app.post('/admin/seguridad', async (request, reply) => {
    const session = requirePostAuth(db, request, reply);
    if (!session) return;
    const body = request.body as Record<string, unknown>;
    const currentPassword = String(body.currentPassword ?? '');
    const newPassword = String(body.newPassword ?? '');
    const admin = db.prepare('SELECT password_hash FROM admins WHERE id = ?').get(session.adminId) as { password_hash: string };
    if (!bcrypt.compareSync(currentPassword, admin.password_hash)) {
      return failRedirect(reply, '/admin/seguridad', 'La contraseña actual no es correcta.');
    }
    if (newPassword.length < 10) return failRedirect(reply, '/admin/seguridad', 'La nueva contraseña debe tener al menos 10 caracteres.');
    db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(newPassword, 12), session.adminId);
    return okRedirect(reply, '/admin/seguridad', 'Contraseña actualizada.');
  });
}

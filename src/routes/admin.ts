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
  checkAndAutoCompleteBookings,
  createBooking,
  getBooking,
  getBookingServiceIds,
  getDailyPaymentBreakdown,
  listBookingsForDate,
  updateBookingByAdmin,
} from '../domain/bookings.js';
import { appEvents, type AppEvent } from '../events.js';
import { allPickupHours, dropoffHours, getLimaNow } from '../time.js';

function failRedirect(reply: FastifyReply, path: string, message: string): FastifyReply {
  return reply.redirect(`${path}${path.includes('?') ? '&' : '?'}error=${encodeURIComponent(message)}`);
}

function okRedirect(reply: FastifyReply, path: string, message: string): FastifyReply {
  return reply.redirect(`${path}${path.includes('?') ? '&' : '?'}success=${encodeURIComponent(message)}`);
}

function offsetDate(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
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
    checkAndAutoCompleteBookings(db);
    const now = getLimaNow();
    const query = request.query as { date?: unknown };
    const selectedDate = typeof query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(query.date) ? query.date : now.date;
    const isToday = selectedDate === now.date;
    const prevDate = offsetDate(selectedDate, -1);
    const nextDate = offsetDate(selectedDate, 1);

    const bookings = listBookingsForDate(db, selectedDate);
    const activeHours = Array.from(new Set(bookings.map((booking) => booking.pickup_hour))).sort(
      (a, b) => a - b,
    );
    const openBookings = bookings.filter(
      (booking) => booking.status === 'pending' || booking.status === 'in_progress',
    );
    const activeCountByHour = new Map<number, number>();
    for (const booking of openBookings) {
      activeCountByHour.set(booking.pickup_hour, (activeCountByHour.get(booking.pickup_hour) ?? 0) + 1);
    }
    const pickupGroups = activeHours.map((hour) => ({
      hour,
      label: hourLabel(hour),
      bookings: bookings.filter((booking) => booking.pickup_hour === hour),
      activeCount: activeCountByHour.get(hour) ?? 0,
    }));
    const hourlySummary = pickupGroups
      .filter((group) => group.activeCount > 0)
      .map((group) => ({ hour: group.hour, label: group.label, count: group.activeCount }));
    const summary = {
      total: bookings.filter((booking) => booking.status !== 'cancelled').length,
      pending: bookings.filter((booking) => booking.status === 'pending').length,
      inProgress: bookings.filter((booking) => booking.status === 'in_progress').length,
      completed: bookings.filter((booking) => booking.status === 'completed').length,
      collected: bookings.reduce((sum, booking) => sum + booking.amount_paid_cents, 0),
      expected: bookings.reduce((sum, booking) => sum + booking.total_cents, 0),
    };

    const paymentBreakdown = getDailyPaymentBreakdown(db, selectedDate);

    const pendingBookings = bookings
      .filter((booking) => booking.status === 'pending')
      .sort((a, b) => {
        const aMin = a.dropoff_minute ?? (a.dropoff_hour * 60);
        const bMin = b.dropoff_minute ?? (b.dropoff_hour * 60);
        return aMin - bMin;
      });
    const nextBookingToEnter = pendingBookings[0] || null;

    return reply.view('admin/dashboard.ejs', {
      title: 'Panel de operación',
      ...baseView(session, request),
      now,
      selectedDate,
      isToday,
      prevDate,
      nextDate,
      pickupGroups,
      hourlySummary,
      summary,
      paymentBreakdown,
      nextBookingToEnter,
      pendingBookings,
    });
  });

  app.get('/admin/events', async (request, reply) => {
    const session = requireAdmin(db, request, reply);
    if (!session) return;

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    reply.raw.write('event: connected\ndata: {"status":"connected"}\n\n');

    const onEvent = (event: AppEvent) => {
      try {
        reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      } catch {
        // Ignorar si el socket ya está cerrado
      }
    };

    appEvents.on('app_event', onEvent);

    const keepAliveTimer = setInterval(() => {
      try {
        reply.raw.write(': ping\n\n');
      } catch {
        clearInterval(keepAliveTimer);
        appEvents.off('app_event', onEvent);
      }
    }, 15000);

    request.raw.on('close', () => {
      clearInterval(keepAliveTimer);
      appEvents.off('app_event', onEvent);
    });
  });

  app.get('/admin/export-csv', async (request, reply) => {
    const session = requireAdmin(db, request, reply);
    if (!session) return;
    const query = request.query as { date?: unknown };
    const targetDate = typeof query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(query.date) ? query.date : getLimaNow().date;
    const bookings = listBookingsForDate(db, targetDate);

    const headers = [
      'Código',
      'Fecha',
      'Ingreso',
      'Recojo',
      'Placa',
      'Tipo de Vehículo',
      'Modelo',
      'Cliente',
      'Teléfono',
      'Servicios',
      'Estado',
      'Método de Pago',
      'Estado de Pago',
      'Monto Cobrado (S/)',
      'Total (S/)',
    ];

    const escapeCsv = (val: string | number | null | undefined) => {
      if (val === null || val === undefined) return '""';
      const str = String(val).replaceAll('"', '""');
      return `"${str}"`;
    };

    const rows = bookings.map((b) =>
      [
        escapeCsv(b.code),
        escapeCsv(b.booking_date),
        escapeCsv(hourLabel(b.dropoff_hour, b.dropoff_minute === null ? 0 : b.dropoff_minute % 60)),
        escapeCsv(hourLabel(b.pickup_hour, b.pickup_minute === null ? 0 : b.pickup_minute % 60)),
        escapeCsv(b.plate),
        escapeCsv(VEHICLE_LABELS[b.vehicle_type] ?? b.vehicle_type),
        escapeCsv(b.vehicle_model || ''),
        escapeCsv(b.customer_name || 'Sin nombre'),
        escapeCsv(b.phone || ''),
        escapeCsv(b.services || ''),
        escapeCsv(STATUS_LABELS[b.status] ?? b.status),
        escapeCsv(PAYMENT_LABELS[b.payment_method] ?? b.payment_method),
        escapeCsv(b.payment_status === 'paid' ? 'Pagado' : 'Pendiente'),
        escapeCsv((b.amount_paid_cents / 100).toFixed(2)),
        escapeCsv((b.total_cents / 100).toFixed(2)),
      ].join(','),
    );

    const csvContent = '\uFEFF' + [headers.join(','), ...rows].join('\r\n');
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="carwash-reservas-${targetDate}.csv"`)
      .send(csvContent);
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
      dropoffSlots: allPickupHours(),
      pickupSlots: allPickupHours(),
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
      appEvents.emitAppEvent('booking_created', { id: result.id, code: result.code });
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
      dropoffSlots: allPickupHours(),
      pickupSlots: allPickupHours(),
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
      appEvents.emitAppEvent('booking_updated', { id });
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
    const parsedStatus = z.enum(BOOKING_STATUSES).safeParse(body.status);
    const parsedPayment = z.enum(PAYMENT_STATUSES).safeParse(body.paymentStatus);
    if (!parsedStatus.success || !parsedPayment.success) return failRedirect(reply, '/admin', 'Estado inválido.');
    
    if (parsedPayment.data === 'paid') {
      db.prepare('UPDATE bookings SET status = ?, payment_status = ?, amount_paid_cents = total_cents, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(parsedStatus.data, parsedPayment.data, id);
    } else {
      db.prepare('UPDATE bookings SET status = ?, payment_status = ?, amount_paid_cents = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(parsedStatus.data, parsedPayment.data, id);
    }
    appEvents.emitAppEvent('booking_updated', { id });
    return reply.redirect('/admin');
  });

  app.post('/admin/reservas/:id/quick-action', async (request, reply) => {
    const session = requirePostAuth(db, request, reply);
    if (!session) return;
    const id = Number((request.params as { id: string }).id);
    const body = request.body as Record<string, unknown>;
    const action = body.action;

    const booking = db.prepare('SELECT status, payment_status, total_cents FROM bookings WHERE id = ?').get(id) as { status: string, payment_status: string, total_cents: number } | undefined;
    if (!booking) return failRedirect(reply, '/admin', 'Reserva no encontrada.');

    const statusOrder = ['pending', 'in_progress', 'completed'];

    if (action === 'next_status') {
      const idx = statusOrder.indexOf(booking.status);
      if (idx !== -1 && idx < statusOrder.length - 1) {
        const nextStatus = statusOrder[idx + 1];
        if (nextStatus === 'in_progress') {
          db.prepare('UPDATE bookings SET status = ?, started_washing_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(nextStatus, new Date().toISOString(), id);
        } else {
          db.prepare('UPDATE bookings SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(nextStatus, id);
        }
      }
    } else if (action === 'start_washing') {
      db.prepare('UPDATE bookings SET status = ?, started_washing_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('in_progress', new Date().toISOString(), id);
    } else if (action === 'prev_status') {
      const idx = statusOrder.indexOf(booking.status);
      if (idx > 0) {
        const prevStatus = statusOrder[idx - 1];
        if (prevStatus === 'pending') {
          db.prepare('UPDATE bookings SET status = ?, started_washing_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(prevStatus, id);
        } else {
          db.prepare('UPDATE bookings SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(prevStatus, id);
        }
      }
    } else if (action === 'toggle_payment') {
      if (booking.payment_status === 'paid') {
        db.prepare('UPDATE bookings SET payment_status = ?, amount_paid_cents = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('pending', id);
      } else {
        db.prepare('UPDATE bookings SET payment_status = ?, amount_paid_cents = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('paid', booking.total_cents, id);
      }
    }
    appEvents.emitAppEvent('booking_updated', { id });
    return reply.redirect(`/admin#booking-${id}`);
  });

  app.get('/admin/reservas/:id/ticket', async (request, reply) => {
    const session = requireAdmin(db, request, reply);
    if (!session) return;
    const id = Number((request.params as { id: string }).id);
    const booking = getBooking(db, id);
    if (!booking) return failRedirect(reply, '/admin', 'Reserva no encontrada.');
    
    // Convert services into an array for easier rendering
    const services = booking.services ? booking.services.split(' · ') : [];
    
    return reply.view('admin/ticket.ejs', { 
      booking, 
      services,
      formatMoney: (cents: number) => `S/ ${(cents / 100).toFixed(2)}`
    });
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

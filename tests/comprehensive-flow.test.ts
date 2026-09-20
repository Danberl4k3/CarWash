import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db.js';
import {
  checkAndAutoCompleteBookings,
  createBooking,
  getBooking,
} from '../src/domain/bookings.js';
import { getLimaNow } from '../src/time.js';

describe('pruebas exhaustivas del sistema', () => {
  let app: FastifyInstance;
  let db: Database.Database;

  beforeEach(async () => {
    process.env.ADMIN_USERNAME = 'admin-test';
    process.env.ADMIN_PASSWORD = 'password-seguro-test';
    db = createDatabase(':memory:').db;
    app = await buildApp({ db, cookieSecret: 'test-cookie-secret-with-more-than-32-chars' });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
    delete process.env.ADMIN_USERNAME;
    delete process.env.ADMIN_PASSWORD;
  });

  // -------------------------------------------------------------
  // 1. PÁGINA PÚBLICA Y ORDEN DE CAMPOS (5 1 4 2 3)
  // -------------------------------------------------------------
  describe('Página pública y estructura del formulario', () => {
    it('renderiza correctamente el nuevo orden de secciones: 1 Tus datos, 2 Vehículo, 3 Horario, 4 Lavado, 5 Adicionales', async () => {
      const response = await app.inject({ method: 'GET', url: '/' });
      expect(response.statusCode).toBe(200);

      const html = response.body;

      // Verificar que los títulos aparezcan en la secuencia exacta
      const idxTusDatos = html.indexOf('Tus datos');
      const idxVehiculo = html.indexOf('¿Qué vehículo traes?');
      const idxHorario = html.indexOf('Horario');
      const idxLavado = html.indexOf('Elige el lavado');
      const idxAdicional = html.indexOf('Agrega un cuidado extra');

      expect(idxTusDatos).toBeGreaterThan(-1);
      expect(idxVehiculo).toBeGreaterThan(-1);
      expect(idxHorario).toBeGreaterThan(-1);
      expect(idxLavado).toBeGreaterThan(-1);
      expect(idxAdicional).toBeGreaterThan(-1);

      // Verificar el orden exacto: Tus datos < Vehículo < Horario < Lavado < Adicionales
      expect(idxTusDatos).toBeLessThan(idxVehiculo);
      expect(idxVehiculo).toBeLessThan(idxHorario);
      expect(idxHorario).toBeLessThan(idxLavado);
      expect(idxLavado).toBeLessThan(idxAdicional);

      // Verificar que los números sean correlativos del 1 al 5
      expect(html).toContain('<span>1</span> Tus datos');
      expect(html).toContain('<span>2</span> ¿Qué vehículo traes?');
      expect(html).toContain('<span>3</span> Horario');
      expect(html).toContain('<span>4</span> Elige el lavado');
      expect(html).toContain('<span>5</span> Agrega un cuidado extra');

      // Verificar que no queden textos de restricciones eliminadas
      expect(html).not.toContain('El teléfono es obligatorio después de las 2 p. m.');
      expect(html).not.toContain('El teléfono es necesario para reservas tardías');
      expect(html).not.toContain('La hora de recojo debe ser posterior al ingreso');

      // Verificar elementos esenciales de la UI
      expect(html).toContain('id="car-brands"');
      expect(html).toContain('theme-toggle-btn');
      expect(html).toContain('data-pickup-offset="30"');
      expect(html).toContain('data-pickup-offset="60"');
      expect(html).toContain('data-pickup-offset="90"');
      expect(html).toContain('data-pickup-offset="120"');
    });
  });

  // -------------------------------------------------------------
  // 2. CREACIÓN DE RESERVAS PÚBLICAS Y REGLAS DE NEGOCIO
  // -------------------------------------------------------------
  describe('Creación de reservas desde el formulario público (/reservar)', () => {
    it('permite registrar una reserva completa con auto y servicios adicionales', async () => {
      const exteriorId = (db.prepare('SELECT id FROM services WHERE slug = ?').get('exterior') as { id: number }).id;
      const engineId = (db.prepare('SELECT id FROM services WHERE slug = ?').get('engine') as { id: number }).id;

      const res = await app.inject({
        method: 'POST',
        url: '/reservar',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({
          plate: 'abc-789',
          name: 'carlos sanchez',
          model: 'hyundai elantra',
          phone: '+51 987 654 321',
          vehicleType: 'car',
          baseServiceId: String(exteriorId),
          addonServiceIds: String(engineId),
          pickupTime: '16:45',
          paymentMethod: 'yape',
          notes: 'Cuidado con el espejo retrovisor',
        }).toString(),
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toMatch(/^\/reserva\/DASAV-/);

      // Verificar en la BD
      const booking = db.prepare('SELECT b.*, v.plate, v.model, c.name, c.phone FROM bookings b JOIN vehicles v ON v.id = b.vehicle_id JOIN customers c ON c.id = b.customer_id').get() as any;
      expect(booking).toBeDefined();
      expect(booking.plate).toBe('ABC-789'); // Normalizado a mayúsculas
      expect(booking.model).toBe('Hyundai Elantra'); // Capitalizado
      expect(booking.name).toBe('Carlos Sanchez'); // Capitalizado
      expect(booking.phone).toBe('+51 987 654 321');
      expect(booking.pickup_hour).toBe(16);
      expect(booking.pickup_minute % 60).toBe(45);
      expect(booking.payment_method).toBe('yape');
      expect(booking.status).toBe('pending');
      expect(booking.total_cents).toBe(2500); // exterior auto 1000 + engine auto 1500 = 2500
    });

    it('permite registrar reserva con datos mínimos (sin teléfono, sin nombre, sin modelo)', async () => {
      const interiorId = (db.prepare('SELECT id FROM services WHERE slug = ?').get('interior') as { id: number }).id;

      const res = await app.inject({
        method: 'POST',
        url: '/reservar',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({
          plate: 'xyz-123',
          vehicleType: 'car',
          baseServiceId: String(interiorId),
          paymentMethod: 'cash',
        }).toString(),
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toMatch(/^\/reserva\/DASAV-/);

      const booking = db.prepare('SELECT b.*, v.plate, c.name, c.phone FROM bookings b JOIN vehicles v ON v.id = b.vehicle_id JOIN customers c ON c.id = b.customer_id').get() as any;
      expect(booking.plate).toBe('XYZ-123');
      expect(booking.name).toBeNull();
      expect(booking.phone).toBeNull();
      expect(booking.total_cents).toBe(1000);
    });

    it('permite cualquier hora de recojo (incluso antes o igual a la hora de ingreso o de noche)', async () => {
      const exteriorId = (db.prepare('SELECT id FROM services WHERE slug = ?').get('exterior') as { id: number }).id;

      const res = await app.inject({
        method: 'POST',
        url: '/reservar',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({
          plate: 'rec-001',
          vehicleType: 'car',
          baseServiceId: String(exteriorId),
          pickupTime: '06:15', // hora temprana sin restricciones
          paymentMethod: 'plin',
        }).toString(),
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toMatch(/^\/reserva\/DASAV-/);

      const booking = db.prepare('SELECT pickup_hour, pickup_minute FROM bookings WHERE code = ?').get(res.headers.location?.replace('/reserva/', '')) as any;
      expect(booking.pickup_hour).toBe(6);
      expect(booking.pickup_minute % 60).toBe(15);
    });

    it('valida formato de teléfono si el usuario lo escribe incorrecto', async () => {
      const exteriorId = (db.prepare('SELECT id FROM services WHERE slug = ?').get('exterior') as { id: number }).id;

      const res = await app.inject({
        method: 'POST',
        url: '/reservar',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({
          plate: 'tel-err',
          vehicleType: 'car',
          baseServiceId: String(exteriorId),
          phone: '123', // Demasiado corto, no es teléfono válido
          paymentMethod: 'cash',
        }).toString(),
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain('error=');
      expect(decodeURIComponent(res.headers.location || '')).toContain('teléfono válido');
    });

    it('rechaza servicio incompatible: cera con lavado interior', async () => {
      const interiorId = (db.prepare('SELECT id FROM services WHERE slug = ?').get('interior') as { id: number }).id;
      const waxId = (db.prepare('SELECT id FROM services WHERE slug = ?').get('wax') as { id: number }).id;

      const res = await app.inject({
        method: 'POST',
        url: '/reservar',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({
          plate: 'incomp-1',
          vehicleType: 'car',
          baseServiceId: String(interiorId),
          addonServiceIds: String(waxId),
          paymentMethod: 'cash',
        }).toString(),
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain('error=');
      expect(decodeURIComponent(res.headers.location || '')).toContain('cera');
    });

    it('restringe para motos solo el lavado simple y sin adicionales', async () => {
      const motorcycleWashId = (db.prepare('SELECT id FROM services WHERE slug = ?').get('motorcycle-wash') as { id: number }).id;
      const exteriorId = (db.prepare('SELECT id FROM services WHERE slug = ?').get('exterior') as { id: number }).id;
      const engineId = (db.prepare('SELECT id FROM services WHERE slug = ?').get('engine') as { id: number }).id;

      // Moto con lavado simple -> OK
      const resOk = await app.inject({
        method: 'POST',
        url: '/reservar',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({
          plate: 'moto-ok',
          vehicleType: 'motorcycle',
          baseServiceId: String(motorcycleWashId),
          paymentMethod: 'cash',
        }).toString(),
      });
      expect(resOk.statusCode).toBe(302);
      expect(resOk.headers.location).toMatch(/^\/reserva\/DASAV-/);

      // Moto con lavado no moto -> Rechazado
      const resBadBase = await app.inject({
        method: 'POST',
        url: '/reservar',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({
          plate: 'moto-bad',
          vehicleType: 'motorcycle',
          baseServiceId: String(exteriorId),
          paymentMethod: 'cash',
        }).toString(),
      });
      expect(resBadBase.statusCode).toBe(302);
      expect(decodeURIComponent(resBadBase.headers.location || '')).toContain('motos');

      // Moto con adicionales -> Rechazado
      const resBadAddon = await app.inject({
        method: 'POST',
        url: '/reservar',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({
          plate: 'moto-addon',
          vehicleType: 'motorcycle',
          baseServiceId: String(motorcycleWashId),
          addonServiceIds: String(engineId),
          paymentMethod: 'cash',
        }).toString(),
      });
      expect(resBadAddon.statusCode).toBe(302);
      expect(decodeURIComponent(resBadAddon.headers.location || '')).toContain('adicionales');
    });
  });

  // -------------------------------------------------------------
  // 3. PÁGINA DE CONFIRMACIÓN (/reserva/:code)
  // -------------------------------------------------------------
  describe('Página de confirmación y comprobante (/reserva/:code)', () => {
    it('muestra el resumen completo de la reserva y el botón de WhatsApp', async () => {
      const exteriorId = (db.prepare('SELECT id FROM services WHERE slug = ?').get('exterior') as { id: number }).id;
      const booking = createBooking(db, {
        plate: 'ABC-999',
        name: 'Maria Lopez',
        phone: '987654321',
        model: 'Kia Sportage',
        vehicleType: 'small_suv',
        baseServiceId: exteriorId,
        addonServiceIds: [],
        dropoffHour: 10,
        dropoffMinute: 15,
        pickupHour: 11,
        pickupMinute: 45,
        paymentMethod: 'yape',
        notes: 'Vehiculo con lodo',
      });

      const res = await app.inject({
        method: 'GET',
        url: `/reserva/${booking.code}`,
      });

      expect(res.statusCode).toBe(200);
      expect(res.body).toContain(booking.code);
      expect(res.body).toContain('ABC-999');
      expect(res.body).toContain('SUV pequeña');
      expect(res.body).toContain('Lavado exterior');
      expect(res.body).toContain('Yape');
      expect(res.body).toContain('15.00');
    });

    it('retorna 404 si el código de reserva no existe', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/reserva/DASAV-NOEXISTE',
      });
      expect(res.statusCode).toBe(404);
      expect(res.body).toContain('Reserva no encontrada');
    });
  });

  // -------------------------------------------------------------
  // 4. AUTENTICACIÓN Y SEGURIDAD DEL PANEL ADMINISTRATIVO
  // -------------------------------------------------------------
  describe('Seguridad y autenticación administrativa', () => {
    it('bloquea rutas protegidas sin sesión y redirige a /admin/login', async () => {
      const routes = [
        '/admin',
        '/admin/reservas/nueva',
        '/admin/clientes',
        '/admin/capacidad',
        '/admin/servicios',
        '/admin/seguridad',
      ];

      for (const route of routes) {
        const res = await app.inject({ method: 'GET', url: route });
        expect(res.statusCode).toBe(302);
        expect(res.headers.location).toBe('/admin/login');
      }
    });

    it('rechaza contraseñas inválidas en el login', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/login',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'username=admin-test&password=clave-equivocada',
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain('/admin/login?error=');
    });

    it('permite iniciar sesión con credenciales correctas', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/login',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'username=admin-test&password=password-seguro-test',
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/admin');
      const cookie = res.cookies.find((c) => c.name === 'cw_admin_session');
      expect(cookie).toBeDefined();
    });

    it('permite cerrar sesión y destruye la cookie', async () => {
      const login = await app.inject({
        method: 'POST',
        url: '/admin/login',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'username=admin-test&password=password-seguro-test',
      });
      const cookie = login.cookies[0];

      // Obtener el dashboard para leer el token CSRF
      const dash = await app.inject({
        method: 'GET',
        url: '/admin',
        headers: { cookie: `${cookie.name}=${cookie.value}` },
      });
      const csrfMatch = dash.body.match(/name="_csrf" value="([^"]+)"/);
      expect(csrfMatch).toBeTruthy();
      const csrf = csrfMatch![1];

      const logout = await app.inject({
        method: 'POST',
        url: '/admin/logout',
        headers: { cookie: `${cookie.name}=${cookie.value}`, 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({ _csrf: csrf }).toString(),
      });
      expect(logout.statusCode).toBe(302);
      expect(logout.headers.location).toBe('/admin/login');
    });
  });

  // -------------------------------------------------------------
  // 5. OPERACIONES DEL PANEL ADMINISTRATIVO
  // -------------------------------------------------------------
  describe('Operaciones del panel administrativo', () => {
    let authCookie: string;
    let csrfToken: string;

    beforeEach(async () => {
      const login = await app.inject({
        method: 'POST',
        url: '/admin/login',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'username=admin-test&password=password-seguro-test',
      });
      const cookie = login.cookies[0];
      authCookie = `${cookie.name}=${cookie.value}`;

      const dash = await app.inject({
        method: 'GET',
        url: '/admin',
        headers: { cookie: authCookie },
      });
      const match = dash.body.match(/name="_csrf" value="([^"]+)"/);
      csrfToken = match![1];
    });

    it('permite al admin crear una nueva reserva con dropoff y pickup arbitrarios', async () => {
      const exteriorId = (db.prepare('SELECT id FROM services WHERE slug = ?').get('exterior') as { id: number }).id;

      const res = await app.inject({
        method: 'POST',
        url: '/admin/reservas',
        headers: { cookie: authCookie, 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({
          _csrf: csrfToken,
          plate: 'ADM-100',
          vehicleType: 'car',
          name: 'admin cliente',
          model: 'nissan versa',
          phone: '988777666',
          baseServiceId: String(exteriorId),
          dropoffHour: '14',
          pickupHour: '10', // Cualquier hora
          paymentMethod: 'cash',
        }).toString(),
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toMatch(/\/admin\/reservas\/\d+/);

      const created = db.prepare('SELECT * FROM bookings ORDER BY id DESC LIMIT 1').get() as any;
      expect(created.dropoff_hour).toBe(14);
      expect(created.pickup_hour).toBe(10);
    });

    it('permite al admin editar una reserva y cambiar estado o monto pagado', async () => {
      const exteriorId = (db.prepare('SELECT id FROM services WHERE slug = ?').get('exterior') as { id: number }).id;
      const b = createBooking(db, {
        plate: 'EDT-200',
        vehicleType: 'car',
        baseServiceId: exteriorId,
        addonServiceIds: [],
        dropoffHour: 9,
        pickupHour: 10,
        paymentMethod: 'cash',
      });

      const res = await app.inject({
        method: 'POST',
        url: `/admin/reservas/${b.id}`,
        headers: { cookie: authCookie, 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({
          _csrf: csrfToken,
          plate: 'EDT-200',
          vehicleType: 'car',
          name: 'Cliente Editado',
          phone: '911222333',
          baseServiceId: String(exteriorId),
          dropoffHour: '9',
          pickupHour: '11',
          status: 'in_progress',
          paymentMethod: 'plin',
          paymentStatus: 'paid',
          amountPaid: '10',
          total: '10',
          notes: 'Pagado por Plin',
        }).toString(),
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain('success=');
      expect(res.headers.location).toContain('/admin?');
      expect(res.headers.location).toContain(`updated=${b.id}`);

      const updated = getBooking(db, b.id);
      expect(updated?.status).toBe('in_progress');
      expect(updated?.payment_status).toBe('paid');
      expect(updated?.amount_paid_cents).toBe(1000);
      expect(updated?.customer_name).toBe('Cliente Editado');
    });

    it('permite cambiar estado rápido con /quick-action y emitir ticket', async () => {
      const exteriorId = (db.prepare('SELECT id FROM services WHERE slug = ?').get('exterior') as { id: number }).id;
      const b = createBooking(db, {
        plate: 'QCK-001',
        vehicleType: 'car',
        baseServiceId: exteriorId,
        addonServiceIds: [],
        dropoffHour: 9,
        pickupHour: 10,
        paymentMethod: 'cash',
      });

      // Pasar a in_progress
      const nextRes = await app.inject({
        method: 'POST',
        url: `/admin/reservas/${b.id}/quick-action`,
        headers: { cookie: authCookie, 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({ _csrf: csrfToken, action: 'next_status' }).toString(),
      });
      expect(nextRes.statusCode).toBe(302);
      expect(getBooking(db, b.id)?.status).toBe('in_progress');

      // Pasar a completed
      await app.inject({
        method: 'POST',
        url: `/admin/reservas/${b.id}/quick-action`,
        headers: { cookie: authCookie, 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({ _csrf: csrfToken, action: 'next_status' }).toString(),
      });
      expect(getBooking(db, b.id)?.status).toBe('completed');

      // Cambiar estado de pago
      await app.inject({
        method: 'POST',
        url: `/admin/reservas/${b.id}/quick-action`,
        headers: { cookie: authCookie, 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({ _csrf: csrfToken, action: 'toggle_payment' }).toString(),
      });
      expect(getBooking(db, b.id)?.payment_status).toBe('paid');

      // Imprimir ticket
      const ticketRes = await app.inject({
        method: 'GET',
        url: `/admin/reservas/${b.id}/ticket`,
        headers: { cookie: authCookie },
      });
      expect(ticketRes.statusCode).toBe(200);
      expect(ticketRes.body).toContain('QCK-001');
      expect(ticketRes.body).toContain('Comprobante de Servicio');
    });

    it('busca y actualiza clientes en /admin/clientes', async () => {
      const exteriorId = (db.prepare('SELECT id FROM services WHERE slug = ?').get('exterior') as { id: number }).id;
      createBooking(db, {
        plate: 'CLI-555',
        name: 'Roberto Gómez',
        phone: '977665544',
        vehicleType: 'car',
        baseServiceId: exteriorId,
        addonServiceIds: [],
        dropoffHour: 10,
        pickupHour: 11,
        paymentMethod: 'cash',
      });

      // Búsqueda por placa
      const searchRes = await app.inject({
        method: 'GET',
        url: '/admin/clientes?q=CLI-555',
        headers: { cookie: authCookie },
      });
      expect(searchRes.statusCode).toBe(200);
      expect(searchRes.body).toContain('Roberto Gómez');
      expect(searchRes.body).toContain('CLI-555');

      // Ver detalle de cliente
      const customer = db.prepare('SELECT id FROM customers WHERE name = ?').get('Roberto Gómez') as { id: number };
      const editPage = await app.inject({
        method: 'GET',
        url: `/admin/clientes/${customer.id}`,
        headers: { cookie: authCookie },
      });
      expect(editPage.statusCode).toBe(200);
      expect(editPage.body).toContain('Editar cliente');

      // Modificar cliente
      const updateRes = await app.inject({
        method: 'POST',
        url: `/admin/clientes/${customer.id}`,
        headers: { cookie: authCookie, 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({
          _csrf: csrfToken,
          name: 'Roberto Gómez Bolaños',
          phone: '955443322',
          notes: 'Cliente VIP',
        }).toString(),
      });
      expect(updateRes.statusCode).toBe(302);

      const updatedCustomer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customer.id) as any;
      expect(updatedCustomer.name).toBe('Roberto Gómez Bolaños');
      expect(updatedCustomer.phone).toBe('955443322');
      expect(updatedCustomer.notes).toBe('Cliente VIP');
    });

    it('actualiza la capacidad por hora en /admin/capacidad', async () => {
      const payload: Record<string, string> = { _csrf: csrfToken };
      for (let h = 7; h <= 17; h++) {
        payload[`capacity_${h}`] = '8';
      }

      const res = await app.inject({
        method: 'POST',
        url: '/admin/capacidad',
        headers: { cookie: authCookie, 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams(payload).toString(),
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain('success=');

      const slot = db.prepare('SELECT max_slots FROM capacity_slots WHERE hour = 10').get() as { max_slots: number };
      expect(slot.max_slots).toBe(8);
    });

    it('agrega un nuevo servicio y actualiza sus precios en /admin/servicios', async () => {
      // Agregar nuevo servicio
      const addRes = await app.inject({
        method: 'POST',
        url: '/admin/servicios/nuevo',
        headers: { cookie: authCookie, 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({
          _csrf: csrfToken,
          name: 'Desinfección Ozono',
          category: 'addon',
        }).toString(),
      });
      expect(addRes.statusCode).toBe(302);
      expect(addRes.headers.location).toContain('success=');

      const service = db.prepare('SELECT * FROM services WHERE name = ?').get('Desinfección Ozono') as any;
      expect(service).toBeDefined();
      expect(service.category).toBe('addon');

      // Actualizar precios del nuevo servicio
      const updatePriceRes = await app.inject({
        method: 'POST',
        url: `/admin/servicios/${service.id}`,
        headers: { cookie: authCookie, 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({
          _csrf: csrfToken,
          name: 'Desinfección Ozono Premium',
          category: 'addon',
          active: '1',
          price_motorcycle: '10',
          price_car: '20',
          price_small_suv: '25',
          price_large_suv: '30',
        }).toString(),
      });
      expect(updatePriceRes.statusCode).toBe(302);

      const updatedService = db.prepare('SELECT * FROM services WHERE id = ?').get(service.id) as any;
      expect(updatedService.name).toBe('Desinfección Ozono Premium');

      const priceCar = db.prepare('SELECT price_cents FROM service_prices WHERE service_id = ? AND vehicle_type = ?').get(service.id, 'car') as any;
      expect(priceCar.price_cents).toBe(2000);
    });

    it('permite eliminar un servicio duplicado o no deseado en /admin/servicios/:id/eliminar', async () => {
      // 1. Crear servicio duplicado
      await app.inject({
        method: 'POST',
        url: '/admin/servicios/nuevo',
        headers: { cookie: authCookie, 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({
          _csrf: csrfToken,
          name: 'Servicio Duplicado Temporal',
          category: 'base',
        }).toString(),
      });

      const dupe = db.prepare('SELECT * FROM services WHERE name = ?').get('Servicio Duplicado Temporal') as any;
      expect(dupe).toBeDefined();

      // 2. Eliminar el servicio
      const delRes = await app.inject({
        method: 'POST',
        url: `/admin/servicios/${dupe.id}/eliminar`,
        headers: { cookie: authCookie, 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({ _csrf: csrfToken }).toString(),
      });

      expect(delRes.statusCode).toBe(302);
      expect(delRes.headers.location).toContain('/admin/servicios');
      expect(delRes.headers.location).toContain('success=');

      // 3. Comprobar que ya no existe en la base de datos ni en precios
      const deletedService = db.prepare('SELECT * FROM services WHERE id = ?').get(dupe.id);
      expect(deletedService).toBeUndefined();

      const prices = db.prepare('SELECT * FROM service_prices WHERE service_id = ?').all(dupe.id);
      expect(prices.length).toBe(0);
    });

    it('actualiza la contraseña del administrador en /admin/seguridad', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/seguridad',
        headers: { cookie: authCookie, 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({
          _csrf: csrfToken,
          currentPassword: 'password-seguro-test',
          newPassword: 'nueva-clave-super-segura-2026',
        }).toString(),
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain('success=');

      // Verificar que se puede iniciar sesión con la nueva contraseña
      const newLogin = await app.inject({
        method: 'POST',
        url: '/admin/login',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'username=admin-test&password=nueva-clave-super-segura-2026',
      });
      expect(newLogin.statusCode).toBe(302);
      expect(newLogin.headers.location).toBe('/admin');
    });
  });
});

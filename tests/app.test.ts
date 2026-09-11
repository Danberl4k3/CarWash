import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createDatabase } from "../src/db.js";
import { createBooking } from "../src/domain/bookings.js";
import { getLimaNow } from "../src/time.js";

describe("aplicación web", () => {
  let app: FastifyInstance;
  let db: Database.Database;

  beforeEach(async () => {
    process.env.ADMIN_USERNAME = "admin-test";
    process.env.ADMIN_PASSWORD = "password-seguro-test";
    db = createDatabase(":memory:").db;
    app = await buildApp({
      db,
      cookieSecret: "test-cookie-secret-with-more-than-32-chars",
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
    delete process.env.ADMIN_USERNAME;
    delete process.env.ADMIN_PASSWORD;
  });

  it("renderiza el formulario público", async () => {
    const response = await app.inject({ method: "GET", url: "/" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Separa tu turno");
    expect(response.body).toContain("Lavado completo");
    expect(response.headers["content-security-policy"]).toContain(
      "default-src 'self'",
    );
  });

  it("expone un endpoint de salud", async () => {
    const response = await app.inject({ method: "GET", url: "/salud" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ok",
      service: "DASAV Car Wash",
    });
  });

  it("reutiliza los datos locales de una placa sin consultar JSON.pe", async () => {
    db.prepare(
      `
      INSERT INTO vehicles (plate, vehicle_type, marca, modelo, color, anio, propietario)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    ).run("ABC-123", "car", "Toyota", "Hilux", "Blanco", 2020, "Juan Pérez");

    const response = await app.inject({
      method: "GET",
      url: "/api/vehiculos/ABC123",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      success: true,
      source: "local",
      data: {
        marca: "Toyota",
        modelo: "Hilux",
        color: "Blanco",
        anio: 2020,
        propietario: "Juan Pérez",
      },
    });
  });

  it("protege el panel y permite iniciar sesión", async () => {
    const anonymous = await app.inject({ method: "GET", url: "/admin" });
    expect(anonymous.statusCode).toBe(302);
    expect(anonymous.headers.location).toBe("/admin/login");

    const login = await app.inject({
      method: "POST",
      url: "/admin/login",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "username=admin-test&password=password-seguro-test",
    });
    expect(login.statusCode).toBe(302);
    const cookie = login.cookies[0];
    expect(cookie?.name).toBe("cw_admin_session");

    const dashboard = await app.inject({
      method: "GET",
      url: "/admin",
      headers: { cookie: `${cookie.name}=${cookie.value}` },
    });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.body).toContain("Panel de recojos");
    expect(dashboard.body).toContain("5:00 p. m.");
  });

  it("refleja en el panel una reserva creada para hoy", async () => {
    const serviceId = (
      db.prepare("SELECT id FROM services WHERE slug = ?").get("exterior") as {
        id: number;
      }
    ).id;
    const now = getLimaNow();
    createBooking(
      db,
      {
        plate: "TAB-001",
        vehicleType: "car",
        baseServiceId: serviceId,
        addonServiceIds: [],
        dropoffHour: 7,
        pickupHour: 8,
        paymentMethod: "cash",
        phone: "999999999",
        name: "Panel test",
        notes: "",
      },
      { now: { ...now, weekday: "Mon" }, allowPastSlot: true },
    );
    const login = await app.inject({
      method: "POST",
      url: "/admin/login",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "username=admin-test&password=password-seguro-test",
    });
    const cookie = login.cookies[0];
    const dashboard = await app.inject({
      method: "GET",
      url: "/admin",
      headers: { cookie: `${cookie.name}=${cookie.value}` },
    });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.body).toContain("TAB-001");
    expect(dashboard.body).toContain("Panel test");
  });
  it("processes payment with valid csrf and idempotently marks as paid", async () => {
    const serviceId = (
      db.prepare("SELECT id FROM services WHERE slug = ?").get("exterior") as {
        id: number;
      }
    ).id;
    const now = getLimaNow();
    const booking = createBooking(
      db,
      {
        plate: "TAB-001",
        vehicleType: "car",
        baseServiceId: serviceId,
        addonServiceIds: [],
        dropoffHour: 7,
        pickupHour: 8,
        paymentMethod: "cash",
        phone: "999999999",
        name: "Panel test",
        notes: "",
      },
      { now: { ...now, weekday: "Mon" }, allowPastSlot: true },
    );

    const loginRes = await app.inject({
      method: "POST",
      url: "/admin/login",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "username=admin-test&password=password-seguro-test",
    });
    const sessionCookie = loginRes.cookies[0];
    const cookie = sessionCookie.name + "=" + sessionCookie.value;

    const dashboardRes = await app.inject({
      method: "GET",
      url: "/admin",
      headers: { cookie: cookie },
    });
    const csrfMatch = dashboardRes.body.match(/name="_csrf" value="([^"]+)"/);
    const csrf = csrfMatch ? csrfMatch[1] : "";

    // Unauthorized without cookie
    const unauthRes = await app.inject({
      method: "POST",
      url: `/admin/reservas/${booking.id}/cobro`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: `_csrf=${csrf}`,
    });
    expect(unauthRes.statusCode).toBe(302);
    expect(
      (
        db
          .prepare("SELECT payment_status FROM bookings WHERE id = ?")
          .get(booking.id) as { payment_status: string }
      ).payment_status,
    ).toBe("pending");

    // Bad CSRF
    const badCsrfRes = await app.inject({
      method: "POST",
      url: `/admin/reservas/${booking.id}/cobro`,
      headers: {
        cookie: cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: "_csrf=invalid-token",
    });
    expect(badCsrfRes.statusCode).toBe(403);
    expect(
      (
        db
          .prepare("SELECT payment_status FROM bookings WHERE id = ?")
          .get(booking.id) as { payment_status: string }
      ).payment_status,
    ).toBe("pending");

    // Valid payment
    const payRes = await app.inject({
      method: "POST",
      url: `/admin/reservas/${booking.id}/cobro`,
      headers: {
        cookie: cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: `_csrf=${csrf}`,
    });
    expect(payRes.statusCode).toBe(302);

    const bookingRow = db
      .prepare(
        "SELECT payment_status, amount_paid_cents, total_cents FROM bookings WHERE id = ?",
      )
      .get(booking.id) as {
      payment_status: string;
      amount_paid_cents: number;
      total_cents: number;
    };
    expect(bookingRow.payment_status).toBe("paid");
    expect(bookingRow.amount_paid_cents).toBe(bookingRow.total_cents);

    // Idempotent second payment
    const payRes2 = await app.inject({
      method: "POST",
      url: `/admin/reservas/${booking.id}/cobro`,
      headers: {
        cookie: cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: `_csrf=${csrf}`,
    });
    expect(payRes2.statusCode).toBe(302);
    const bookingRow2 = db
      .prepare(
        "SELECT payment_status, amount_paid_cents, total_cents FROM bookings WHERE id = ?",
      )
      .get(booking.id) as {
      payment_status: string;
      amount_paid_cents: number;
      total_cents: number;
    };
    expect(bookingRow2.payment_status).toBe("paid");
    expect(bookingRow2.amount_paid_cents).toBe(bookingRow2.total_cents);

    // Dashboard reflects paid
    const dashboardAfter = await app.inject({
      method: "GET",
      url: "/admin",
      headers: { cookie: cookie },
    });
    expect(dashboardAfter.body).toContain("Pagado");
    expect(dashboardAfter.body).not.toContain("Marcar como pagado");
  });

  it("renders wash queue in pickup time order and advances on status change", async () => {
    const serviceId = (
      db.prepare("SELECT id FROM services WHERE slug = ?").get("exterior") as {
        id: number;
      }
    ).id;
    const now = getLimaNow();

    const booking9 = createBooking(
      db,
      {
        plate: "QUE-009",
        vehicleType: "car",
        baseServiceId: serviceId,
        addonServiceIds: [],
        dropoffHour: 7,
        pickupHour: 9,
        paymentMethod: "cash",
        phone: "999999999",
        name: "Queue 9",
        notes: "",
      },
      { now: { ...now, weekday: "Mon" }, allowPastSlot: true },
    );

    const booking8 = createBooking(
      db,
      {
        plate: "QUE-008",
        vehicleType: "car",
        baseServiceId: serviceId,
        addonServiceIds: [],
        dropoffHour: 7,
        pickupHour: 8,
        paymentMethod: "cash",
        phone: "999999998",
        name: "Queue 8",
        notes: "",
      },
      { now: { ...now, weekday: "Mon" }, allowPastSlot: true },
    );

    const booking10 = createBooking(
      db,
      {
        plate: "QUE-010",
        vehicleType: "car",
        baseServiceId: serviceId,
        addonServiceIds: [],
        dropoffHour: 7,
        pickupHour: 10,
        paymentMethod: "cash",
        phone: "999999997",
        name: "Queue 10",
        notes: "",
      },
      { now: { ...now, weekday: "Mon" }, allowPastSlot: true },
    );

    const completedBooking = createBooking(
      db,
      {
        plate: "QUE-004",
        vehicleType: "car",
        baseServiceId: serviceId,
        addonServiceIds: [],
        dropoffHour: 7,
        pickupHour: 8,
        paymentMethod: "cash",
        phone: "999999996",
        name: "Completed",
        notes: "",
      },
      { now: { ...now, weekday: "Mon" }, allowPastSlot: true },
    );
    db.prepare("UPDATE bookings SET status = ? WHERE id = ?").run(
      "completed",
      completedBooking.id,
    );

    const inProgressBooking = createBooking(
      db,
      {
        plate: "QUE-005",
        vehicleType: "car",
        baseServiceId: serviceId,
        addonServiceIds: [],
        dropoffHour: 7,
        pickupHour: 8,
        paymentMethod: "cash",
        phone: "999999995",
        name: "In Progress",
        notes: "",
      },
      { now: { ...now, weekday: "Mon" }, allowPastSlot: true },
    );
    db.prepare("UPDATE bookings SET status = ? WHERE id = ?").run(
      "in_progress",
      inProgressBooking.id,
    );

    const loginRes = await app.inject({
      method: "POST",
      url: "/admin/login",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "username=admin-test&password=password-seguro-test",
    });
    const sessionCookie = loginRes.cookies[0];
    const cookie = sessionCookie.name + "=" + sessionCookie.value;

    const dashboardRes = await app.inject({
      method: "GET",
      url: "/admin",
      headers: { cookie: cookie },
    });

    const queueMatch = dashboardRes.body.match(
      /<section\b[^>]*data-wash-queue[^>]*>[\s\S]*?<\/section>/,
    );
    expect(queueMatch).toBeTruthy();
    const queueHtml = queueMatch ? queueMatch[0] : "";

    const pos8 = queueHtml.indexOf("QUE-008");
    const pos9 = queueHtml.indexOf("QUE-009");
    const pos10 = queueHtml.indexOf("QUE-010");

    expect(pos8).toBeGreaterThan(-1);
    expect(pos9).toBeGreaterThan(-1);
    expect(pos10).toBeGreaterThan(-1);
    expect(pos8).toBeLessThan(pos9);
    expect(pos9).toBeLessThan(pos10);

    expect(queueHtml).not.toContain("QUE-004");
    expect(queueHtml).not.toContain("QUE-005");

    // Move first queue item to in_progress
    const dashForCsrf = await app.inject({
      method: "GET",
      url: "/admin",
      headers: { cookie: cookie },
    });
    const csrfMatch = dashForCsrf.body.match(/name="_csrf" value="([^"]+)"/);
    const csrf = csrfMatch ? csrfMatch[1] : "";

    const statusRes = await app.inject({
      method: "POST",
      url: `/admin/reservas/${booking8.id}/estado`,
      headers: {
        cookie: cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: `_csrf=${csrf}&status=in_progress`,
    });
    expect(statusRes.statusCode).toBe(302);

    const queueAfter = await app.inject({
      method: "GET",
      url: "/admin",
      headers: { cookie: cookie },
    });
    const queueMatchAfter = queueAfter.body.match(
      /<section\b[^>]*data-wash-queue[^>]*>[\s\S]*?<\/section>/,
    );
    expect(queueMatchAfter).toBeTruthy();
    const queueHtmlAfter = queueMatchAfter ? queueMatchAfter[0] : "";

    const pos8After = queueHtmlAfter.indexOf("QUE-008");
    const pos9After = queueHtmlAfter.indexOf("QUE-009");
    const pos10After = queueHtmlAfter.indexOf("QUE-010");

    expect(pos8After).toBe(-1);
    expect(pos9After).toBeGreaterThan(-1);
    expect(pos10After).toBeGreaterThan(-1);
    expect(pos9After).toBeLessThan(pos10After);

    const paymentRow = db
      .prepare("SELECT payment_status FROM bookings WHERE id = ?")
      .get(booking8.id) as { payment_status: string };
    expect(paymentRow.payment_status).toBe("pending");

    const inProgressRow = db
      .prepare("SELECT status FROM bookings WHERE id = ?")
      .get(booking8.id) as { status: string };
    expect(inProgressRow.status).toBe("in_progress");
  });
});

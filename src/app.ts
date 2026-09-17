import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import view from '@fastify/view';
import ejs from 'ejs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { cleanupExpiredSessions } from './db.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerPublicRoutes } from './routes/public.js';
import { checkAndAutoCompleteBookings } from './domain/bookings.js';

export interface BuildAppOptions {
  db: Database.Database;
  logger?: boolean;
  cookieSecret?: string;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    trustProxy: process.env.TRUST_PROXY === 'true' || Boolean(process.env.RAILWAY_ENVIRONMENT) || process.env.NODE_ENV === 'production',
    bodyLimit: 10 * 1024 * 1024,
  });
  const cookieSecret = options.cookieSecret ?? process.env.COOKIE_SECRET ?? randomBytes(32).toString('hex');

  await app.register(cookie, { secret: cookieSecret, hook: 'onRequest' });
  await app.register(formbody);
  await app.register(rateLimit, { global: false });
  await app.register(fastifyStatic, {
    root: resolve('public'),
    prefix: '/public/',
    cacheControl: process.env.NODE_ENV === 'production',
    maxAge: process.env.NODE_ENV === 'production' ? '7d' : 0,
  });
  await app.register(view, {
    engine: { ejs },
    root: resolve('views'),
    includeViewExtension: true,
  });

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
    if (process.env.NODE_ENV === 'production') reply.header('Strict-Transport-Security', 'max-age=31536000');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; form-action 'self'; frame-ancestors 'none'",
    );
    return payload;
  });

  await registerPublicRoutes(app, options.db);
  await registerAdminRoutes(app, options.db);

  app.setNotFoundHandler(async (_request, reply) => {
    return reply.code(404).view('not-found.ejs', { title: 'Página no encontrada' });
  });
  app.setErrorHandler(async (error, request, reply) => {
    request.log.error(error);
    if (reply.sent) return;
    return reply.code(500).view('error.ejs', { title: 'Ocurrió un problema' });
  });

  const runMaintenance = (): void => {
    try {
      checkAndAutoCompleteBookings(options.db);
      cleanupExpiredSessions(options.db);
    } catch (error) {
      app.log.error({ err: error }, 'No se pudo ejecutar el mantenimiento automatico');
    }
  };

  // Ejecuta una vez al arrancar y vuelve a hacerlo cada 10 segundos mientras
  // el servidor permanezca activo. La tarea actual es sincrona, por lo que
  // una ejecucion termina antes de que pueda comenzar la siguiente.
  runMaintenance();
  const autoTimer = setInterval(runMaintenance, 10000);
  autoTimer.unref();

  app.addHook('onClose', async () => {
    clearInterval(autoTimer);
  });

  return app;
}

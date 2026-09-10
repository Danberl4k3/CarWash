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
import { registerAdminRoutes } from './routes/admin.js';
import { registerPublicRoutes } from './routes/public.js';

export interface BuildAppOptions {
  db: Database.Database;
  logger?: boolean;
  cookieSecret?: string;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false, trustProxy: true });
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
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; style-src 'self'; script-src 'self' https://cdn.jsdelivr.net; connect-src 'self' https://cdn.jsdelivr.net https://tessdata.projectnaptha.com; worker-src 'self' blob:; img-src 'self' data: blob:; font-src 'self'; form-action 'self'; frame-ancestors 'none'",
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
  return app;
}

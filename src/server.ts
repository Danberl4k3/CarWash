import 'dotenv/config';
import { buildApp } from './app.js';
import { createDatabase } from './db.js';

const database = createDatabase();
const app = await buildApp({ db: database.db, logger: true });
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';

try {
  await app.listen({ port, host });
  if (database.bootstrapPassword) {
    const username = process.env.ADMIN_USERNAME?.trim() || 'admin';
    app.log.warn('PRIMER ACCESO ADMINISTRATIVO');
    app.log.warn(`Usuario: ${username}`);
    app.log.warn(`Contraseña temporal: ${database.bootstrapPassword}`);
    app.log.warn('Cámbiala en Administración > Seguridad después de ingresar.');
  }
} catch (error) {
  app.log.error(error);
  database.db.close();
  process.exit(1);
}

const shutdown = async () => {
  await app.close();
  database.db.close();
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Debe cargarse antes de dotenv para que America/Lima sea la zona horaria
// efectiva del proceso, aunque el host tenga otra configuracion.
import './timezone.js';
import 'dotenv/config';
import { buildApp } from './app.js';
import { createDatabase } from './db.js';

const database = createDatabase();
const app = await buildApp({ db: database.db, logger: true });
app.log.info(`[DB] Base de datos activa en: ${database.path}`);
if (process.env.NODE_ENV === 'production' && !database.path.startsWith('/data') && !process.env.RAILWAY_VOLUME_MOUNT_PATH) {
  app.log.warn('[DB] ⚠️ ADVERTENCIA: La base de datos está en disco efímero. Para no perder datos en cada actualización, añade un Railway Volume en /data con DATABASE_PATH=/data/carwash.db');
}

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST ?? (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');

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

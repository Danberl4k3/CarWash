import Database from 'better-sqlite3';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import 'dotenv/config';

const sourceBackupPath = process.argv[2];

if (!sourceBackupPath) {
  console.error('[RESTORE] Uso: node scripts/restore.mjs <ruta-al-archivo-backup.db>');
  process.exit(1);
}

const resolvedSource = resolve(sourceBackupPath);
const targetDbPath = resolve(process.env.DATABASE_PATH ?? (process.env.RAILWAY_VOLUME_MOUNT_PATH ? join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'carwash.db') : './data/carwash.db'));
if (resolvedSource.toLowerCase() === targetDbPath.toLowerCase()) throw new Error('El origen y el destino deben ser distintos.');

if (!existsSync(resolvedSource)) {
  console.error(`[RESTORE] ✗ El archivo de backup no existe: ${resolvedSource}`);
  process.exit(1);
}

console.log(`[RESTORE] Origen: ${resolvedSource}`);
console.log(`[RESTORE] Destino: ${targetDbPath}`);

let sourceDb;
try {
  // 1. Validate SQLite integrity of source backup
  sourceDb = new Database(resolvedSource, { fileMustExist: true, readonly: true });
  const integrity = sourceDb.pragma('integrity_check');
  if (!Array.isArray(integrity) || integrity[0]?.integrity_check !== 'ok') {
    throw new Error('La verificación de integridad de la base de datos de origen falló.');
  }
  
  if (sourceDb.pragma('foreign_key_check').length) throw new Error('El backup contiene referencias inválidas.');
  const tables = ['admins', 'services', 'service_prices', 'capacity_slots', 'customers', 'vehicles', 'bookings', 'booking_services'];
  console.log('[RESTORE] Contenido detectado en origen:');
  for (const t of tables) {
    const count = sourceDb.prepare(`SELECT COUNT(*) as count FROM ${t}`).get().count;
    console.log(`  - ${t}: ${count} registros`);
  }

  // 2. Ensure target directory exists
  mkdirSync(dirname(targetDbPath), { recursive: true });

  // Preserve a rollback copy and restore through SQLite, including active WAL databases.
  if (existsSync(targetDbPath)) {
    const rollbackDir = join(dirname(targetDbPath), 'backups');
    mkdirSync(rollbackDir, { recursive: true });
    const targetDb = new Database(targetDbPath, { fileMustExist: true });
    try {
      await targetDb.backup(join(rollbackDir, `before_restore_${new Date().toISOString().replace(/[:.]/g, '-')}.db`));
    } finally { targetDb.close(); }
  }
  await sourceDb.backup(targetDbPath);

  const stats = statSync(targetDbPath);
  console.log(`[RESTORE] ✓ Base de datos restaurada correctamente en ${targetDbPath} (${(stats.size / 1024).toFixed(1)} KB)`);
} catch (error) {
  console.error('[RESTORE] ✗ Error al restaurar:', error.message);
  process.exitCode = 1;
} finally {
  sourceDb?.close();
}


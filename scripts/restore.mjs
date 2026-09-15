import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import 'dotenv/config';

const sourceBackupPath = process.argv[2];

if (!sourceBackupPath) {
  console.error('[RESTORE] Uso: node scripts/restore.mjs <ruta-al-archivo-backup.db>');
  process.exit(1);
}

const resolvedSource = resolve(sourceBackupPath);
const targetDbPath = resolve(process.env.DATABASE_PATH ?? './data/carwash.db');

if (!existsSync(resolvedSource)) {
  console.error(`[RESTORE] ✗ El archivo de backup no existe: ${resolvedSource}`);
  process.exit(1);
}

console.log(`[RESTORE] Origen: ${resolvedSource}`);
console.log(`[RESTORE] Destino: ${targetDbPath}`);

try {
  // 1. Validate SQLite integrity of source backup
  const sourceDb = new Database(resolvedSource, { fileMustExist: true });
  const integrity = sourceDb.pragma('integrity_check');
  if (!Array.isArray(integrity) || integrity[0]?.integrity_check !== 'ok') {
    throw new Error('La verificación de integridad de la base de datos de origen falló.');
  }
  
  const tables = ['admins', 'services', 'service_prices', 'capacity_slots', 'customers', 'vehicles', 'bookings'];
  console.log('[RESTORE] Contenido detectado en origen:');
  for (const t of tables) {
    try {
      const count = sourceDb.prepare(`SELECT COUNT(*) as count FROM ${t}`).get().count;
      console.log(`  - ${t}: ${count} registros`);
    } catch {
      // table might not exist in an older schema
    }
  }
  sourceDb.close();

  // 2. Ensure target directory exists
  mkdirSync(dirname(targetDbPath), { recursive: true });

  // 3. Copy backup file to target
  copyFileSync(resolvedSource, targetDbPath);

  const stats = statSync(targetDbPath);
  console.log(`[RESTORE] ✓ Base de datos restaurada correctamente en ${targetDbPath} (${(stats.size / 1024).toFixed(1)} KB)`);
} catch (error) {
  console.error('[RESTORE] ✗ Error al restaurar:', error.message);
  process.exit(1);
}

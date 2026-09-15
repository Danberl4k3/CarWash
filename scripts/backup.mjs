import Database from 'better-sqlite3';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import 'dotenv/config';

const dbPath = process.env.DATABASE_PATH ?? './data/carwash.db';
const resolvedDbPath = resolve(dbPath);

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const defaultBackupPath = resolve(`./data/backups/carwash_backup_${timestamp}.db`);
const targetBackupPath = resolve(process.argv[2] ?? defaultBackupPath);

mkdirSync(dirname(targetBackupPath), { recursive: true });

console.log(`[BACKUP] Origen: ${resolvedDbPath}`);
console.log(`[BACKUP] Destino: ${targetBackupPath}`);

try {
  const db = new Database(resolvedDbPath, { fileMustExist: true });
  // Checkpoint WAL data into the main database file
  db.pragma('wal_checkpoint(TRUNCATE)');
  
  // Perform safe hot backup
  await db.backup(targetBackupPath);
  db.close();

  const stats = statSync(targetBackupPath);
  console.log(`[BACKUP] ✓ Copia completada exitosamente (${(stats.size / 1024).toFixed(1)} KB)`);
} catch (error) {
  console.error('[BACKUP] ✗ Error al realizar backup:', error.message);
  process.exit(1);
}

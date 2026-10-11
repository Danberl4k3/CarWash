import Database from 'better-sqlite3';
import { mkdirSync, statSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import 'dotenv/config';

const dbPath = process.env.DATABASE_PATH ?? (process.env.RAILWAY_VOLUME_MOUNT_PATH ? join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'carwash.db') : './data/carwash.db');
const resolvedDbPath = resolve(dbPath);

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const defaultBackupPath = join(dirname(resolvedDbPath), 'backups', `carwash_backup_${timestamp}.db`);
const targetBackupPath = resolve(process.argv[2] ?? defaultBackupPath);
if (targetBackupPath.toLowerCase() === resolvedDbPath.toLowerCase()) throw new Error('El backup debe tener una ruta distinta de la base de datos.');

const backupDir = dirname(targetBackupPath);
mkdirSync(backupDir, { recursive: true });

console.log(`[BACKUP] Origen: ${resolvedDbPath}`);
console.log(`[BACKUP] Destino: ${targetBackupPath}`);

try {
  const db = new Database(resolvedDbPath, { fileMustExist: true });
  // Perform safe hot backup
  await db.backup(targetBackupPath);
  db.close();

  const stats = statSync(targetBackupPath);
  console.log(`[BACKUP] ✓ Copia completada exitosamente (${(stats.size / 1024).toFixed(1)} KB)`);

  // Política de retención: mantener los 14 backups más recientes
  const MAX_BACKUPS = 14;
  const backupFiles = readdirSync(backupDir)
    .filter((file) => file.startsWith('carwash_backup_') && file.endsWith('.db'))
    .map((file) => {
      const filePath = join(backupDir, file);
      return { file, path: filePath, mtime: statSync(filePath).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);

  if (backupFiles.length > MAX_BACKUPS) {
    const toDelete = backupFiles.slice(MAX_BACKUPS);
    for (const item of toDelete) {
      try {
        unlinkSync(item.path);
        console.log(`[BACKUP] 🗑️ Backup antiguo purgado: ${item.file}`);
      } catch (err) {
        console.warn(`[BACKUP] No se pudo eliminar ${item.file}:`, err.message);
      }
    }
  }
} catch (error) {
  console.error('[BACKUP] ✗ Error al realizar backup:', error.message);
  process.exit(1);
}


// SPDX-License-Identifier: GPL-3.0-or-later
//
// Background housekeeping, run hourly:
//  - remove expired sessions
//  - nightly automatic backup to BACKUP_DIR (if set), keeping the newest N
//  - delete old finished exams when a retention period is configured

import fs from 'node:fs';
import path from 'node:path';
import { query } from './db.js';
import { getSettings } from './settings.js';
import { writeBackup } from './backup.js';
import { audit } from './audit.js';

const BACKUP_DIR = process.env.BACKUP_DIR || '';
const BACKUP_HOUR = Number(process.env.BACKUP_HOUR ?? 2);
const BACKUP_KEEP = Number(process.env.BACKUP_KEEP ?? 14);

export function backupFiles() {
  if (!BACKUP_DIR || !fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .filter(f => /^sonoforms-.*\.sfbak$/.test(f))
    .map(f => ({ name: f, size: fs.statSync(path.join(BACKUP_DIR, f)).size, mtime: fs.statSync(path.join(BACKUP_DIR, f)).mtime }))
    .sort((a, b) => b.mtime - a.mtime);
}

export async function backupToDir(log = console) {
  if (!BACKUP_DIR) throw new Error('BACKUP_DIR is not set');
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const file = path.join(BACKUP_DIR, `sonoforms-${stamp}.sfbak`);
  const tmp = `${file}.partial`;
  const out = fs.createWriteStream(tmp, { mode: 0o600 });
  const result = await writeBackup(out);
  await new Promise((resolve, reject) => out.end(err => (err ? reject(err) : resolve())));
  fs.renameSync(tmp, file);
  for (const old of backupFiles().slice(BACKUP_KEEP)) fs.unlinkSync(path.join(BACKUP_DIR, old.name));
  log.info(`Backup written to ${file} (${result.rows} rows)`);
  await audit({ action: 'system.backup', institutionId: null, details: { file: path.basename(file), rows: result.rows } });
  return { file: path.basename(file), ...result };
}

export async function purgeOldExams(log = console) {
  const { retention_days: days } = await getSettings();
  if (!days || days <= 0) return 0;
  const r = await query(
    `DELETE FROM exams WHERE status IN ('dictated', 'cancelled') AND updated_at < now() - make_interval(days => $1)`, [days]);
  const p = await query('DELETE FROM patients p WHERE NOT EXISTS (SELECT 1 FROM exams e WHERE e.patient_id = p.id) AND p.updated_at < now() - make_interval(days => $1)', [days]);
  if (r.rowCount || p.rowCount) {
    log.info(`Retention: deleted ${r.rowCount} exams and ${p.rowCount} patients older than ${days} days`);
    await audit({ action: 'system.retention_purge', institutionId: null, details: { exams: r.rowCount, patients: p.rowCount, days } });
  }
  return r.rowCount;
}

let lastBackupDay = null;

export function startMaintenance(log = console) {
  const run = async () => {
    try {
      await query('DELETE FROM sessions WHERE expires_at < now()');
      await purgeOldExams(log);
      const now = new Date();
      const day = now.toDateString();
      if (BACKUP_DIR && now.getHours() === BACKUP_HOUR && lastBackupDay !== day) {
        lastBackupDay = day;
        await backupToDir(log);
      }
    } catch (e) {
      log.error(`Maintenance task failed: ${e.message}`);
    }
  };
  setTimeout(run, 10000).unref();
  setInterval(run, 15 * 60000).unref();
}

export const backupDir = () => BACKUP_DIR;

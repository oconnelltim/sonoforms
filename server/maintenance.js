// SPDX-License-Identifier: GPL-3.0-or-later
//
// Background housekeeping, every 15 minutes:
//  - remove expired sessions and stale sign-in throttling records
//  - delete old finished exams when a retention period is configured
//  - automatic backup to BACKUP_DIR (if set) once a day at/after BACKUP_HOUR,
//    retried on the next run if it fails; only automatic backups are rotated
//  - nightly audit-chain verification (writes the chain head to the log)
// Each task is independent, so one failing doesn't stop the others.

import fs from 'node:fs';
import path from 'node:path';
import { query } from './db.js';
import { getSettings } from './settings.js';
import { writeBackup } from './backup.js';
import { audit, verifyAuditChain } from './audit.js';

const BACKUP_DIR = process.env.BACKUP_DIR || '';
const BACKUP_HOUR = Number(process.env.BACKUP_HOUR ?? 2);
const BACKUP_KEEP = Number(process.env.BACKUP_KEEP ?? 14);
const AUTO_PREFIX = 'sonoforms-auto-';

export function backupFiles() {
  if (!BACKUP_DIR || !fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .filter(f => /^sonoforms-.*\.sfbak$/.test(f))
    .map((f) => {
      const st = fs.statSync(path.join(BACKUP_DIR, f));
      return { name: f, size: st.size, mtime: st.mtime, automatic: f.startsWith(AUTO_PREFIX) };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

// Local time (TZ), matching the names ./manage.sh gives manual backups.
const stamp = () => {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

export async function backupToDir(log = console, { automatic = false } = {}) {
  if (!BACKUP_DIR) throw new Error('BACKUP_DIR is not set');
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const file = path.join(BACKUP_DIR, automatic ? `${AUTO_PREFIX}${stamp()}.sfbak` : `sonoforms-${stamp()}-manual.sfbak`);
  const tmp = `${file}.partial`;
  const out = fs.createWriteStream(tmp, { mode: 0o600 });
  try {
    const result = await writeBackup(out);
    await new Promise((resolve, reject) => out.end(err => (err ? reject(err) : resolve())));
    fs.renameSync(tmp, file);
    if (automatic) {
      for (const old of backupFiles().filter(f => f.automatic).slice(BACKUP_KEEP)) fs.unlinkSync(path.join(BACKUP_DIR, old.name));
    }
    log.info(`Backup written to ${file} (${result.rows} rows)`);
    await audit({ action: 'system.backup', institutionId: null, details: { file: path.basename(file), rows: result.rows } });
    return { file: path.basename(file), ...result };
  } catch (e) {
    out.destroy();
    fs.rmSync(tmp, { force: true });
    throw e;
  }
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

function backedUpToday() {
  const today = new Date().toDateString();
  return backupFiles().some(f => f.automatic && f.mtime.toDateString() === today);
}

function removeStalePartials() {
  if (!BACKUP_DIR || !fs.existsSync(BACKUP_DIR)) return;
  for (const f of fs.readdirSync(BACKUP_DIR).filter(x => x.endsWith('.partial'))) {
    const full = path.join(BACKUP_DIR, f);
    if (Date.now() - fs.statSync(full).mtimeMs > 3600000) fs.rmSync(full, { force: true });
  }
}

let lastAuditCheckDay = null;

export function startMaintenance(log = console) {
  const task = async (name, fn) => {
    try { await fn(); } catch (e) { log.error(`Maintenance task "${name}" failed: ${e.message}`); }
  };
  const run = async () => {
    await task('sessions', () => query('DELETE FROM sessions WHERE expires_at < now()'));
    await task('sign-in throttling', () => query("DELETE FROM login_failures WHERE last_failed_at < now() - interval '1 day' AND (locked_until IS NULL OR locked_until < now())"));
    await task('retention', () => purgeOldExams(log));
    const now = new Date();
    if (BACKUP_DIR && now.getHours() >= BACKUP_HOUR && !backedUpToday()) {
      await task('backup', async () => {
        removeStalePartials();
        try {
          await backupToDir(log, { automatic: true });
        } catch (e) {
          await audit({ action: 'system.backup_failed', institutionId: null, details: { error: e.message.slice(0, 200) } }).catch(() => {});
          throw e;
        }
      });
    }
    if (now.getHours() >= BACKUP_HOUR && lastAuditCheckDay !== now.toDateString()) {
      await task('audit verification', async () => {
        const result = await verifyAuditChain();
        lastAuditCheckDay = now.toDateString();
        if (!result.ok) {
          log.error(`AUDIT LOG INTEGRITY CHECK FAILED at entry ${result.brokenAt}. ${result.reason || ''}`);
          await audit({ action: 'system.audit_verify_failed', institutionId: null, details: { broken_at: result.brokenAt } });
        }
      });
    }
  };
  setTimeout(run, 10000).unref();
  setInterval(run, 15 * 60000).unref();
}

export const backupDir = () => BACKUP_DIR;

// SPDX-License-Identifier: GPL-3.0-or-later
//
// Backup and restore. A backup file is one plain JSON header line followed by
// one encrypted line per table row. Every line is encrypted with the master
// key and bound to its line number, so a backup is useless without the key
// and lines can't be dropped or reordered undetected.
//
// Restoring requires the same master key the backup was made with.

import readline from 'node:readline';
import { pool, tx } from './db.js';
import { config } from './config.js';
import { encrypt, decrypt } from './crypto.js';

// Restore order respects foreign keys. Sessions are deliberately excluded.
export const TABLES = [
  'settings', 'institutions', 'users', 'user_institutions', 'forms', 'form_versions',
  'institution_forms', 'patients', 'exams', 'audit_log',
];

export async function writeBackup(out) {
  const write = s => new Promise((resolve, reject) => {
    if (out.write(s)) resolve();
    else out.once('drain', resolve).once('error', reject);
  });
  const migrations = (await pool.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map(r => r.name);
  const header = { format: 'sonoforms-backup', format_version: 1, app_version: config.version, created_at: new Date().toISOString(), migrations, tables: TABLES };
  await write(`${JSON.stringify(header)}\n`);
  let n = 0;
  const client = await pool.connect();
  try {
    // A single repeatable-read snapshot so the backup is consistent.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const counts = {};
    for (const table of TABLES) {
      counts[table] = 0;
      await client.query(`DECLARE c_${table} CURSOR FOR SELECT * FROM ${table} ORDER BY 1`);
      for (;;) {
        const { rows } = await client.query(`FETCH 500 FROM c_${table}`);
        if (!rows.length) break;
        for (const row of rows) {
          n++;
          counts[table]++;
          await write(`${encrypt({ t: table, r: row }, `backup:${n}`)}\n`);
        }
      }
      await client.query(`CLOSE c_${table}`);
    }
    await client.query('COMMIT');
    n++;
    await write(`${encrypt({ end: true, rows: n - 1, counts }, `backup:${n}`)}\n`);
    return { rows: n - 1, counts };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Restores into an empty database (or wipes it first when wipe=true).
export async function restoreBackup(input, { wipe = false, log = console } = {}) {
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let header = null;
  let n = 0;
  let ended = false;
  const batches = new Map();
  for await (const line of rl) {
    if (!line.trim()) continue;
    if (!header) {
      header = JSON.parse(line);
      if (header.format !== 'sonoforms-backup') throw new Error('This is not a SonoForms backup file.');
      const applied = new Set((await pool.query('SELECT name FROM schema_migrations')).rows.map(r => r.name));
      const newer = (header.migrations || []).filter(m => !applied.has(m));
      if (newer.length) throw new Error(`This backup was made by a newer version of SonoForms (${header.app_version}). Upgrade this installation first.`);
      continue;
    }
    n++;
    let item;
    try {
      item = decrypt(line, `backup:${n}`);
    } catch {
      throw new Error(`Backup line ${n} could not be decrypted. Either the file is damaged or SONOFORMS_MASTER_KEY is not the key it was made with.`);
    }
    if (item.end) {
      if (item.rows !== n - 1) throw new Error('Backup file is incomplete.');
      ended = true;
      break;
    }
    if (!batches.has(item.t)) batches.set(item.t, []);
    batches.get(item.t).push(item.r);
  }
  if (!header || !ended) throw new Error('Backup file is incomplete (no end marker). It may have been cut off.');

  await tx(async (c) => {
    const existing = (await c.query("SELECT count(*)::int AS n FROM users")).rows[0].n;
    if (existing && !wipe) throw new Error('The database already has data. Re-run with --wipe to replace everything with the backup.');
    // Allow clearing the append-only audit log, for this transaction only.
    await c.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update');
    await c.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_truncate');
    await c.query('SET CONSTRAINTS ALL DEFERRED');
    await c.query('DELETE FROM sessions');
    for (const table of [...TABLES].reverse()) await c.query(`DELETE FROM ${table}`);
    const jsonCols = new Set((await c.query(
      "SELECT table_name || '.' || column_name AS k FROM information_schema.columns WHERE table_schema = 'public' AND data_type IN ('json', 'jsonb')",
    )).rows.map(r => r.k));
    for (const table of TABLES) {
      const rows = batches.get(table) || [];
      for (const row of rows) {
        const cols = Object.keys(row);
        const values = cols.map(k => (jsonCols.has(`${table}.${k}`) && row[k] !== null ? JSON.stringify(row[k]) : row[k]));
        await c.query(`INSERT INTO ${table} (${cols.map(k => `"${k}"`).join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, values);
      }
      log.info(`Restored ${rows.length} rows into ${table}`);
    }
    // Move id sequences past the restored rows.
    const seqs = await c.query(`SELECT table_name, column_name, pg_get_serial_sequence(table_name, column_name) AS seq
      FROM information_schema.columns WHERE table_schema = 'public' AND column_default LIKE 'nextval%'`);
    for (const s of seqs.rows) {
      if (s.seq) await c.query(`SELECT setval($1, COALESCE((SELECT MAX(${s.column_name}) FROM ${s.table_name}), 0) + 1, false)`, [s.seq]);
    }
    await c.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update');
    await c.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_truncate');
  });
  return { rows: n - 1, header };
}

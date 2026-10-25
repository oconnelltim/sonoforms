// SPDX-License-Identifier: GPL-3.0-or-later
//
// Applies server/migrations/*.sql and *.js in filename order, once each.
// Runs automatically at startup so upgrades need no manual database steps.
// A .js migration exports `up(client, log)`; it may use the encryption keys,
// so the master key is checked before the first one runs.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './config.js';
import { pool } from './db.js';

const DIR = path.join(ROOT, 'server', 'migrations');

export async function migrate(log = console) {
  const client = await pool.connect();
  try {
    // Serialize concurrent starts (e.g. two containers) with an advisory lock.
    await client.query('SELECT pg_advisory_lock(727274)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map(r => r.name));
    const files = fs.readdirSync(DIR).filter(f => /\.(sql|js)$/.test(f)).sort();
    let keyChecked = false;
    for (const file of files) {
      if (done.has(file)) continue;
      log.info(`Applying database migration ${file}`);
      if (file.endsWith('.js') && !keyChecked) {
        const { checkMasterKey } = await import('./settings.js');
        await checkMasterKey();
        keyChecked = true;
      }
      await client.query('BEGIN');
      try {
        if (file.endsWith('.sql')) await client.query(fs.readFileSync(path.join(DIR, file), 'utf8'));
        else await (await import(pathToFileURL(path.join(DIR, file)).href)).up(client, log);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${e.message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)').catch(() => {});
    client.release();
  }
}

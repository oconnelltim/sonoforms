// SPDX-License-Identifier: GPL-3.0-or-later

import pg from 'pg';
import { config } from './config.js';

// Return DATE columns as 'YYYY-MM-DD' strings instead of local-midnight Date objects.
pg.types.setTypeParser(1082, v => v);

function makePool(options) {
  const p = new pg.Pool({ ...options, max: 10 });
  p.on('error', err => console.error('Unexpected database error', err.message));
  return p;
}

// `pool` is a live binding: switchToAppRole() replaces it for every module.
export let pool = makePool(config.databaseUrl ? { connectionString: config.databaseUrl } : config.db);

// After setup, drop the owner connection and run as the restricted app role.
export async function switchToAppRole() {
  if (!config.dbApp.user) return false;
  const old = pool;
  pool = makePool({ ...config.db, user: config.dbApp.user, password: config.dbApp.password });
  await pool.query('SELECT 1');
  await old.end();
  return true;
}

export function query(text, params) {
  return pool.query(text, params);
}

export async function one(text, params) {
  const { rows } = await pool.query(text, params);
  return rows[0] || null;
}

export async function many(text, params) {
  const { rows } = await pool.query(text, params);
  return rows;
}

// Run fn(client) in a transaction; rolls back on error.
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

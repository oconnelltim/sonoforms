// SPDX-License-Identifier: GPL-3.0-or-later

import pg from 'pg';
import { config } from './config.js';

// Return DATE columns as 'YYYY-MM-DD' strings instead of local-midnight Date objects.
pg.types.setTypeParser(1082, v => v);

export const pool = new pg.Pool(
  config.databaseUrl
    ? { connectionString: config.databaseUrl, max: 10 }
    : { ...config.db, max: 10 },
);

pool.on('error', err => console.error('Unexpected database error', err));

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

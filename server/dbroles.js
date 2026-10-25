// SPDX-License-Identifier: GPL-3.0-or-later
//
// Least-privilege database access. Schema changes run as the database owner
// (the migrate step); the running app connects as a separate role that can
// read and write application tables but can only INSERT into audit_log and
// can't change the schema, disable triggers, or touch schema_migrations.
// A SQL-injection-type bug therefore can't rewrite or erase the audit trail.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, config } from './config.js';
import { pool } from './db.js';

export async function ensureAppRole(log = console) {
  const { user, password } = config.dbApp;
  if (!user) {
    log.warn('PGAPPUSER is not set: the app will run as the database owner. Set it (the Docker setup does) so the app runs with least privilege.');
    return false;
  }
  if (!password) throw new Error('PGAPPPASSWORD (or PGAPPPASSWORD_FILE) must be set when PGAPPUSER is set.');
  const client = await pool.connect();
  try {
    const role = client.escapeIdentifier(user);
    const exists = (await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [user])).rowCount;
    if (!exists) await client.query(`CREATE ROLE ${role} LOGIN`);
    await client.query(`ALTER ROLE ${role} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${client.escapeLiteral(password)}`);
    const db = (await client.query('SELECT current_database() AS d')).rows[0].d;
    await client.query(`GRANT CONNECT ON DATABASE ${client.escapeIdentifier(db)} TO ${role}`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await client.query(`REVOKE CREATE ON SCHEMA public FROM ${role}`);
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${role}`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
    await client.query(`REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM ${role}`);
    await client.query(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON schema_migrations FROM ${role}`);
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
  } finally {
    client.release();
  }
  log.info(`Database role "${user}" is set up for the application`);
  return true;
}

// In serve mode the app can't migrate; refuse to run against an old schema.
export async function assertMigrated() {
  const files = fs.readdirSync(path.join(ROOT, 'server', 'migrations')).filter(f => /\.(sql|js)$/.test(f));
  const done = new Set((await pool.query('SELECT name FROM schema_migrations')).rows.map(r => r.name));
  const missing = files.filter(f => !done.has(f));
  if (missing.length) throw new Error(`The database needs updating (${missing.join(', ')}). Run the migrate step first (./manage.sh update does this).`);
}

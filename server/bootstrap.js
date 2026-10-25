// SPDX-License-Identifier: GPL-3.0-or-later

import { one, query } from './db.js';
import { hashPassword, temporaryPassword } from './crypto.js';
import { audit } from './audit.js';
import { config } from './config.js';

// On first start, create a superuser. With INITIAL_ADMIN_PASSWORD(_FILE) set
// (the Docker installer does this and shows the password itself) nothing
// secret is logged; otherwise a random password is generated and printed.
export async function ensureFirstAdmin(log = console) {
  const existing = await one('SELECT count(*)::int AS n FROM users');
  if (existing.n > 0) return null;
  const password = config.initialAdminPassword || temporaryPassword();
  const row = await one(
    `INSERT INTO users (username, display_name, password_hash, roles, must_change_password)
     VALUES ('admin', 'Administrator', $1, '{superuser}', true) RETURNING id`, [await hashPassword(password)]);
  const institution = await one('SELECT id FROM institutions LIMIT 1');
  if (!institution) {
    const inst = await one("INSERT INTO institutions (code, name) VALUES ('MAIN', 'Main Hospital') RETURNING id");
    await query('INSERT INTO user_institutions (user_id, institution_id) VALUES ($1, $2)', [row.id, inst.id]);
  }
  await audit({ action: 'system.first_admin_created', institutionId: null, entityType: 'user', entityId: row.id });
  log.warn('==================================================================');
  if (config.initialAdminPassword) {
    log.warn(' First start: created user "admin" with the initial password set by the installer.');
  } else {
    log.warn(` First start: created user "admin" with temporary password: ${password}`);
  }
  log.warn(' You will be asked to change it at first sign-in.');
  log.warn('==================================================================');
  return password;
}

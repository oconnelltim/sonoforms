// SPDX-License-Identifier: GPL-3.0-or-later
//
// First step of docker-compose.trial.yml (a quick trial with nothing but
// Docker Desktop): creates the secrets once, in the trial's own volume, makes
// the backup folder writable for the app, and prints the sign-in details.
// Not for production; production installs use ./install.sh.

import fs from 'node:fs';
import crypto from 'node:crypto';

const dir = '/trial/secrets';
const port = process.env.TRIAL_PORT || '8443';
const alnum = n => crypto.randomBytes(64).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, n);

fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
const secrets = {
  master_key: () => crypto.randomBytes(32).toString('base64'),
  db_password: () => alnum(32),
  db_app_password: () => alnum(32),
  initial_admin_password: () => alnum(16),
};
for (const [name, make] of Object.entries(secrets)) {
  const file = `${dir}/${name}`;
  // Readable by the database and app users of the other trial containers.
  if (!fs.existsSync(file)) fs.writeFileSync(file, make(), { mode: 0o644 });
}
fs.chownSync('/backups', 1000, 1000);

const password = fs.readFileSync(`${dir}/initial_admin_password`, 'utf8');
console.log(`
SonoForms trial
  Open:       https://localhost:${port}   (accept the self-signed certificate warning)
  Username:   admin
  Password:   ${password}   (first sign-in only; you'll choose a new one)

This is for trying SonoForms out, not for patient care. Remove it, including
all its data, with:  docker compose -f docker-compose.trial.yml down -v
`);

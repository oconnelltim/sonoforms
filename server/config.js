// SPDX-License-Identifier: GPL-3.0-or-later
//
// All configuration comes from environment variables (see .env.example).
// Secrets may instead be supplied as files via the *_FILE variants, which
// is how Docker secrets are mounted.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function env(name, fallback) {
  const file = process.env[`${name}_FILE`];
  if (file) return fs.readFileSync(file, 'utf8').trim();
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

const bool = v => ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

export const config = {
  version: pkg.version,
  env: env('NODE_ENV', 'production'),
  port: Number(env('PORT', 3000)),
  host: env('HOST', '0.0.0.0'),
  databaseUrl: env('DATABASE_URL', undefined),
  db: {
    host: env('PGHOST', 'localhost'),
    port: Number(env('PGPORT', 5432)),
    database: env('PGDATABASE', 'sonoforms'),
    user: env('PGUSER', 'sonoforms'),
    password: env('PGPASSWORD', undefined),
  },
  masterKey: env('SONOFORMS_MASTER_KEY', undefined),
  initialAdminPassword: env('INITIAL_ADMIN_PASSWORD', undefined),
  // Cookies are marked Secure unless explicitly disabled (only for local development over http).
  secureCookies: !bool(env('INSECURE_COOKIES', 'false')),
  trustProxy: bool(env('TRUST_PROXY', 'true')),
  formsDir: env('FORMS_DIR', path.join(ROOT, 'forms')),
  dicomMock: bool(env('DICOM_MOCK', 'false')),
  logLevel: env('LOG_LEVEL', 'info'),
};

export const ROLES = ['tech', 'tech_manager', 'radiologist', 'admin', 'superuser'];
export const ROLE_LABELS = {
  tech: 'Technologist',
  tech_manager: 'Tech manager (forms)',
  radiologist: 'Radiologist',
  admin: 'Administrator',
  superuser: 'Superuser',
};

// Default settings; admins can override these in the Admin > Settings page.
export const DEFAULT_SETTINGS = {
  app_name: 'SonoForms',
  session_idle_minutes: 60,
  session_max_hours: 12,
  password_min_length: 10,
  max_failed_logins: 5,
  lockout_minutes: 15,
  retention_days: 0,              // 0 = keep forever
  worklist_show_hours: 24,        // how far back the PACS worklist looks
  report_line_ending: 'crlf',     // what "Copy" puts on the clipboard
  login_banner: 'Authorized use only. Activity is logged.',
};

// SPDX-License-Identifier: GPL-3.0-or-later
//
// Local development without Docker: starts an embedded PostgreSQL in .dev/,
// creates a development master key, and runs the server with auto-reload.
//
//   npm run dev            (fake PACS worklist)
//   npm run dev -- --pacs  (use the PACS settings configured in Admin)

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEV = path.join(ROOT, '.dev');
fs.mkdirSync(DEV, { recursive: true });

const keyFile = path.join(DEV, 'master.key');
if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });

const dataDir = path.join(DEV, 'pgdata');
const pgPort = Number(process.env.DEV_PG_PORT || 54329);
const appPort = Number(process.env.PORT || 3000);

function die(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

function portInUse(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(true));
    srv.once('listening', () => srv.close(() => resolve(false)));
    srv.listen(port, '127.0.0.1');
  });
}

// Another dev server (e.g. in another terminal) holds the database and ports;
// embedded-postgres would otherwise fail with an unhelpful "undefined".
for (const [port, what, envVar] of [[pgPort, 'development database', 'DEV_PG_PORT'], [appPort, 'web server', 'PORT']]) {
  if (await portInUse(port)) {
    die(`Port ${port} (${what}) is already in use. Is another "npm run dev" still running?\n` +
      `Stop it with Ctrl+C in its terminal, or find it with:  lsof -nP -iTCP:${port} -sTCP:LISTEN\n` +
      `(Or use a different port: ${envVar}=<port> npm run dev)`);
  }
}

const pgLogs = [];
const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'sonoforms', password: 'devpassword', port: pgPort, persistent: true, onLog: (m) => pgLogs.push(String(m)), onError: (m) => pgLogs.push(String(m)) });

try {
  if (!fs.existsSync(path.join(dataDir, 'PG_VERSION'))) {
    console.log('Initializing development database in .dev/pgdata ...');
    await pg.initialise();
  }
  await pg.start();
} catch (e) {
  die(`The development database failed to start: ${e?.message || e || 'no error message'}\n` +
    `${pgLogs.slice(-10).join('').trim()}\n\n` +
    'If it was not shut down cleanly, delete .dev/pgdata/postmaster.pid and try again.\n' +
    'To start over with an empty development database, delete the .dev/pgdata folder.');
}
try { await pg.createDatabase('sonoforms'); } catch { /* already exists */ }

const env = {
  ...process.env,
  NODE_ENV: 'development',
  PGHOST: 'localhost',
  PGPORT: String(pgPort),
  PGDATABASE: 'sonoforms',
  PGUSER: 'sonoforms',
  PGPASSWORD: 'devpassword',
  PGAPPUSER: 'sonoforms_app',
  PGAPPPASSWORD: 'devapppassword',
  SONOFORMS_MASTER_KEY_FILE: keyFile,
  INSECURE_COOKIES: 'true',
  DICOM_MOCK: process.argv.includes('--pacs') ? 'false' : 'true',
  INITIAL_ADMIN_PASSWORD: process.env.INITIAL_ADMIN_PASSWORD || 'admin-dev-password',
  TRUST_PROXY: 'false',
  BACKUP_DIR: path.join(DEV, 'backups'),
  PORT: process.env.PORT || '3000',
};

const child = spawn(process.execPath, ['--watch-path=server', '--watch-path=shared', 'server/index.js'], { cwd: ROOT, env, stdio: 'inherit' });
const stop = async () => {
  child.kill('SIGTERM');
  await pg.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', async (code) => {
  await pg.stop();
  process.exit(code ?? 0);
});

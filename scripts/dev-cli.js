// SPDX-License-Identifier: GPL-3.0-or-later
//
// Runs the admin command-line tool (server/cli.js) against the development
// database started by `npm run dev`, which must be running. Examples:
//
//   npm run dev:cli -- reset-password admin
//   npm run dev:cli -- unlock jsmith
//   npm run dev:cli -- verify-audit

import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pgPort = Number(process.env.DEV_PG_PORT || 54329);

const running = await new Promise((resolve) => {
  const s = net.connect(pgPort, '127.0.0.1');
  s.once('connect', () => { s.end(); resolve(true); });
  s.once('error', () => resolve(false));
});
if (!running) {
  console.error('\nThe development database is not running. Start it with "npm run dev" (in another terminal) first.\n');
  process.exit(1);
}

const env = {
  ...process.env,
  PGHOST: 'localhost',
  PGPORT: String(pgPort),
  PGDATABASE: 'sonoforms',
  PGUSER: 'sonoforms',
  PGPASSWORD: 'devpassword',
  SONOFORMS_MASTER_KEY_FILE: path.join(ROOT, '.dev', 'master.key'),
};

const child = spawn(process.execPath, [path.join(ROOT, 'server', 'cli.js'), ...process.argv.slice(2)], { cwd: ROOT, env, stdio: 'inherit' });
child.on('exit', code => process.exit(code ?? 0));

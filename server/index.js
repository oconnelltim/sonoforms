// SPDX-License-Identifier: GPL-3.0-or-later
//
// Starts SonoForms: checks the encryption key, applies database migrations,
// loads the general form library, creates the first admin if needed, then
// serves the app.

import { config } from './config.js';
import { initKeys } from './crypto.js';
import { migrate } from './migrate.js';
import { checkMasterKey } from './settings.js';
import { seedGeneralForms } from './forms.js';
import { buildApp } from './app.js';
import { startMaintenance } from './maintenance.js';
import { ensureFirstAdmin } from './bootstrap.js';
import { pool } from './db.js';

async function waitForDatabase(log) {
  for (let i = 1; i <= 30; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (e) {
      if (i === 30) throw new Error(`Could not connect to the database: ${e.message}`);
      log.info(`Waiting for database (${e.code || e.message})...`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

async function main() {
  const app = await buildApp();
  const log = app.log;
  try {
    initKeys();
    await waitForDatabase(log);
    await migrate(log);
    await checkMasterKey();
    await seedGeneralForms(log);
    await ensureFirstAdmin(log);
  } catch (e) {
    log.fatal(e.message);
    process.exit(1);
  }
  if (config.dicomMock) log.warn('DICOM_MOCK is on: the worklist shows fake demo studies, not PACS.');
  startMaintenance(log);
  await app.listen({ port: config.port, host: config.host });

  const shutdown = async (signal) => {
    log.info(`${signal} received, shutting down`);
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();

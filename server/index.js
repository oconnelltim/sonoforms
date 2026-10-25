// SPDX-License-Identifier: GPL-3.0-or-later
//
// Starts SonoForms. SONOFORMS_MODE selects what this process does:
//   all      check the key, migrate, load forms, create the first admin,
//            then serve (development / single-process installs)
//   migrate  only the setup steps, as the database owner, then exit
//            (the Docker "migrate" container)
//   serve    only serve, as the restricted database role (the Docker
//            "app" container, which never holds the owner password)

import { config } from './config.js';
import { initKeys } from './crypto.js';
import { migrate } from './migrate.js';
import { checkMasterKey } from './settings.js';
import { seedGeneralForms } from './forms.js';
import { buildApp } from './app.js';
import { startMaintenance } from './maintenance.js';
import { ensureFirstAdmin } from './bootstrap.js';
import { ensureAppRole, assertMigrated } from './dbroles.js';
import { pool, switchToAppRole } from './db.js';

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
  const mode = ['all', 'migrate', 'serve'].includes(config.mode) ? config.mode : 'all';
  const app = await buildApp();
  const log = app.log;
  try {
    initKeys();
    await waitForDatabase(log);
    if (mode === 'serve') {
      await assertMigrated();
      await checkMasterKey();
    } else {
      await migrate(log);
      await checkMasterKey();
      await seedGeneralForms(log);
      await ensureFirstAdmin(log);
      await ensureAppRole(log);
    }
    if (mode === 'migrate') {
      log.info('Database is up to date.');
      await pool.end();
      process.exit(0);
    }
    if (mode === 'all' && await switchToAppRole()) log.info(`Running as database role "${config.dbApp.user}"`);
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

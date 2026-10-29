// Shared test harness: a throwaway embedded PostgreSQL, the app set up the
// way production runs it (migrations as owner, then the restricted app role),
// and a small cookie-keeping HTTP client built on fastify.inject.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import pg from 'pg';
import EmbeddedPostgres from 'embedded-postgres';

// Fails instead of hanging if the embedded database never starts. Without
// this, a database binary that can't run (e.g. on Alpine Linux) leaves a
// promise that never settles; Node then exits with code 0 before any test
// runs, and the run looks like a pass.
function withTimeout(promise, what, ms = 90000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms / 1000} s; the embedded PostgreSQL could not start on this machine.`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function startTestServer(extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonoforms-test-'));
  const port = 55000 + Math.floor(Math.random() * 9000);
  const pgServer = new EmbeddedPostgres({ databaseDir: path.join(dir, 'pg'), user: 'owner', password: 'owner', port, persistent: false, onLog: () => {} });
  Object.assign(process.env, {
    PGHOST: 'localhost', PGPORT: String(port), PGDATABASE: 'sonoforms', PGUSER: 'owner', PGPASSWORD: 'owner',
    PGAPPUSER: 'sonoforms_app', PGAPPPASSWORD: 'app-test-pass',
    SONOFORMS_MASTER_KEY: crypto.randomBytes(32).toString('base64'),
    INITIAL_ADMIN_PASSWORD: 'initial-admin-pass', INSECURE_COOKIES: 'true', DICOM_MOCK: 'true', LOG_LEVEL: 'silent',
    ...extraEnv,
  });
  await withTimeout(pgServer.initialise(), 'Initialising the test database');
  await withTimeout(pgServer.start(), 'Starting the test database');
  await withTimeout(pgServer.createDatabase('sonoforms'), 'Creating the test database');
  const { initKeys } = await import('../server/crypto.js');
  const { migrate } = await import('../server/migrate.js');
  const { checkMasterKey } = await import('../server/settings.js');
  const { seedGeneralForms } = await import('../server/forms.js');
  const { ensureFirstAdmin } = await import('../server/bootstrap.js');
  const { ensureAppRole } = await import('../server/dbroles.js');
  const { buildApp } = await import('../server/app.js');
  const db = await import('../server/db.js');
  const quiet = { info() {}, warn() {}, error() {} };
  initKeys();
  await migrate(quiet);
  await checkMasterKey();
  await seedGeneralForms(quiet);
  await ensureFirstAdmin(quiet);
  await ensureAppRole(quiet);
  await db.switchToAppRole();
  const app = await buildApp({ logger: false });
  // A separate owner connection, for tests that simulate an attacker with
  // full database access.
  const ownerPool = new pg.Pool({ host: 'localhost', port, database: 'sonoforms', user: 'owner', password: 'owner' });

  function client(defaultHeaders = {}) {
    let cookie = '';
    let csrf = '';
    const call = async (method, url, body, headers = {}) => {
      const res = await app.inject({
        method, url: `/api${url}`, payload: body,
        headers: { cookie, ...(csrf && method !== 'GET' ? { 'x-csrf-token': csrf } : {}), ...defaultHeaders, ...headers },
      });
      const set = res.headers['set-cookie'];
      if (set) cookie = (Array.isArray(set) ? set : [set]).map(c => c.split(';')[0]).join('; ');
      let parsed = res.body;
      try { parsed = res.json(); } catch { /* not JSON */ }
      return { status: res.statusCode, body: parsed };
    };
    return {
      call,
      get cookie() { return cookie; },
      async login(username, password) {
        const r = await call('POST', '/auth/login', { username, password });
        assert.equal(r.status, 200, `login ${username}: ${JSON.stringify(r.body)}`);
        csrf = (await call('GET', '/session')).body.csrf;
        return r;
      },
      async changePassword(current, next) {
        const r = await call('POST', '/auth/password', { current, next });
        assert.equal(r.status, 200, JSON.stringify(r.body));
      },
    };
  }

  // Signs in as the first admin (changing the initial password once).
  let adminPassword = 'initial-admin-pass';
  async function admin() {
    const c = client();
    await c.login('admin', adminPassword);
    if (adminPassword === 'initial-admin-pass') {
      await c.changePassword(adminPassword, 'a-much-better-password');
      adminPassword = 'a-much-better-password';
    }
    return c;
  }

  // Creates a user and returns a signed-in client (password already changed).
  let n = 0;
  async function user(su, roles, institutionIds) {
    const username = `u${++n}${roles[0].slice(0, 3)}`;
    const r = await su.call('POST', '/admin/users', { username, display_name: username, roles, institution_ids: institutionIds });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const c = client();
    await c.login(username, r.body.temporary_password);
    const password = `pw-${crypto.randomBytes(6).toString('hex')}-ok`;
    await c.changePassword(r.body.temporary_password, password);
    return Object.assign(c, { id: r.body.id, username, password });
  }

  async function stop() {
    await app.close();
    await db.pool.end();
    await ownerPool.end();
    await pgServer.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  return { app, db, ownerPool, client, admin, user, stop };
}

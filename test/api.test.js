// End-to-end API tests against a throwaway embedded PostgreSQL.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonoforms-test-'));
const port = 55000 + Math.floor(Math.random() * 5000);
const pg = new EmbeddedPostgres({ databaseDir: path.join(dir, 'pg'), user: 'test', password: 'test', port, persistent: false, onLog: () => {} });

Object.assign(process.env, {
  PGHOST: 'localhost', PGPORT: String(port), PGDATABASE: 'sonoforms', PGUSER: 'test', PGPASSWORD: 'test',
  SONOFORMS_MASTER_KEY: crypto.randomBytes(32).toString('base64'),
  INITIAL_ADMIN_PASSWORD: 'initial-admin-pass', INSECURE_COOKIES: 'true', DICOM_MOCK: 'true', LOG_LEVEL: 'silent',
});

let app, pool;

before(async () => {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('sonoforms');
  const { initKeys } = await import('../server/crypto.js');
  const { migrate } = await import('../server/migrate.js');
  const { checkMasterKey } = await import('../server/settings.js');
  const { seedGeneralForms } = await import('../server/forms.js');
  const { ensureFirstAdmin } = await import('../server/bootstrap.js');
  const { buildApp } = await import('../server/app.js');
  ({ pool } = await import('../server/db.js'));
  const quiet = { info() {}, warn() {}, error() {} };
  initKeys();
  await migrate(quiet);
  await checkMasterKey();
  await seedGeneralForms(quiet);
  await ensureFirstAdmin(quiet);
  app = await buildApp({ logger: false });
}, { timeout: 120000 });

after(async () => {
  await app?.close();
  await pool?.end();
  await pg.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

// Minimal cookie-keeping client around fastify.inject.
function client() {
  let cookie = '';
  let csrf = '';
  const call = async (method, url, body) => {
    const res = await app.inject({
      method, url: `/api${url}`, payload: body,
      headers: { cookie, ...(csrf && method !== 'GET' ? { 'x-csrf-token': csrf } : {}) },
    });
    const set = res.headers['set-cookie'];
    if (set) cookie = (Array.isArray(set) ? set : [set]).map(c => c.split(';')[0]).join('; ');
    return { status: res.statusCode, body: res.headers['content-type']?.includes('json') ? res.json() : res.body };
  };
  return {
    call,
    async login(username, password) {
      const r = await call('POST', '/auth/login', { username, password });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      csrf = (await call('GET', '/session')).body.csrf;
    },
    async changePassword(current, next) {
      const r = await call('POST', '/auth/password', { current, next });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    },
  };
}

test('full workflow: admin creates users, tech submits, radiologist dictates', async () => {
  const admin = client();
  assert.equal((await admin.call('POST', '/auth/login', { username: 'admin', password: 'wrong' })).status, 401);
  await admin.login('admin', 'initial-admin-pass');
  assert.equal((await admin.call('GET', '/admin/users')).status, 403, 'must change password first');
  await admin.changePassword('initial-admin-pass', 'a-much-better-password');

  const inst = (await admin.call('GET', '/admin/institutions')).body.institutions[0];
  const mk = async (username, roles) => {
    const r = await admin.call('POST', '/admin/users', { username, display_name: username, roles, institution_ids: [inst.id] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.temporary_password;
  };
  const techPw = await mk('tech1', ['tech']);
  const radPw = await mk('rad1', ['radiologist']);

  const tech = client();
  await tech.login('tech1', techPw);
  await tech.changePassword(techPw, 'scan-room-pass-1');
  assert.equal((await tech.call('GET', '/worklist/rad')).status, 403);
  assert.equal((await tech.call('GET', '/admin/users')).status, 403);

  const wl = (await tech.call('GET', '/worklist/tech')).body;
  const study = wl.pacs.studies.find(s => s.description.includes('THYROID'));
  assert.equal(study.suggested_form.title, 'US Thyroid');
  const created = (await tech.call('POST', '/exams', { study_uid: study.study_uid, form_id: study.suggested_form.id })).body;
  const again = (await tech.call('POST', '/exams', { study_uid: study.study_uid })).body;
  assert.equal(again.id, created.id, 'same study opens the same exam');

  let { exam, form } = (await tech.call('GET', `/exams/${created.id}`)).body;
  assert.equal(exam.patient.last_name, 'SAMPLE');
  const { normalizeForm, normalAnswers, initialAnswers } = await import('../shared/formdef.js');
  const def = normalizeForm(form.definition);

  // Submitting an incomplete form is refused and lists what's missing.
  let r = await tech.call('POST', `/exams/${exam.id}/submit`, { answers: {}, row_version: exam.row_version });
  assert.equal(r.status, 400);
  assert.ok(r.body.missing.length > 0);

  // Fill normals plus required measurements.
  const answers = initialAnswers(def);
  for (const s of def.sections) Object.assign(answers, normalAnswers(s));
  const { validateAnswers } = await import('../shared/engine.js');
  for (const m of validateAnswers(def, answers, {}).missing) {
    const f = def.sections.flatMap(s => s.fields).find(x => x.id === m.id);
    if (f?.type === 'dims') answers[f.id] = [4.5, 1.5, 1.4];
    else if (f?.type === 'number') answers[f.id] = 0.3;
    else if (f?.options) answers[f.id] = f.type === 'multi' ? [f.options[0].value] : f.options[0].value;
  }
  r = await tech.call('POST', `/exams/${exam.id}/submit`, { answers, row_version: r.body.row_version });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const rad = client();
  await rad.login('rad1', radPw);
  await rad.changePassword(radPw, 'reading-room-pass');
  const queue = (await rad.call('GET', '/worklist/rad')).body;
  assert.equal(queue.length, 1);
  ({ exam } = (await rad.call('GET', `/exams/${created.id}`)).body);
  assert.match(exam.report, /RIGHT LOBE: Measures 4.5 x 1.5 x 1.4 cm/);

  // Stale row_version is rejected.
  assert.equal((await rad.call('POST', `/exams/${exam.id}/dictated`, { row_version: exam.row_version - 1 })).status, 409);
  assert.equal((await rad.call('POST', `/exams/${exam.id}/dictated`, { row_version: exam.row_version, text: 'edited' })).status, 200);
  assert.equal((await tech.call('POST', `/exams/${exam.id}/reopen`, { row_version: exam.row_version + 1 })).status, 409);

  // Nothing identifying is stored in plaintext.
  const rows = await pool.query('SELECT demographics_enc FROM patients');
  assert.ok(rows.rows.every(x => x.demographics_enc.startsWith('v1.') && !x.demographics_enc.includes('SAMPLE')));

  // The audit chain is intact and immutable.
  const { verifyAuditChain } = await import('../server/audit.js');
  assert.equal((await verifyAuditChain()).ok, true);
  await assert.rejects(pool.query('DELETE FROM audit_log'), /append-only/);
});

test('CSRF token is required for changes', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'a-much-better-password' } });
  const cookie = res.headers['set-cookie'].split(';')[0];
  const r = await app.inject({ method: 'PUT', url: '/api/admin/settings', payload: { app_name: 'X' }, headers: { cookie } });
  assert.equal(r.statusCode, 403);
});

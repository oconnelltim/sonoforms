// End-to-end API tests against a throwaway embedded PostgreSQL.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let t, app, client, pool;

before(async () => {
  t = await startTestServer();
  ({ app, client } = t);
  pool = t.db.pool;
}, { timeout: 120000 });

after(async () => { await t?.stop(); });

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
  assert.ok(rows.rows.every(x => x.demographics_enc.startsWith('v2.') && !x.demographics_enc.includes('SAMPLE')));

  // The audit chain is intact and immutable.
  const { verifyAuditChain } = await import('../server/audit.js');
  assert.equal((await verifyAuditChain()).ok, true);
  await assert.rejects(pool.query('DELETE FROM audit_log'), /permission denied/, 'the app role cannot delete audit entries');
});

test('CSRF token is required for changes', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'a-much-better-password' } });
  const cookie = res.headers['set-cookie'].split(';')[0];
  const r = await app.inject({ method: 'PUT', url: '/api/admin/settings', payload: { app_name: 'X' }, headers: { cookie } });
  assert.equal(r.statusCode, 403);
});

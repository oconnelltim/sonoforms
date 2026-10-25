// Regression tests for the October 2026 OWASP review
// (docs/SECURITY-REVIEW-2026-10.md). Each test names the finding it covers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { startTestServer } from './helpers.js';

let t, su, instA, instB;

before(async () => {
  // Mirrors the Docker setup: only the proxy's address is trusted (inject
  // requests arrive from 127.0.0.1).
  t = await startTestServer({ TRUST_PROXY: '127.0.0.1' });
  su = await t.admin();
  instA = (await su.call('GET', '/admin/institutions')).body.institutions[0].id;
  instB = (await su.call('POST', '/admin/institutions', { code: 'B', name: 'Other Hospital' })).body.id;
}, { timeout: 120000 });

after(async () => { await t?.stop(); });

const ms = async (fn) => { const s = performance.now(); await fn(); return performance.now() - s; };

// ---- H1, H2, M6: denial of service ------------------------------------------------

test('H1: long whitespace in answers cannot stall report generation', async () => {
  const YAML = (await import('yaml')).default;
  const fs = await import('node:fs');
  const { normalizeForm } = await import('../shared/formdef.js');
  const { generateReport } = await import('../shared/template.js');
  const def = normalizeForm(YAML.parse(fs.readFileSync('forms/general/us-pelvis-female.yaml', 'utf8')));
  const elapsed = await ms(() => generateReport(def, { lmp_status: 'unknown', comparison: `x${' '.repeat(200000)}x` }));
  assert.ok(elapsed < 1000, `took ${elapsed} ms`);
});

test('H1: oversized or malformed answers are rejected by the server', async () => {
  const tech = await t.user(su, ['tech'], [instA]);
  const study = (await tech.call('GET', '/worklist/tech')).body.pacs.studies[0];
  const { id } = (await tech.call('POST', '/exams', { study_uid: study.study_uid })).body;
  const rv = (await tech.call('GET', `/exams/${id}`)).body.exam.row_version;
  assert.equal((await tech.call('PUT', `/exams/${id}`, { answers: { comparison: 'x'.repeat(10001) }, row_version: rv })).status, 400);
  assert.equal((await tech.call('PUT', `/exams/${id}`, { answers: { a: [[[[[1]]]]] }, row_version: rv })).status, 400);
  assert.equal((await tech.call('PUT', `/exams/${id}`, { answers: { 'bad key': 1 }, row_version: rv })).status, 400);
  assert.equal((await tech.call('PUT', `/exams/${id}`, { answers: { comparison: 'fine' }, row_version: rv })).status, 200);
});

test('H2: regular expressions in study_match are rejected and never run', async () => {
  const { lintForm, matchScore } = await import('../shared/formdef.js');
  const problems = lintForm({ title: 'T', study_match: ['/(A+)+$/'], sections: [{ title: 'S', fields: [{ id: 'a', label: 'A' }] }] });
  assert.ok(problems.some(p => p.level === 'error' && /Regular expressions/.test(p.message)));
  const elapsed = await ms(() => matchScore({ study_match: ['/(A+)+$/'] }, `${'A'.repeat(60)}!`));
  assert.ok(elapsed < 50, `took ${elapsed} ms`);
});

test('M6: chained calculations cannot grow exponentially', async () => {
  const { normalizeForm } = await import('../shared/formdef.js');
  const { generateReport } = await import('../shared/template.js');
  const fields = [{ id: 'c0', type: 'calc', label: 'c', formula: '[1, 1]' }];
  for (let i = 1; i <= 40; i++) fields.push({ id: `c${i}`, type: 'calc', label: 'c', formula: `[c${i - 1}, c${i - 1}]` });
  const def = normalizeForm({ title: 'e', sections: [{ title: 's', fields, report: '{{ sum(c40) }}' }] });
  const elapsed = await ms(() => generateReport(def, {}));
  assert.ok(elapsed < 1000, `took ${elapsed} ms`);
});

test('Info: unclosed template tags and huge decimals are handled', async () => {
  const { parseTemplate } = await import('../shared/template.js');
  const elapsed = await ms(() => { try { parseTemplate('{{'.repeat(50000)); } catch { /* expected */ } });
  assert.ok(elapsed < 500, `took ${elapsed} ms`);
  const { FUNCTIONS } = await import('../shared/functions.js');
  assert.equal(FUNCTIONS.fixed(1.5, 101), '1.5000000000');
});

// ---- H3: identifiers must match exactly -----------------------------------------

test('H3: study UIDs, accessions and MRNs are matched exactly, issuer included', async () => {
  const { indexes } = await import('../server/records.js');
  assert.notEqual(indexes.studyUid(1, '1.2.3.12.345'), indexes.studyUid(1, '1.2.3.123.45'));
  assert.notEqual(indexes.accession(1, 'ACC-1/23'), indexes.accession(1, 'ACC12-3'));
  assert.notEqual(indexes.mrn(1, '', '12-345'), indexes.mrn(1, '', '1234-5'));
  assert.notEqual(indexes.mrn(1, 'HOSP-A', '123'), indexes.mrn(1, 'HOSP-B', '123'));
  assert.notEqual(indexes.studyUid(1, '1.2.3'), indexes.studyUid(2, '1.2.3'), 'indexes are scoped per institution');
  assert.equal(indexes.lastName(1, "O'Neil"), indexes.lastName(1, 'oneil'), 'name search stays forgiving');
});

test('L: encrypted values are bound to their row and use full-length tags', async () => {
  const { encrypt, decrypt } = await import('../server/crypto.js');
  const blob = encrypt({ mrn: '1' }, 'patients.demographics', 1);
  assert.deepEqual(decrypt(blob, 'patients.demographics', 1), { mrn: '1' });
  assert.throws(() => decrypt(blob, 'patients.demographics', 2), 'swapped into another row');
  const [v, iv, tag, ct] = blob.split('.');
  const shortTag = [v, iv, Buffer.from(tag, 'base64').subarray(0, 4).toString('base64'), ct].join('.');
  assert.throws(() => decrypt(shortTag, 'patients.demographics', 1), /Malformed/);
});

// ---- H4: no identifiers in URLs -----------------------------------------------------

test('H4: patient search uses a POST body, not the URL', async () => {
  const tech = await t.user(su, ['tech'], [instA]);
  assert.equal((await tech.call('GET', '/patients?mrn=1')).status, 404);
  const r = await tech.call('POST', '/patients/search', { mrn: 'MRN101200' });
  assert.equal(r.status, 200);
});

// ---- H5, M9: sign-in throttling ---------------------------------------------------

test('H5: X-Forwarded-For entries sent by the client are not trusted', async () => {
  await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'nobody-xff', password: 'x' }, headers: { 'x-forwarded-for': '6.6.6.6, 10.20.30.40' } });
  const { rows } = await t.ownerPool.query("SELECT ip FROM audit_log WHERE action = 'auth.login_failed' ORDER BY id DESC LIMIT 1");
  assert.equal(rows[0].ip, '10.20.30.40', 'only the entry added by the trusted proxy is used');
});

test('H5: parallel guesses are counted before the password check', async () => {
  const victim = await t.user(su, ['tech'], [instA]);
  const ip = '10.66.0.1';
  const results = await Promise.all(Array.from({ length: 30 }, (_, i) => t.app.inject({
    method: 'POST', url: '/api/auth/login', payload: { username: victim.username, password: `wrong-${i}` }, headers: { 'x-forwarded-for': ip },
  })));
  const checked = results.filter(r => r.statusCode === 401).length;
  assert.ok(checked <= 5, `${checked} guesses were checked (max 5)`);
  assert.ok(results.filter(r => r.statusCode === 429).length >= 25);
  // The attacker's computer is paused; the real user on another computer is not.
  const fromAttacker = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: victim.username, password: victim.password }, headers: { 'x-forwarded-for': ip } });
  assert.equal(fromAttacker.statusCode, 429);
  const fromUser = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: victim.username, password: victim.password }, headers: { 'x-forwarded-for': '10.66.0.2' } });
  assert.equal(fromUser.statusCode, 200);
});

test('M9: a throttled real account looks the same as an unknown username', async () => {
  const victim = await t.user(su, ['tech'], [instA]);
  const attempt = (u, ip) => t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: u, password: 'x' }, headers: { 'x-forwarded-for': ip } });
  for (let i = 0; i < 6; i++) { await attempt(victim.username, '10.67.0.1'); await attempt('no-such-user-here', '10.67.0.1'); }
  const real = await attempt(victim.username, '10.67.0.1');
  const fake = await attempt('no-such-user-here', '10.67.0.1');
  assert.equal(real.statusCode, fake.statusCode);
  assert.equal(real.json().error, fake.json().error);
});

test('L: temporary passwords expire', async () => {
  const r = await su.call('POST', '/admin/users', { username: 'expiring', display_name: 'E', roles: ['tech'], institution_ids: [instA] });
  await t.ownerPool.query("UPDATE users SET temp_password_expires_at = now() - interval '1 hour' WHERE id = $1", [r.body.id]);
  const res = await t.client().call('POST', '/auth/login', { username: 'expiring', password: r.body.temporary_password });
  assert.equal(res.status, 401);
  assert.match(res.body.error, /expired/);
});

test('L: the password-change form is throttled', async () => {
  const u = await t.user(su, ['tech'], [instA]);
  const codes = [];
  for (let i = 0; i < 7; i++) codes.push((await u.call('POST', '/auth/password', { current: `wrong-${i}`, next: 'whatever-long-pass' })).status);
  assert.ok(codes.includes(429), codes.join(','));
});

// ---- A01: access control ------------------------------------------------------------

test('M7: removing a user from an institution takes effect immediately', async () => {
  const tech = await t.user(su, ['tech'], [instB]);
  assert.equal((await tech.call('GET', '/worklist/tech')).status, 200);
  await su.call('PUT', `/admin/users/${tech.id}`, { institution_ids: [] });
  assert.equal((await tech.call('GET', '/worklist/tech')).status, 403);
});

test('M8: administrators cannot widen their own access or reach unassigned PHI', async () => {
  const adm = await t.user(su, ['admin'], []);
  const tech = await t.user(su, ['tech'], [instA]);
  const study = (await tech.call('GET', '/worklist/tech')).body.pacs.studies[2];
  const { id } = (await tech.call('POST', '/exams', { study_uid: study.study_uid })).body;
  assert.equal((await adm.call('PUT', `/admin/users/${adm.id}`, { roles: ['admin', 'radiologist'] })).status, 403);
  assert.equal((await adm.call('PUT', `/admin/users/${adm.id}`, { institution_ids: [instA] })).status, 403);
  // Even with a clinical role (granted by someone else), access follows institution assignment.
  await su.call('PUT', `/admin/users/${adm.id}`, { roles: ['admin', 'radiologist'], institution_ids: [instB] });
  assert.equal((await adm.call('GET', `/exams/${id}`)).status, 404);
});

test('L: administrators cannot act on superusers; the last superuser is protected', async () => {
  const adm = await t.user(su, ['admin'], []);
  assert.equal((await adm.call('POST', '/admin/users/1/sign-out')).status, 403);
  assert.equal((await adm.call('POST', '/admin/users/1/unlock')).status, 403);
  assert.equal((await su.call('PUT', '/admin/users/1', { roles: ['admin'] })).status, 400);
  assert.equal((await su.call('GET', '/admin/users')).status, 200, 'superuser session still valid');
});

test('L: malformed ids return 404, not a server error', async () => {
  const tech = await t.user(su, ['tech'], [instA]);
  assert.equal((await tech.call('GET', '/exams/abc')).status, 404);
  assert.equal((await tech.call('GET', '/exams/99999999999')).status, 404);
});

test('L: cross-site requests are blocked, including sign-in', async () => {
  const r = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'x' }, headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(r.statusCode, 403);
  const o = await t.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { origin: 'https://evil.example', host: 'sonoforms.local' } });
  assert.equal(o.statusCode, 403);
});

// ---- M10, M11: audit log --------------------------------------------------------------

test('M10: permission failures and exam edits are audited', async () => {
  const tech = await t.user(su, ['tech'], [instA]);
  await tech.call('GET', '/admin/users');
  const { rows } = await t.ownerPool.query("SELECT 1 FROM audit_log WHERE action = 'security.forbidden' AND user_id = $1", [tech.id]);
  assert.ok(rows.length >= 1);
});

test('M11: the app cannot alter the audit log, and forged chains are detected', async () => {
  const { verifyAuditChain } = await import('../server/audit.js');
  await assert.rejects(t.db.pool.query("UPDATE audit_log SET action = 'x' WHERE id = 1"), /permission denied/);
  assert.equal((await verifyAuditChain()).ok, true);
  // An attacker with full database access edits an entry and recomputes the
  // unkeyed SHA-256 the old design used: the keyed chain still catches it.
  const crypto = await import('node:crypto');
  await t.ownerPool.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update');
  const last = (await t.ownerPool.query('SELECT id FROM audit_log ORDER BY id DESC LIMIT 1')).rows[0].id;
  await t.ownerPool.query("UPDATE audit_log SET action = 'forged', hash = $2 WHERE id = $1", [last, crypto.createHash('sha256').update('forged').digest('hex')]);
  assert.equal((await verifyAuditChain()).ok, false);
  // Deleting the newest entries is caught by the anchor from the last verification.
  await t.ownerPool.query('DELETE FROM audit_log WHERE id >= $1', [last]);
  const r = await verifyAuditChain();
  assert.equal(r.ok, false);
  assert.match(r.reason, /missing/);
  await t.ownerPool.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update');
});

// ---- L: backups ------------------------------------------------------------------------

test('L: backup lines cannot be spliced between backups, and the header is authenticated', async () => {
  const { writeBackup, restoreBackup } = await import('../server/backup.js');
  const capture = async () => {
    let out = '';
    await writeBackup({ write: (s) => { out += s; return true; }, once() {} });
    return out.trim().split('\n');
  };
  const a = await capture();
  const b = await capture();
  const spliced = [...b];
  spliced[3] = a[3];
  await assert.rejects(restoreBackup(Readable.from([spliced.join('\n')]), { wipe: true, log: { info() {} } }), /could not be decrypted/);
  const header = JSON.parse(b[0]);
  header.app_version = 'tampered';
  await assert.rejects(restoreBackup(Readable.from([[JSON.stringify(header), ...b.slice(1)].join('\n')]), { wipe: true, log: { info() {} } }), /header has been altered/);
});

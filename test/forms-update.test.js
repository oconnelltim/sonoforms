// Updating the general library from newer starter files (update-general-forms).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTestServer } from './helpers.js';

let t, forms, config, dir;
const file = name => path.join(dir, 'general', name);
const byFile = plan => Object.fromEntries(plan.map(p => [p.file, p.action]));

before(async () => {
  t = await startTestServer();
  forms = await import('../server/forms.js');
  ({ config } = await import('../server/config.js'));
  // A copy of the starter files that the test can change.
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonoforms-forms-'));
  fs.cpSync(path.join(config.formsDir, 'general'), path.join(dir, 'general'), { recursive: true });
  config.formsDir = dir;
}, { timeout: 120000 });

after(async () => { await t?.stop(); });

test('starter form updates replace only unedited forms, and keep history', async () => {
  let plan = await forms.planGeneralFormUpdates();
  assert.ok(plan.length >= 7 && plan.every(p => p.action === 'same'), JSON.stringify(byFile(plan)));

  // A newer thyroid file; a renal form edited in the app; a scrotum draft in progress; a brand-new form.
  fs.writeFileSync(file('us-thyroid.yaml'), fs.readFileSync(file('us-thyroid.yaml'), 'utf8').replace(/^title: .*$/m, 'title: US Thyroid (new)'));
  fs.writeFileSync(file('us-renal.yaml'), fs.readFileSync(file('us-renal.yaml'), 'utf8').replace(/^title: .*$/m, 'title: US Renal (new)'));
  fs.writeFileSync(file('us-scrotum.yaml'), fs.readFileSync(file('us-scrotum.yaml'), 'utf8').replace(/^title: .*$/m, 'title: US Scrotum (new)'));
  fs.writeFileSync(file('us-extra.yaml'), 'id: us-extra\ntitle: US Extra\nsections:\n  - id: a\n    title: A\n    fields:\n      - { id: x, type: text, label: X }\n');
  const id = slug => t.db.one('SELECT id FROM forms WHERE institution_id IS NULL AND slug = $1', [slug]).then(r => r.id);
  const renal = await id('us-renal');
  const renalSrc = (await t.db.one('SELECT source FROM form_versions WHERE form_id = $1', [renal])).source;
  await forms.saveDraft(renal, renalSrc.replace(/^title: .*$/m, 'title: US Renal (local)'), 1);
  await forms.publishDraft(renal, 1, 'Local edit');
  const scrotum = await id('us-scrotum');
  await forms.saveDraft(scrotum, (await t.db.one('SELECT source FROM form_versions WHERE form_id = $1', [scrotum])).source + '\n# work in progress\n', 1);

  plan = await forms.planGeneralFormUpdates();
  const { 'us-thyroid.yaml': thy, 'us-renal.yaml': ren, 'us-scrotum.yaml': scr, 'us-extra.yaml': extra, 'us-ruq.yaml': ruq } = byFile(plan);
  assert.deepEqual([thy, ren, scr, extra, ruq], ['update', 'edited', 'draft', 'add', 'same']);
  assert.equal(byFile(await forms.planGeneralFormUpdates({ force: true }))['us-renal.yaml'], 'update', '--force replaces edited forms');

  const done = await forms.applyGeneralFormUpdates(plan.filter(p => ['add', 'update'].includes(p.action)));
  assert.deepEqual(done.map(d => [d.file, d.newVersion]).sort(), [['us-extra.yaml', 1], ['us-thyroid.yaml', 2]]);
  const thyroid = await forms.getForm(await id('us-thyroid'));
  assert.equal(thyroid.title, 'US Thyroid (new)');
  assert.deepEqual(thyroid.versions.map(v => [v.version, v.status]), [[2, 'published'], [1, 'retired']]);
  assert.equal((await forms.getForm(renal)).title, 'US Renal (local)', 'edited form left alone');
  assert.equal((await forms.getForm(scrotum)).draft_version, 2, 'draft left alone');

  // Applying again finds nothing more for the unedited forms.
  plan = await forms.planGeneralFormUpdates();
  assert.equal(byFile(plan)['us-thyroid.yaml'], 'same');
  assert.equal(byFile(plan)['us-extra.yaml'], 'same');
});

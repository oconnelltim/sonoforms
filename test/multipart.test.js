// Multipart studies: one form covering several PACS studies (linked
// studies), and several exams in one visit reported together.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { normalizeForm, initialAnswers, normalAnswers } from '../shared/formdef.js';
import { validateAnswers } from '../shared/engine.js';
import { combineReports, defaultHeading } from '../shared/report-fields.js';

let t, tech, rad, inst;

before(async () => {
  t = await startTestServer();
  const su = await t.admin();
  inst = (await su.call('GET', '/admin/institutions')).body.institutions[0].id;
  tech = await t.user(su, ['tech'], [inst]);
  rad = await t.user(su, ['radiologist'], [inst]);
}, { timeout: 120000 });

after(async () => { await t?.stop(); });

// Fills a form with its normal answers plus something for every other required item.
function fill(definition, extra = {}) {
  const def = normalizeForm(definition);
  const a = initialAnswers(def);
  for (const s of def.sections) Object.assign(a, normalAnswers(s));
  Object.assign(a, extra);
  for (const m of validateAnswers(def, a, {}).missing) {
    const f = def.sections.flatMap(s => s.fields).find(x => x.id === m.id);
    if (f?.type === 'dims') a[f.id] = [4.2, 1.6, 1.5];
    else if (f?.type === 'number') a[f.id] = 5;
    else if (f?.type === 'date') a[f.id] = '2026-10-01';
    else if (f?.options) a[f.id] = f.type === 'multi' ? [f.options[0].value] : f.options[0].value;
  }
  return a;
}

async function submit(id, extra) {
  const { exam, form } = (await tech.call('GET', `/exams/${id}`)).body;
  const r = await tech.call('POST', `/exams/${id}/submit`, { answers: fill(form.definition, extra), row_version: exam.row_version });
  assert.equal(r.status, 200, JSON.stringify(r.body));
}

test('combining reports: headings for findings and impression, shared comparison', () => {
  assert.equal(defaultHeading('US Pelvis (female, non-OB)'), 'ULTRASOUND PELVIS');
  assert.equal(defaultHeading('Neck soft tissue'), 'NECK SOFT TISSUE');
  const fields = combineReports([
    { heading: 'ULTRASOUND ABDOMEN', fields: [{ id: 'indication', label: 'Indication', text: 'Pain.' }, { id: 'comparison', label: 'Comparison', text: 'None.' }, { id: 'findings', label: 'Findings', text: 'LIVER: Normal.' }] },
    { heading: 'ULTRASOUND RIGHT LOWER EXTREMITY VENOUS DOPPLER', fields: [{ id: 'indication', label: 'Indication', text: 'Leg swelling.' }, { id: 'comparison', label: 'Comparison', text: 'None.' }, { id: 'findings', label: 'Findings', text: 'No DVT.' }, { id: 'impression', label: 'Impression', text: 'No DVT.' }] },
  ]);
  const by = Object.fromEntries(fields.map(f => [f.id, f.text]));
  assert.equal(by.indication, 'Pain.\nLeg swelling.');
  assert.equal(by.comparison, 'None.');
  assert.equal(by.findings, 'ULTRASOUND ABDOMEN:\nLIVER: Normal.\n\nULTRASOUND RIGHT LOWER EXTREMITY VENOUS DOPPLER:\nNo DVT.');
  assert.equal(by.impression, 'ULTRASOUND RIGHT LOWER EXTREMITY VENOUS DOPPLER:\nNo DVT.');
  assert.deepEqual(fields.map(f => f.id), ['indication', 'comparison', 'findings', 'impression']);
});

test('linked studies: one form covers a separately billed Doppler', async () => {
  const studies = (await tech.call('GET', '/worklist/tech')).body.pacs.studies;
  const carlos = studies.filter(s => s.patient.last_name === 'TEST');
  const abdomen = carlos.find(s => s.description === 'US ABDOMEN COMPLETE');
  const doppler = carlos.find(s => s.description === 'US DOPPLER ABDOMEN');
  const dvt = carlos.find(s => s.description.startsWith('US VENOUS DUPLEX'));
  assert.ok(abdomen && doppler && dvt, 'mock PACS has the multipart visit');

  // Someone else's study can't be linked.
  const other = studies.find(s => s.patient.last_name === 'SAMPLE');
  let r = await tech.call('POST', '/exams', { study_uid: abdomen.study_uid, form_id: abdomen.suggested_form.id, linked_study_uids: [other.study_uid] });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /different patient/);

  r = await tech.call('POST', '/exams', { study_uid: abdomen.study_uid, form_id: abdomen.suggested_form.id, linked_study_uids: [doppler.study_uid] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const examId = r.body.id;
  let exam = (await tech.call('GET', `/exams/${examId}`)).body.exam;
  assert.deepEqual(exam.linked_studies.map(s => s.accession), [doppler.accession]);

  // The worklist marks the Doppler as covered; starting it opens the same exam.
  const wl = (await tech.call('GET', '/worklist/tech')).body.pacs.studies;
  assert.equal(wl.find(s => s.study_uid === doppler.study_uid).exam.linked, true);
  assert.equal(wl.find(s => s.study_uid === doppler.study_uid).exam.id, examId);
  r = await tech.call('POST', '/exams', { study_uid: doppler.study_uid, form_id: abdomen.suggested_form.id });
  assert.deepEqual(r.body, { id: examId, existing: true });

  // Related studies: this one, the linked Doppler, and the DVT study still free.
  const related = (await tech.call('GET', `/exams/${examId}/related-studies`)).body.studies;
  const state = Object.fromEntries(related.map(s => [s.description, s.state]));
  assert.deepEqual(state, { 'US ABDOMEN COMPLETE': 'this', 'US DOPPLER ABDOMEN': 'linked', 'US VENOUS DUPLEX LOWER EXT RIGHT': 'free' });

  // Unlink, then link again.
  r = await tech.call('PUT', `/exams/${examId}/studies`, { study_uids: [] });
  assert.deepEqual(r.body.linked_studies, []);
  r = await tech.call('PUT', `/exams/${examId}/studies`, { study_uids: [doppler.study_uid] });
  assert.equal(r.body.linked_studies.length, 1);

  // A study with its own form can't be linked to another.
  const dvtExam = (await tech.call('POST', '/exams', { study_uid: dvt.study_uid, form_id: dvt.suggested_form.id })).body.id;
  r = await tech.call('PUT', `/exams/${examId}/studies`, { study_uids: [doppler.study_uid, dvt.study_uid] });
  assert.equal(r.status, 409);
  exam = (await tech.call('GET', `/exams/${examId}`)).body.exam;
  assert.equal(exam.linked_studies.length, 1, 'a refused change leaves the links as they were');

  // Cancelling a form frees its linked studies.
  r = await tech.call('POST', `/exams/${examId}/cancel`, { row_version: exam.row_version });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  let wl2 = (await tech.call('GET', '/worklist/tech')).body.pacs.studies;
  assert.equal(wl2.find(s => s.study_uid === doppler.study_uid).exam, null);
  r = await tech.call('POST', '/exams', { study_uid: abdomen.study_uid, form_id: abdomen.suggested_form.id, linked_study_uids: [doppler.study_uid] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  wl2 = (await tech.call('GET', '/worklist/tech')).body.pacs.studies;
  assert.equal(wl2.find(s => s.study_uid === doppler.study_uid).exam.id, r.body.id);
  assert.equal(wl2.find(s => s.study_uid === dvt.study_uid).exam.id, dvtExam);
});

test('a visit is reported together: combined cards, one dictation, undo as a group', async () => {
  const studies = (await tech.call('GET', '/worklist/tech')).body.pacs.studies.filter(s => s.patient.last_name === 'TEST');
  const abdomenExam = studies.find(s => s.description === 'US ABDOMEN COMPLETE').exam.id;
  const dvtExam = studies.find(s => s.description.startsWith('US VENOUS DUPLEX')).exam.id;
  await submit(abdomenExam);
  await submit(dvtExam, { side: 'right' });

  // Grouped visit, oldest exam first (here the DVT form, started before the
  // abdomen form was restarted), with headings from the forms.
  const [first, second] = [abdomenExam, dvtExam].sort((a, b) => a - b);
  let visit = (await rad.call('GET', `/exams/${dvtExam}/visit`)).body.exams;
  assert.deepEqual(visit.map(e => e.id), [first, second]);
  const heading = Object.fromEntries(visit.map(e => [e.id, e.heading]));
  assert.equal(heading[abdomenExam], 'ULTRASOUND ABDOMEN');
  assert.equal(heading[dvtExam], 'ULTRASOUND RIGHT LOWER EXTREMITY VENOUS DOPPLER');
  assert.equal(visit.find(e => e.id === abdomenExam).linked_studies.length, 1);

  // Combined edits are stored on the first exam.
  let r = await rad.call('PUT', `/exams/${first}/report`, { row_version: visit[0].row_version, combined_with: [second], fields: { impression: 'Normal abdomen. No DVT.' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  visit = (await rad.call('GET', `/exams/${first}/visit`)).body.exams;
  assert.deepEqual(visit[0].final_report.combined, [first, second]);

  // A group can't include an exam from outside the visit.
  r = await rad.call('PUT', `/exams/${first}/report`, { row_version: visit[0].row_version, combined_with: [999999], fields: null });
  assert.equal(r.status, 400);

  r = await rad.call('POST', `/exams/${dvtExam}/dictated-group`, { versions: { [first]: visit[0].row_version, [second]: visit[1].row_version }, fields: { impression: 'Normal abdomen. No DVT.' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  for (const id of [first, second]) {
    const { exam } = (await rad.call('GET', `/exams/${id}`)).body;
    assert.equal(exam.status, 'dictated');
    assert.deepEqual(exam.final_report.combined, [first, second]);
    const by = Object.fromEntries(exam.final_report.fields.map(f => [f.id, f.text]));
    assert.match(by.findings, new RegExp(`^${heading[first]}:\\n[\\s\\S]+\\n\\n${heading[second]}:\\n`));
    assert.equal(by.impression, 'Normal abdomen. No DVT.');
  }

  // Moving one back moves the group back; the first exam keeps the edits.
  const { exam: secondNow } = (await rad.call('GET', `/exams/${second}`)).body;
  r = await rad.call('POST', `/exams/${second}/undictate`, { row_version: secondNow.row_version });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  visit = (await rad.call('GET', `/exams/${first}/visit`)).body.exams;
  assert.deepEqual(visit.map(e => e.status), ['submitted', 'submitted']);
  assert.deepEqual(visit[0].final_report.combined, [first, second]);
  assert.equal(visit[1].final_report, null);

  // Stale versions are refused and nothing changes.
  r = await rad.call('POST', `/exams/${first}/dictated-group`, { versions: { [first]: visit[0].row_version, [second]: 1 } });
  assert.equal(r.status, 409);
  visit = (await rad.call('GET', `/exams/${first}/visit`)).body.exams;
  assert.deepEqual(visit.map(e => e.status), ['submitted', 'submitted']);
});

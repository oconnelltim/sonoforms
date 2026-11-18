// Scanner reports: ultrasound machines push DICOM SR measurement reports to
// SonoForms, which holds them until an exam for the same study exists and
// then fills that exam's form. Sent over real DICOM to the receiver.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import dimse from 'dcmjs-dimse';
import { startTestServer } from './helpers.js';
import { carotidSR, ovariesSR } from '../scripts/lib/demo-sr.js';
import { measurements, mappingKey, parseSrSpec, findMeasurement, convertUnit, prefill } from '../shared/sr.js';
import { contentTree } from '../server/sr.js';

const { Client, Dataset } = dimse;
const { CStoreRequest, CEchoRequest } = dimse.requests;
const PORT = 56000 + Math.floor(Math.random() * 3000);

let t, tech, su, inst, receiver, studies;

before(async () => {
  t = await startTestServer();
  su = await t.admin();
  inst = (await su.call('GET', '/admin/institutions')).body.institutions[0];
  // This institution's scanner: RCH_US1, sending to our AE title SONOFORMS.
  const r = await su.call('PUT', `/admin/institutions/${inst.id}`, { dicom: { ...inst.dicom, scanners: ['rch_us1'] } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  tech = await t.user(su, ['tech', 'radiologist'], [inst.id]);
  const { startScannerReceiver } = await import('../server/scanner-receiver.js');
  receiver = startScannerReceiver(PORT, { info() {}, warn() {} });
  const { mockStudies } = await import('../server/dicom.js');
  studies = mockStudies({ id: inst.id });
}, { timeout: 120000 });

after(async () => { receiver?.close(); await t?.stop(); });

// Sends datasets with C-STORE; resolves to the statuses, or 'rejected' if the
// association is refused.
function send(datasets, { calling = 'RCH_US1', called = 'SONOFORMS', echo = false } = {}) {
  return new Promise((resolve) => {
    const client = new Client();
    const statuses = [];
    const requests = echo ? [new CEchoRequest()] : datasets.map(ds => new CStoreRequest(new Dataset(ds)));
    for (const req of requests) { req.on('response', r => statuses.push(r.getStatus())); client.addRequest(req); }
    client.on('associationRejected', () => resolve('rejected'));
    client.on('networkError', e => resolve(`network error: ${e.message}`));
    client.on('closed', () => resolve(statuses));
    client.send('127.0.0.1', PORT, calling, called);
  });
}

const study = desc => studies.find(s => s.StudyDescription === desc);
const CAROTID = {
  right: { cca: [67.69554, 18.1304], ica: [61.15188, 28.55493], eca: [58.55685, 5.086228] },
  left: { cca: [72.4, 20.1], ica: [142.0, 41.2], eca: [88.3, 9.8] },
};

async function startExam(desc, formId) {
  const s = (await tech.call('GET', '/worklist/tech')).body.pacs.studies.find(x => x.description === desc);
  const r = await tech.call('POST', '/exams', { study_uid: s.study_uid, form_id: formId ?? s.suggested_form.id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.id;
}

test('measurements: chosen values, sides and mapping keys from GE-style reports', () => {
  const ms = measurements(contentTree(carotidSR(study('US CAROTID DUPLEX BILATERAL'), CAROTID)));
  const ica = ms.filter(m => m.key === 'LN:11726-7' && m.pathKeys.includes('SRT:T-45300'));
  assert.deepEqual(ica.map(m => [m.side, m.value, m.chosen]), [['right', 61.15188, true], ['left', 142, true]]);
  assert.equal(mappingKey(ica[1]), 'LN:11726-7 in SRT:T-45300 left');
  // Each ovary size is recorded twice; the mean (Selection Status) is the one used.
  const ov = measurements(contentTree(ovariesSR(study('US PELVIS COMPLETE TRANSVAGINAL'), { right: [3.15, 1.59, 2.86], left: [2.37, 1.57, 2.25] })));
  const len = ov.filter(m => m.key === 'LN:11841-4');
  assert.deepEqual(len.map(m => m.chosen), [false, true]);
  assert.equal(findMeasurement(ov, 'LN:11841-4').selection, 'Mean value chosen');
});

test('mapping keys: newer SNOMED CT codes match, units convert, bad keys are explained', () => {
  const ms = measurements(contentTree(carotidSR(study('US CAROTID DUPLEX BILATERAL'), CAROTID)));
  assert.equal(findMeasurement(ms, 'LN:11726-7 in SCT:86117002 left').value, 142);    // ICA in SNOMED CT
  assert.equal(findMeasurement(ms, 'LN:11726-7 in SRT:T-45300 bilateral'), null);
  assert.equal(convertUnit(1.42, 'm/s', 'cm/s'), 142);
  assert.equal(convertUnit(31.5, 'mm', 'cm'), 3.15);
  assert.equal(convertUnit(3.1, 'cm', ''), null, 'a length never fills a field without a unit');
  assert.equal(convertUnit(0.9, '1', ''), 0.9);
  assert.throws(() => parseSrSpec('LN:11726-7 inside SRT:T-45300'), /doesn't understand "inside"/);
  // A dims field fills only when all three sizes are found.
  const def = { sections: [{ fields: [{ id: 'r_ovary', type: 'dims', unit: 'mm', sr: ['LN:11841-4', 'LN:11858-8', 'LN:11830-7'] }] }] };
  const ov = measurements(contentTree(ovariesSR(study('US PELVIS COMPLETE TRANSVAGINAL'), { right: [3.15, 1.59, 2.86] })));
  assert.deepEqual(prefill(def, [{ id: 1, measurements: ov }]).values, { r_ovary: [31.5, 15.9, 28.6] });
});

test('only listed scanners can send, to our AE title, and only SR objects', async () => {
  assert.equal(await send([], { calling: 'SOMEONE_ELSE', echo: true }), 'rejected');
  assert.equal(await send([], { called: 'WRONG_AE', echo: true }), 'rejected');
  assert.deepEqual(await send([], { echo: true }), [0]);
  // A CT image isn't an SR: the presentation context is refused, so nothing is stored.
  const ct = { ...carotidSR(study('US CAROTID DUPLEX BILATERAL'), CAROTID), SOPClassUID: '1.2.840.10008.5.1.4.1.1.2' };
  const r = await send([ct]);
  assert.ok(r === 'rejected' || (Array.isArray(r) && r.every(s => s !== 0)), JSON.stringify(r));
  const list = (await su.call('GET', '/admin/scanner-reports')).body.reports;
  assert.equal(list.length, 0);
});

test('a report sent before the form is started fills the carotid form once it is', async () => {
  const ds = carotidSR(study('US CAROTID DUPLEX BILATERAL'), CAROTID);
  assert.deepEqual(await send([ds]), [0]);
  let list = (await su.call('GET', '/admin/scanner-reports')).body.reports;
  assert.equal(list.length, 1);
  assert.equal(list[0].matched, false);
  assert.equal(list[0].calling_ae, 'RCH_US1');
  assert.ok(!JSON.stringify(list).includes('SAMPLE'), 'no patient details for administrators');

  // Re-sending the same report replaces it.
  assert.deepEqual(await send([ds]), [0]);
  assert.equal((await su.call('GET', '/admin/scanner-reports')).body.reports.length, 1);

  const forms = (await tech.call('GET', '/forms/available?description=US%20CAROTID')).body;
  const carotid = forms.find(f => f.title === 'US Carotid Duplex');
  const examId = await startExam('US CAROTID DUPLEX BILATERAL', carotid.id);
  const r = await tech.call('GET', `/exams/${examId}/scanner`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.reports.length, 1);
  assert.equal(r.body.reports[0].patient_mismatch, false);
  assert.deepEqual(r.body.values, {
    r_cca_psv: 67.69554, r_cca_edv: 18.1304, r_ica_psv: 61.15188, r_ica_edv: 28.55493, r_eca_psv: 58.55685,
    l_cca_psv: 72.4, l_cca_edv: 20.1, l_ica_psv: 142, l_ica_edv: 41.2, l_eca_psv: 88.3,
  });
  list = (await su.call('GET', '/admin/scanner-reports')).body.reports;
  assert.equal(list[0].matched, true);

  // Submitted with those values, the report grades the left ICA by SRU criteria.
  const { exam, form } = (await tech.call('GET', `/exams/${examId}`)).body;
  const { normalizeForm, initialAnswers, normalAnswers } = await import('../shared/formdef.js');
  const def = normalizeForm(form.definition);
  const answers = { ...initialAnswers(def), indication: ['tia'], ...r.body.values };
  for (const s of def.sections) for (const [k, v] of Object.entries(normalAnswers(s))) if (answers[k] === undefined || answers[k] === null) answers[k] = v;
  const sub = await tech.call('POST', `/exams/${examId}/submit`, { answers, row_version: exam.row_version });
  assert.equal(sub.status, 200, JSON.stringify(sub.body));
  const done = (await tech.call('GET', `/exams/${examId}`)).body.exam;
  const impression = done.report.fields.find(f => f.id === 'impression').text;
  assert.match(impression, /Right internal carotid artery: no stenosis/);
  assert.match(impression, /Left internal carotid artery: 50-69% stenosis/);
  assert.match(done.report.fields.find(f => f.id === 'findings').text, /LEFT CAROTID: Common carotid artery peak systolic velocity 72\.4 cm\/s/);
});

test('ovary sizes fill the pelvis form; a different patient ID is not used', async () => {
  const pelvis = study('US PELVIS COMPLETE TRANSVAGINAL');
  assert.deepEqual(await send([ovariesSR(pelvis, { right: [3.153901, 1.589761, 2.857344], left: [2.367066, 1.568643, 2.249995] })]), [0]);
  const examId = await startExam('US PELVIS COMPLETE TRANSVAGINAL');
  let r = (await tech.call('GET', `/exams/${examId}/scanner`)).body;
  assert.deepEqual(r.values, { r_ovary: [3.153901, 1.589761, 2.857344], l_ovary: [2.367066, 1.568643, 2.249995] });

  // A second report for the same study but naming another patient: shown, not used.
  const wrong = { ...ovariesSR(pelvis, { right: [9, 9, 9] }), PatientID: 'SOMEONE-ELSE', SOPInstanceUID: `${pelvis.StudyInstanceUID}.99.7` };
  assert.deepEqual(await send([wrong]), [0]);
  r = (await tech.call('GET', `/exams/${examId}/scanner`)).body;
  assert.equal(r.reports.length, 2);
  assert.equal(r.reports.find(x => x.patient_mismatch === true).measurements.length > 0, true);
  assert.deepEqual(r.values.r_ovary, [3.153901, 1.589761, 2.857344]);

  // Cancelling the exam lets a new exam for the study pick the reports up.
  const { exam } = (await tech.call('GET', `/exams/${examId}`)).body;
  assert.equal((await tech.call('POST', `/exams/${examId}/cancel`, { row_version: exam.row_version })).status, 200);
  const again = await startExam('US PELVIS COMPLETE TRANSVAGINAL');
  assert.notEqual(again, examId);
  assert.equal((await tech.call('GET', `/exams/${again}/scanner`)).body.reports.length, 2);
});

test('the SR viewer gives the same mapping keys as the server', async () => {
  const fs = await import('node:fs'); const vm = await import('node:vm'); const dcmjs = (await import('dcmjs')).default;
  const html = fs.readFileSync('tools/sr-viewer/index.html', 'utf8');
  const ctx = { module: { exports: {} }, TextDecoder };
  vm.createContext(ctx);
  vm.runInContext(html.match(/<script id="sr-core">([\s\S]*?)<\/script>/)[1], ctx);
  const viewer = ctx.module.exports;
  const ds = carotidSR(study('US CAROTID DUPLEX BILATERAL'), CAROTID);
  const meta = { FileMetaInformationVersion: new Uint8Array([0, 1]).buffer, MediaStorageSOPClassUID: ds.SOPClassUID, MediaStorageSOPInstanceUID: ds.SOPInstanceUID, TransferSyntaxUID: '1.2.840.10008.1.2.1', ImplementationClassUID: '1.2.3.4' };
  const dict = new dcmjs.data.DicomDict(dcmjs.data.DicomMetaDictionary.denaturalizeDataset(meta));
  dict.dict = dcmjs.data.DicomMetaDictionary.denaturalizeDataset(ds);
  const parsed = await viewer.parse(new Uint8Array(dict.write()));
  const fromViewer = viewer.measurements(viewer.contentItem(parsed.dataset, 0)).filter(m => m.chosen).map(m => viewer.mappingKey(m));
  const fromServer = measurements(contentTree(ds)).filter(m => m.chosen).map(m => mappingKey(m));
  assert.deepEqual([...fromViewer], fromServer);
  for (const k of fromServer) parseSrSpec(k);   // and every one is a valid form mapping
});

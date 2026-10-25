// PACS query guardrails, tested over real DICOM against a fake PACS that
// records every query it receives.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import dimse from 'dcmjs-dimse';

process.env.DICOM_MOCK = 'false';
process.env.LOG_LEVEL = 'silent';
const { todaysStudies, studyByUid, clearCache } = await import('../server/dicom.js');

const { Server, Scp, Dataset } = dimse;
const { CEchoResponse, CFindResponse } = dimse.responses;
const { Status, PresentationContextResult, SopClass, TransferSyntax } = dimse.constants;

// What the fake PACS does; tests change it.
const pacs = { queries: [], studies: 10, sendFinal: true, wrongUid: false, delayMs: 0 };

const pad = n => String(n).padStart(2, '0');
const today = new Date();
const dicomToday = `${today.getFullYear()}${pad(today.getMonth() + 1)}${pad(today.getDate())}`;

class FakePacs extends Scp {
  associationRequested(association) {
    for (const context of association.getPresentationContexts()) {
      const ctx = association.getPresentationContext(context.id);
      if ([SopClass.Verification, SopClass.StudyRootQueryRetrieveInformationModelFind].includes(ctx.getAbstractSyntaxUid())) {
        ctx.setResult(PresentationContextResult.Accept, TransferSyntax.ImplicitVRLittleEndian);
      } else {
        ctx.setResult(PresentationContextResult.RejectAbstractSyntaxNotSupported);
      }
    }
    this.sendAssociationAccept();
  }
  cEchoRequest(request, callback) {
    const r = CEchoResponse.fromRequest(request);
    r.setStatus(Status.Success);
    callback(r);
  }
  cFindRequest(request, callback) {
    const q = request.getDataset().getElements();
    pacs.queries.push(q);
    const uidQuery = q.StudyInstanceUID;
    const n = uidQuery ? 1 : pacs.studies;
    const responses = Array.from({ length: n }, (_, i) => {
      const r = CFindResponse.fromRequest(request);
      r.setDataset(new Dataset({
        PatientName: [{ Alphabetic: `PATIENT^${i}` }], PatientID: `MRN${i}`, StudyDate: dicomToday, StudyTime: '080000',
        StudyInstanceUID: uidQuery ? (pacs.wrongUid ? `${uidQuery}.9` : uidQuery) : `1.2.3.${i}`,
        StudyDescription: 'US ABDOMEN', ModalitiesInStudy: 'US', AccessionNumber: `A${i}`,
      }));
      r.setStatus(Status.Pending);
      return r;
    });
    if (pacs.sendFinal) {
      const done = CFindResponse.fromRequest(request);
      done.setStatus(Status.Success);
      responses.push(done);
    }
    setTimeout(() => callback(responses), pacs.delayMs);
  }
  cCancelRequest() { /* the fake PACS may ignore cancels; see sendFinal */ }
  associationReleaseRequested() { this.sendAssociationReleaseResponse(); }
}

const port = 41000 + Math.floor(Math.random() * 2000);
let server;
const institution = (dicom = {}) => ({ id: Math.floor(Math.random() * 1e9), name: 'Test', dicom: { enabled: true, host: '127.0.0.1', port, called_ae: 'FAKE', calling_ae: 'TEST', modality: 'US', filters: [], ...dicom } });

before(() => {
  dimse.log.setLevel('silent');
  server = new Server(FakePacs);
  server.listen(port);
});
after(() => server.close());
beforeEach(() => {
  Object.assign(pacs, { queries: [], studies: 10, sendFinal: true, wrongUid: false, delayMs: 0 });
  clearCache();
});

test('a large result set is stopped at the limit and flagged', async () => {
  pacs.studies = 400;
  const r = await todaysStudies(institution({ max_results: 50 }), 24);
  assert.equal(r.studies.length, 50);
  assert.equal(r.truncated, true);
});

test('a PACS that ignores the cancel is disconnected, not waited on forever', async () => {
  pacs.studies = 200;
  pacs.sendFinal = false;
  const start = Date.now();
  const r = await todaysStudies(institution({ max_results: 50 }), 24);
  assert.equal(r.studies.length, 50);
  assert.equal(r.truncated, true);
  assert.ok(Date.now() - start < 10000);
});

test('queries without a modality or PACS-side institution filter are refused', async () => {
  await assert.rejects(todaysStudies(institution({ modality: '' }), 24), /not narrowed/);
  await assert.rejects(todaysStudies(institution({ modality: '', filters: [{ tag: 'InstitutionName', value: '*', mode: 'query' }] }), 24), /not narrowed/);
  await assert.rejects(todaysStudies(institution({ modality: '', filters: [{ tag: 'InstitutionName', value: 'GEN*', mode: 'local' }] }), 24), /not narrowed/);
  const ok = await todaysStudies(institution({ modality: '', filters: [{ tag: 'InstitutionName', value: 'GEN*', mode: 'query' }] }), 24);
  assert.equal(ok.configured, true);
  assert.equal(pacs.queries.length, 1);
  assert.equal(pacs.queries[0].InstitutionName, 'GEN*');
});

test('every worklist query carries a date limit and the modality', async () => {
  await todaysStudies(institution(), 24);
  const q = pacs.queries[0];
  assert.match(String(q.StudyDate).trim(), /^\d{8}(-\d{8})?$/, 'DICOM pads values to an even length');
  assert.equal(q.ModalitiesInStudy, 'US');
});

test('simultaneous worklist loads share one PACS query; refreshes are rate-limited', async () => {
  pacs.delayMs = 200;
  const inst = institution();
  await Promise.all(Array.from({ length: 8 }, () => todaysStudies(inst, 24)));
  assert.equal(pacs.queries.length, 1);
  await todaysStudies(inst, 24, { force: true });
  await todaysStudies(inst, 24, { force: true });
  assert.equal(pacs.queries.length, 1, 'forced refresh within 10 s reuses the result');
});

test('"one day at a time" sends single dates; "Modality" can replace Modalities in Study', async () => {
  await todaysStudies(institution({ date_mode: 'single', modality_key: 'Modality' }), 50);
  assert.ok(pacs.queries.length >= 3);
  for (const q of pacs.queries) {
    assert.match(String(q.StudyDate), /^\d{8}$/);
    assert.equal(q.Modality, 'US');
  }
});

test('a by-UID lookup only accepts the exact study asked for', async () => {
  const inst = institution();
  assert.equal((await studyByUid(inst, '1.2.3.4')).study_uid, '1.2.3.4');
  pacs.wrongUid = true;
  assert.equal(await studyByUid(inst, '1.2.3.4'), null);
  assert.equal(await studyByUid(inst, ''), null, 'a blank UID is never sent (it would match everything)');
});

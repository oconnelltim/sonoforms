// The SR viewer's DICOM parser and measurement extraction
// (tools/sr-viewer/index.html), run against synthetic SR files written by
// dcmjs in both explicit and implicit VR encodings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import dcmjs from 'dcmjs';

dcmjs.log.level = 'error';

// The page's parser script, run on its own.
const html = fs.readFileSync('tools/sr-viewer/index.html', 'utf8');
const ctx = { module: { exports: {} }, TextDecoder };
vm.createContext(ctx);
vm.runInContext(html.match(/<script id="sr-core">([\s\S]*?)<\/script>/)[1], ctx);
const SR = ctx.module.exports;
// Results come from the sandbox; copy them into this realm before comparing.
const plain = v => JSON.parse(JSON.stringify(v));

const code = (value, scheme, meaning) => [{ CodeValue: value, CodingSchemeDesignator: scheme, CodeMeaning: meaning }];
const num = (concept, value, unit, children) => ({
  RelationshipType: 'CONTAINS', ValueType: 'NUM', ConceptNameCodeSequence: concept,
  MeasuredValueSequence: [{ NumericValue: value, MeasurementUnitsCodeSequence: code(unit, 'UCUM', unit) }],
  ...(children ? { ContentSequence: children } : {}),
});
const mod = (rel, concept, value) => ({ RelationshipType: rel, ValueType: 'CODE', ConceptNameCodeSequence: concept, ConceptCodeSequence: value });

// A small carotid report: right side, CCA and ICA peak systolic velocities,
// the ICA one recorded twice with the tech's choice marked.
function carotidSR(transferSyntax) {
  const dataset = {
    SpecificCharacterSet: 'ISO_IR 100',
    SOPClassUID: '1.2.840.10008.5.1.4.1.1.88.33', SOPInstanceUID: '1.2.3.4.5.6',
    Modality: 'SR', Manufacturer: 'Test Vendor', ManufacturerModelName: 'Scanner 1',
    StudyInstanceUID: '1.2.3.4.5', SeriesInstanceUID: '1.2.3.4.5.1', StudyDate: '20261104', ContentDate: '20261104', ContentTime: '101500',
    PatientName: 'TEST^PATIENT', PatientID: 'MRN123', AccessionNumber: 'ACC1',
    CompletionFlag: 'PARTIAL', VerificationFlag: 'UNVERIFIED',
    ValueType: 'CONTAINER', ContinuityOfContent: 'SEPARATE',
    ConceptNameCodeSequence: code('125100', 'DCM', 'Vascular Ultrasound Procedure Report'),
    ContentTemplateSequence: [{ MappingResource: 'DCMR', TemplateIdentifier: '5100' }],
    ContentSequence: [{
      RelationshipType: 'CONTAINS', ValueType: 'CONTAINER', ContinuityOfContent: 'SEPARATE',
      ConceptNameCodeSequence: code('121070', 'DCM', 'Findings'),
      ContentSequence: [
        mod('HAS CONCEPT MOD', code('G-C171', 'SRT', 'Laterality'), code('G-A100', 'SRT', 'Right')),
        {
          RelationshipType: 'CONTAINS', ValueType: 'CONTAINER', ContinuityOfContent: 'SEPARATE',
          ConceptNameCodeSequence: code('T-45100', 'SRT', 'Common Carotid Artery'),
          ContentSequence: [num(code('11726-7', 'LN', 'Peak Systolic Velocity'), 67.7, 'cm/s')],
        },
        {
          RelationshipType: 'CONTAINS', ValueType: 'CONTAINER', ContinuityOfContent: 'SEPARATE',
          ConceptNameCodeSequence: code('T-45300', 'SRT', 'Internal Carotid Artery'),
          ContentSequence: [
            num(code('11726-7', 'LN', 'Peak Systolic Velocity'), 58.1, 'cm/s'),
            num(code('11726-7', 'LN', 'Peak Systolic Velocity'), 61.2, 'cm/s', [
              mod('HAS PROPERTIES', code('121404', 'DCM', 'Selection Status'), code('121410', 'DCM', 'User chosen value')),
            ]),
          ],
        },
      ],
    }],
  };
  const meta = {
    FileMetaInformationVersion: new Uint8Array([0, 1]).buffer,
    MediaStorageSOPClassUID: dataset.SOPClassUID, MediaStorageSOPInstanceUID: dataset.SOPInstanceUID,
    TransferSyntaxUID: transferSyntax, ImplementationClassUID: '1.2.3.4',
  };
  const dict = new dcmjs.data.DicomDict(dcmjs.data.DicomMetaDictionary.denaturalizeDataset(meta));
  dict.dict = dcmjs.data.DicomMetaDictionary.denaturalizeDataset(dataset);
  return new Uint8Array(dict.write());
}

for (const [name, ts] of [['explicit VR', '1.2.840.10008.1.2.1'], ['implicit VR', '1.2.840.10008.1.2']]) {
  test(`SR viewer reads a carotid report (${name})`, async () => {
    const parsed = await SR.parse(carotidSR(ts));
    assert.equal(parsed.transferSyntax, ts);
    const s = SR.summary(parsed);
    assert.equal(s.isSR, true);
    assert.equal(s.title, 'Vascular Ultrasound Procedure Report');
    assert.equal(s.template, 'TID 5100 · Vascular Ultrasound Procedure Report');
    assert.equal(s.studyUID, '1.2.3.4.5');
    assert.equal(s.patientID, 'MRN123');

    const ms = SR.measurements(SR.contentItem(parsed.dataset, 0));
    assert.equal(ms.length, 3);
    assert.deepEqual(plain(ms.map(m => [m.path.join(' > '), m.key, m.value, m.unit, m.laterality, m.chosen])), [
      ['Findings > Common Carotid Artery', 'LN:11726-7', 67.7, 'cm/s', 'Right', true],
      ['Findings > Internal Carotid Artery', 'LN:11726-7', 58.1, 'cm/s', 'Right', false],
      ['Findings > Internal Carotid Artery', 'LN:11726-7', 61.2, 'cm/s', 'Right', true],
    ]);
    assert.equal(ms[2].selection, 'User chosen value');
    assert.equal(SR.mappingKey(ms[2]), 'LN:11726-7 · in SRT:T-45300 · right');
  });
}

test('SR viewer says plainly when a file is not DICOM', async () => {
  await assert.rejects(SR.parse(new TextEncoder().encode('<!doctype html><p>hello</p>')), /doesn’t look like a DICOM file/);
});

test('SR viewer rejects truncated files with a clear message', async () => {
  const bytes = carotidSR('1.2.840.10008.1.2.1');
  for (const cut of [1, 40, 200]) {
    await assert.rejects(SR.parse(bytes.subarray(0, bytes.length - cut)), /ends unexpectedly/, `cut ${cut} bytes`);
  }
});

test('SR viewer converts GE SI values to the displayed unit', () => {
  assert.equal(Math.round(SR.displayValue({ value: 0.6769554, displayUnit: 'cm/s' }) * 1e4) / 1e4, 67.6955);
  assert.equal(Math.round(SR.displayValue({ value: 0.000007501379, displayUnit: 'ml' }) * 1e6) / 1e6, 7.501379);
  assert.equal(SR.displayValue({ value: 93.75, displayUnit: 'BPM' }), 93.75);
});

// SPDX-License-Identifier: GPL-3.0-or-later
//
// Reads DICOM Structured Reports (the measurement reports ultrasound
// machines send) into the content tree that shared/sr.js understands. Works
// on dcmjs "naturalized" datasets, which is what both the DICOM receiver
// (dcmjs-dimse) and dcmjs.data.DicomMessage give us.

import dcmjs from 'dcmjs';
import { measurements, mappingKey } from '../shared/sr.js';

dcmjs.log.level = 'error';

// SR storage classes we accept from scanners.
export const SR_SOP_CLASSES = {
  '1.2.840.10008.5.1.4.1.1.88.11': 'Basic Text SR',
  '1.2.840.10008.5.1.4.1.1.88.22': 'Enhanced SR',
  '1.2.840.10008.5.1.4.1.1.88.33': 'Comprehensive SR',
  '1.2.840.10008.5.1.4.1.1.88.34': 'Comprehensive 3D SR',
  '1.2.840.10008.5.1.4.1.1.88.35': 'Extensible SR',
};

const TEMPLATES = {
  5000: 'OB-GYN Ultrasound Procedure Report', 5100: 'Vascular Ultrasound Procedure Report', 5200: 'Echocardiography Procedure Report',
};

const arr = x => (x === undefined || x === null ? [] : Array.isArray(x) ? x : [x]);
const text = (v) => {
  const x = arr(v)[0];
  if (x === undefined || x === null) return '';
  if (typeof x === 'object' && 'Alphabetic' in x) return String(x.Alphabetic || '');
  return String(x).trim();
};
const code = (seq) => {
  const c = arr(seq)[0];
  return c ? { value: text(c.CodeValue) || text(c.LongCodeValue) || text(c.URNCodeValue), scheme: text(c.CodingSchemeDesignator), meaning: text(c.CodeMeaning) } : null;
};
const MAX_DEPTH = 64;

// One content item (and its children) as a plain tree node.
export function contentTree(item, depth = 0) {
  const node = {
    relationship: text(item.RelationshipType) || null,
    valueType: text(item.ValueType),
    concept: code(item.ConceptNameCodeSequence),
    children: [],
  };
  switch (node.valueType) {
    case 'NUM': {
      const mv = arr(item.MeasuredValueSequence)[0];
      const fp = mv && arr(mv.FloatingPointValue)[0];
      const n = fp !== undefined ? Number(fp) : (mv ? Number(text(mv.NumericValue)) : NaN);
      node.value = mv && Number.isFinite(n) ? n : null;
      node.unit = mv ? code(mv.MeasurementUnitsCodeSequence) : null;
      break;
    }
    case 'CODE': node.code = code(item.ConceptCodeSequence); break;
    case 'TEXT': node.text = text(item.TextValue); break;
    default: break;
  }
  if (depth < MAX_DEPTH) for (const child of arr(item.ContentSequence)) node.children.push(contentTree(child, depth + 1));
  return node;
}

// What SonoForms keeps from a report: identifiers to match it with, a short
// description, and its measurements. Throws if it isn't an SR.
export function readReport(ds) {
  const sop = text(ds.SOPClassUID);
  if (!SR_SOP_CLASSES[sop]) throw new Error(`not a supported structured report (SOP class ${sop || 'missing'})`);
  const studyUid = text(ds.StudyInstanceUID);
  if (!studyUid) throw new Error('the report has no Study Instance UID');
  const tid = text(arr(ds.ContentTemplateSequence)[0]?.TemplateIdentifier);
  const list = measurements(contentTree(ds)).map(m => ({ ...m, mappingKey: mappingKey(m) }));
  return {
    studyUid,
    sopInstanceUid: text(ds.SOPInstanceUID),
    summary: {
      title: code(ds.ConceptNameCodeSequence)?.meaning || SR_SOP_CLASSES[sop],
      template: tid ? `TID ${tid}${TEMPLATES[tid] ? ` · ${TEMPLATES[tid]}` : ''}` : '',
      device: [text(ds.Manufacturer), text(ds.ManufacturerModelName)].filter(Boolean).join(' '),
      contentDate: text(ds.ContentDate), contentTime: text(ds.ContentTime),
      studyDate: text(ds.StudyDate), accession: text(ds.AccessionNumber),
      patientId: text(ds.PatientID), patientName: text(ds.PatientName),
      completion: text(ds.CompletionFlag), verification: text(ds.VerificationFlag),
    },
    measurements: list,
  };
}

// Reads an SR from a DICOM Part 10 file (a Buffer).
export function readReportFile(buffer) {
  const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const dicom = dcmjs.data.DicomMessage.readFile(ab, { ignoreErrors: true });
  return readReport(dcmjs.data.DicomMetaDictionary.naturalizeDataset(dicom.dict));
}

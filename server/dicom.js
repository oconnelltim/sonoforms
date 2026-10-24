// SPDX-License-Identifier: GPL-3.0-or-later
//
// Today's worklist from PACS via a study-level DICOM C-FIND, configured per
// institution in Admin > Institutions. The only network connections this
// application ever opens are these, to the PACS address an admin configures.

import dimse from 'dcmjs-dimse';
import { config } from './config.js';

const { Client } = dimse;
const { CFindRequest, CEchoRequest } = dimse.requests;
const { Status } = dimse.constants;

dimse.log.setLevel('warn');

export const RETURN_KEYS = [
  'PatientName', 'PatientID', 'IssuerOfPatientID', 'PatientBirthDate', 'PatientSex',
  'StudyInstanceUID', 'AccessionNumber', 'StudyDate', 'StudyTime', 'StudyDescription',
  'ModalitiesInStudy', 'ReferringPhysicianName', 'InstitutionName',
];

const pad = n => String(n).padStart(2, '0');
const dicomDate = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;

function pn(v) {
  if (!v) return '';
  if (Array.isArray(v)) v = v[0];
  if (v && typeof v === 'object') v = v.Alphabetic || '';
  return String(v || '');
}

const str = v => (Array.isArray(v) ? v.join('\\') : (v === undefined || v === null ? '' : String(v))).trim();

// Convert a C-FIND result into the shape the app uses.
export function toStudy(el) {
  const [last = '', first = '', middle = ''] = pn(el.PatientName).split('^');
  const date = str(el.StudyDate);
  const time = str(el.StudyTime).replace(/[^0-9]/g, '').padEnd(6, '0').slice(0, 6);
  const dob = str(el.PatientBirthDate);
  return {
    study_uid: str(el.StudyInstanceUID),
    accession: str(el.AccessionNumber),
    description: str(el.StudyDescription),
    modalities: str(el.ModalitiesInStudy),
    institution_name: str(el.InstitutionName),
    referring: pn(el.ReferringPhysicianName).replace(/\^+/g, ' ').trim(),
    datetime: /^\d{8}$/.test(date) ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}` : null,
    patient: {
      mrn: str(el.PatientID),
      issuer: str(el.IssuerOfPatientID),
      last_name: last.trim(),
      first_name: [first, middle].filter(Boolean).join(' ').trim(),
      dob: /^\d{8}$/.test(dob) ? `${dob.slice(0, 4)}-${dob.slice(4, 6)}-${dob.slice(6, 8)}` : '',
      sex: str(el.PatientSex).slice(0, 1).toUpperCase(),
    },
  };
}

function runFind(settings, elements, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const results = [];
    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      err ? reject(err) : resolve(results);
    };
    const timer = setTimeout(() => done(new Error('PACS did not answer in time')), timeoutMs);
    const client = new Client();
    const request = CFindRequest.createStudyFindRequest(elements);
    request.on('response', (response) => {
      const status = response.getStatus();
      if ((status === Status.Pending || status === 0xff01) && response.hasDataset()) {
        results.push(response.getDataset().getElements());
      } else if (status === Status.Success) {
        done();
      } else if (status !== Status.Pending && status !== 0xff01) {
        done(new Error(`PACS returned DICOM status 0x${Number(status).toString(16)}`));
      }
    });
    client.addRequest(request);
    client.on('associationRejected', (r) => done(new Error(`PACS rejected the connection (check AE titles). Reason: ${JSON.stringify(r?.reason ?? r)}`)));
    client.on('networkError', (e) => done(new Error(`Could not reach PACS: ${e?.message || e}`)));
    client.on('closed', () => done());
    client.send(settings.host, Number(settings.port), settings.calling_ae || 'SONOFORMS', settings.called_ae || 'ANY-SCP', {
      connectTimeout: 5000, associationTimeout: 10000, pduTimeout: timeoutMs,
    });
  });
}

export function echo(settings) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    const request = new CEchoRequest();
    let ok = false;
    const timer = setTimeout(() => reject(new Error('PACS did not answer in time')), 10000);
    request.on('response', (response) => { ok = response.getStatus() === Status.Success; });
    client.addRequest(request);
    client.on('associationRejected', () => { clearTimeout(timer); reject(new Error('PACS rejected the connection (check AE titles)')); });
    client.on('networkError', (e) => { clearTimeout(timer); reject(new Error(`Could not reach PACS: ${e?.message || e}`)); });
    client.on('closed', () => { clearTimeout(timer); ok ? resolve(true) : reject(new Error('C-ECHO failed')); });
    client.send(settings.host, Number(settings.port), settings.calling_ae || 'SONOFORMS', settings.called_ae || 'ANY-SCP', { connectTimeout: 5000 });
  });
}

function baseElements(settings) {
  const elements = Object.fromEntries(RETURN_KEYS.map(k => [k, '']));
  for (const f of settings.filters || []) {
    if (f && f.tag && (f.mode || 'query') === 'query' && RETURN_KEYS.includes(f.tag)) elements[f.tag] = String(f.value ?? '');
  }
  return elements;
}

// Local filters handle PACS that don't support matching on a key at the study level.
function localFilter(settings) {
  const rules = (settings.filters || []).filter(f => f && f.tag && f.mode === 'local' && f.value);
  const compiled = rules.map(r => {
    const pattern = String(r.value).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    return { tag: r.tag, re: new RegExp(`^${pattern}$`, 'i') };
  });
  return el => compiled.every(({ tag, re }) => re.test(tag === 'PatientName' || tag === 'ReferringPhysicianName' ? pn(el[tag]) : str(el[tag])));
}

const cache = new Map();

// Studies from the last `hours`, newest first.
export async function todaysStudies(institution, hours = 24, { force = false } = {}) {
  const settings = institution.dicom || {};
  if (!config.dicomMock && (!settings.enabled || !settings.host || !settings.port)) return { configured: false, studies: [] };
  const key = `${institution.id}:${hours}`;
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < 30000) return hit.value;

  const now = new Date();
  const since = new Date(now.getTime() - hours * 3600000);
  let raw;
  if (config.dicomMock) raw = mockStudies(institution);
  else {
    const elements = baseElements(settings);
    elements.StudyDate = dicomDate(since) === dicomDate(now) ? dicomDate(now) : `${dicomDate(since)}-${dicomDate(now)}`;
    if (settings.modality !== '') elements.ModalitiesInStudy = settings.modality || 'US';
    raw = await runFind(settings, elements);
  }
  const keep = localFilter(settings);
  const studies = raw.filter(keep).map(toStudy)
    .filter(s => s.study_uid && (!s.datetime || new Date(s.datetime) >= since))
    .sort((a, b) => String(b.datetime || '').localeCompare(String(a.datetime || '')));
  const value = { configured: true, studies };
  cache.set(key, { at: Date.now(), value });
  return value;
}

// Re-query a single study by UID so demographics come from PACS, not the browser.
export async function studyByUid(institution, studyUid) {
  if (config.dicomMock) {
    const el = mockStudies(institution).find(s => s.StudyInstanceUID === studyUid);
    return el ? toStudy(el) : null;
  }
  const elements = baseElements({ ...(institution.dicom || {}), filters: [] });
  elements.StudyInstanceUID = studyUid;
  const raw = await runFind(institution.dicom || {}, elements);
  return raw.length ? toStudy(raw[0]) : null;
}

export function clearCache() { cache.clear(); }

// Deterministic fake studies for demos and development (DICOM_MOCK=true).
export function mockStudies(institution) {
  const today = new Date();
  const people = [
    ['DEMO^ALICE^M', 'F', '19840312', 'US PELVIS COMPLETE TRANSVAGINAL'],
    ['SAMPLE^BETTY', 'F', '19670822', 'US THYROID'],
    ['TEST^CARLOS^J', 'M', '19550130', 'US ABDOMEN COMPLETE'],
    ['EXAMPLE^DANA', 'F', '19920704', 'US RUQ'],
    ['PLACEHOLDER^EVAN', 'M', '19780918', 'US SCROTUM W DOPPLER'],
    ['FICTION^FRANK', 'M', '19491111', 'US RENAL COMPLETE'],
    ['MOCK^GRACE^L', 'F', '20010215', 'US PELVIS TRANSABDOMINAL'],
    ['DUMMY^HENRY', 'M', '19630527', 'US VENOUS DUPLEX LOWER EXT LEFT'],
  ];
  return people.map(([name, sex, dob, desc], i) => {
    const t = new Date(today.getTime() - (i * 47 + 5) * 60000);
    return {
      PatientName: [{ Alphabetic: name }],
      PatientID: `MRN${String(100200 + i * 37 + (institution.id || 0) * 1000)}`,
      PatientBirthDate: dob,
      PatientSex: sex,
      StudyInstanceUID: `1.2.826.0.1.3680043.10.1077.${institution.id || 0}.${dicomDate(t)}.${i + 1}`,
      AccessionNumber: `ACC${dicomDate(t).slice(2)}${String(i + 1).padStart(3, '0')}`,
      StudyDate: dicomDate(t),
      StudyTime: `${pad(t.getHours())}${pad(t.getMinutes())}00`,
      StudyDescription: desc,
      ModalitiesInStudy: 'US',
      ReferringPhysicianName: [{ Alphabetic: 'REFERRER^PAT' }],
      InstitutionName: institution.name || '',
    };
  });
}

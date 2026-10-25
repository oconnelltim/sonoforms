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

export const DEFAULT_MAX_RESULTS = 500;
export const MODALITY_KEYS = ['ModalitiesInStudy', 'Modality'];

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
    modalities: str(el.ModalitiesInStudy) || str(el.Modality),
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

// Runs one C-FIND. Stops at `maxResults`: asks PACS to cancel (C-CANCEL)
// and, if it keeps sending, drops the connection. Resolves to
// { results, truncated }.
function runFind(settings, elements, { maxResults = DEFAULT_MAX_RESULTS, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const results = [];
    let truncated = false;
    let settled = false;
    let abortTimer = null;
    const done = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(abortTimer);
      err ? reject(err) : resolve({ results, truncated });
    };
    const timer = setTimeout(() => {
      if (truncated) return done();
      done(new Error('PACS did not answer in time'));
    }, timeoutMs);
    const client = new Client();
    const request = CFindRequest.createStudyFindRequest(elements);
    request.on('response', (response) => {
      const status = response.getStatus();
      if ((status === Status.Pending || status === 0xff01) && response.hasDataset()) {
        if (results.length < maxResults) {
          results.push(response.getDataset().getElements());
          return;
        }
        if (!truncated) {
          truncated = true;
          try { client.cancel(request); } catch { /* fall back to abort */ }
          // A PACS that ignores the cancel gets disconnected.
          abortTimer = setTimeout(() => { try { client.abort(); } catch { /* ignore */ } done(); }, 5000);
        }
      } else if (status === Status.Success || status === Status.Cancel) {
        done();
      } else if (status !== Status.Pending && status !== 0xff01) {
        done(truncated ? undefined : new Error(`PACS returned DICOM status 0x${Number(status).toString(16)}`));
      }
    });
    client.addRequest(request);
    client.on('associationRejected', (r) => done(new Error(`PACS rejected the connection (check AE titles). Reason: ${JSON.stringify(r?.reason ?? r)}`)));
    client.on('networkError', (e) => done(truncated ? undefined : new Error(`Could not reach PACS: ${e?.message || e}`)));
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

// A worklist query must be narrowed by modality or by an institution filter
// that PACS applies; otherwise one query could return every study for days.
export function queryIsConstrained(settings = {}) {
  const modality = settings.modality === undefined ? 'US' : String(settings.modality).trim();
  const pacsFilter = (settings.filters || []).some(f => f && f.tag && (f.mode || 'query') === 'query' && String(f.value || '').replace(/\*/g, '').trim());
  return !!modality || pacsFilter;
}

const cache = new Map();
const inflight = new Map();
const FORCED_REFRESH_MIN_MS = 10000;

function dayList(since, now) {
  const days = [];
  const d = new Date(since.getFullYear(), since.getMonth(), since.getDate());
  while (d <= now) {
    days.push(dicomDate(d));
    d.setDate(d.getDate() + 1);
  }
  return days;
}

async function queryPacs(settings, since, now) {
  const maxResults = Math.min(Math.max(Number(settings.max_results) || DEFAULT_MAX_RESULTS, 50), 2000);
  const base = baseElements(settings);
  const modality = settings.modality === undefined ? 'US' : String(settings.modality).trim();
  if (modality) base[MODALITY_KEYS.includes(settings.modality_key) ? settings.modality_key : 'ModalitiesInStudy'] = modality;
  // Some PACS don't support date ranges; query one day at a time instead.
  const dates = settings.date_mode === 'single'
    ? dayList(since, now)
    : [dicomDate(since) === dicomDate(now) ? dicomDate(now) : `${dicomDate(since)}-${dicomDate(now)}`];
  const all = new Map();
  let truncated = false;
  for (const date of dates.reverse()) {
    const { results, truncated: t } = await runFind(settings, { ...base, StudyDate: date }, { maxResults: maxResults - all.size });
    for (const el of results) all.set(str(el.StudyInstanceUID) || Symbol('no-uid'), el);
    if (t || all.size >= maxResults) { truncated = true; break; }
  }
  return { raw: [...all.values()], truncated };
}

// Studies from the last `hours`, newest first.
// `cache: false` (used by the admin "Test query" with unsaved settings)
// neither reads nor fills the shared worklist cache.
export async function todaysStudies(institution, hours = 24, { force = false, cache: useCache = true } = {}) {
  const settings = institution.dicom || {};
  if (!config.dicomMock && (!settings.enabled || !settings.host || !settings.port)) return { configured: false, studies: [] };
  if (!config.dicomMock && !queryIsConstrained(settings)) {
    throw new Error('The PACS query is not narrowed by modality or institution. Set one in Admin › Institutions.');
  }
  const key = `${institution.id}:${hours}`;
  const hit = useCache ? cache.get(key) : null;
  // Forced refreshes still reuse a result that is only a few seconds old.
  const maxAge = force ? FORCED_REFRESH_MIN_MS : 30000;
  if (hit && Date.now() - hit.at < maxAge) return hit.value;
  // Everyone asking at the same moment shares one PACS query.
  if (useCache && inflight.has(key)) return inflight.get(key);

  const run = (async () => {
    const now = new Date();
    const since = new Date(now.getTime() - hours * 3600000);
    const { raw, truncated } = config.dicomMock ? { raw: mockStudies(institution), truncated: false } : await queryPacs(settings, since, now);
    const keep = localFilter(settings);
    const studies = raw.filter(keep).map(toStudy)
      .filter(s => s.study_uid && (!s.datetime || new Date(s.datetime) >= since))
      .sort((a, b) => String(b.datetime || '').localeCompare(String(a.datetime || '')));
    const value = { configured: true, studies, truncated };
    if (useCache) cache.set(key, { at: Date.now(), value });
    return value;
  })();
  if (useCache) inflight.set(key, run);
  try {
    return await run;
  } finally {
    if (useCache) inflight.delete(key);
  }
}

// Re-query a single study by UID so demographics come from PACS, not the browser.
export async function studyByUid(institution, studyUid) {
  if (config.dicomMock) {
    const el = mockStudies(institution).find(s => s.StudyInstanceUID === String(studyUid));
    return el ? toStudy(el) : null;
  }
  if (!String(studyUid || '').trim()) return null;
  const elements = baseElements({ ...(institution.dicom || {}), filters: [] });
  elements.StudyInstanceUID = studyUid;
  const { results: raw } = await runFind(institution.dicom || {}, elements, { maxResults: 5 });
  // Only accept an answer for exactly the study we asked about.
  const match = raw.map(toStudy).filter(s => s.study_uid === studyUid);
  return match.length === 1 ? match[0] : null;
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

// SPDX-License-Identifier: GPL-3.0-or-later
//
// Measurements from DICOM Structured Reports (what ultrasound machines send at
// the end of a study) and how forms pick them up.
//
// A report's content is a tree of items (see contentTree in server/sr.js):
//   { relationship, valueType, concept: { scheme, value, meaning },
//     value, unit, code, text, children }
// measurements() flattens its numeric items with where they sit (the
// enclosing containers, e.g. "Internal Carotid Artery"), the side, and their
// modifiers. A form field asks for one with an `sr:` mapping such as
//   sr: LN:11726-7 in SRT:T-45300 right
// meaning: Peak Systolic Velocity (LOINC 11726-7), inside the Internal
// Carotid Artery container, on the right. A dims field lists one per axis.
//
// The tools/sr-viewer page shows these mapping keys for any SR file.

const MOD_RELS = new Set(['HAS CONCEPT MOD', 'HAS PROPERTIES', 'HAS ACQ CONTEXT', 'HAS OBS CONTEXT']);
const SELECTION_STATUS = 'DCM:121404';
const DERIVATION = 'DCM:121401';
// Laterality concept codes (SNOMED via SRT and SCT, and DICOM).
const LATERALITY = new Set(['SRT:G-C171', 'SCT:272741003', 'DCM:121407']);
// Codes for each side, by scheme.
const SIDE_CODES = {
  'SRT:G-A100': 'right', 'SCT:24028007': 'right',
  'SRT:G-A101': 'left', 'SCT:7771000': 'left',
  'SRT:G-A102': 'bilateral', 'SCT:51440002': 'bilateral',
};
const FINDINGS = 'DCM:121070';

// The same concepts in the old SNOMED-DICOM codes (SRT) and in SNOMED CT
// (SCT), which newer scanner software uses. Mappings written with either
// match both.
const SAME_AS = {
  'SRT:T-45100': 'SCT:32062004',   // Common carotid artery
  'SRT:T-45300': 'SCT:86117002',   // Internal carotid artery
  'SRT:T-45200': 'SCT:22286001',   // External carotid artery
  'SRT:T-87000': 'SCT:15497006',   // Ovary
  'SRT:G-C0E3': 'SCT:363698007',   // Finding site
  'SRT:G-C171': 'SCT:272741003',   // Laterality
  'SRT:G-A100': 'SCT:24028007',    // Right
  'SRT:G-A101': 'SCT:7771000',     // Left
  'SRT:G-A102': 'SCT:51440002',    // Bilateral
};
for (const [a, b] of Object.entries(SAME_AS)) SAME_AS[b] = a;
// A code key in one canonical spelling, so equivalent codes compare equal.
const canon = k => (k && SAME_AS[k] && k.startsWith('SCT:') ? SAME_AS[k] : k);

export const codeKey = c => (c && c.value ? canon(`${c.scheme}:${c.value}`) : '');

function modifiersOf(node) {
  return node.children
    .filter(c => MOD_RELS.has(c.relationship) && (c.valueType === 'CODE' || c.valueType === 'TEXT' || c.valueType === 'NUM'))
    .map(c => ({
      name: c.concept?.meaning || '', key: codeKey(c.concept),
      value: c.code ? c.code.meaning : (c.text ?? (c.value ?? '')), valueKey: c.code ? codeKey(c.code) : '',
    }));
}

const sideOf = mods => {
  const m = mods.find(x => LATERALITY.has(x.key));
  if (!m) return '';
  return SIDE_CODES[m.valueKey] || String(m.value || '').toLowerCase();
};

// All numeric measurements, in report order. Of several measurements of the
// same thing in the same place (each attempt, then the mean or the value the
// tech picked), one is marked `chosen`: the one with a Selection Status, or
// else the last.
export function measurements(root) {
  const out = [];
  (function walk(node, path, inherited) {
    const here = node.valueType === 'CONTAINER' && node !== root ? [...path, node.concept] : path;
    const context = node.valueType === 'CONTAINER' ? [...inherited, ...modifiersOf(node)] : inherited;
    if (node.valueType === 'NUM') {
      const own = modifiersOf(node);
      out.push({
        index: out.length + 1,
        path: here.map(c => c?.meaning || '?'),
        pathKeys: here.map(codeKey),
        concept: node.concept,
        key: codeKey(node.concept),
        value: node.value,
        unit: node.unit?.value || '',
        modifiers: own.filter(m => m.key !== SELECTION_STATUS),
        context,
        derivation: own.find(m => m.key === DERIVATION)?.value || '',
        selection: own.find(m => m.key === SELECTION_STATUS)?.value || '',
        side: sideOf([...own, ...context]),
      });
    }
    for (const child of node.children || []) walk(child, here, context);
  })(root, [], []);

  const groups = new Map();
  for (const m of out) {
    const g = [m.pathKeys.join('>'), m.key, m.side, m.modifiers.filter(x => x.key !== DERIVATION).map(x => `${x.key}=${x.valueKey}`).join(',')].join('|');
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(m);
  }
  for (const list of groups.values()) {
    const chosen = list.find(m => m.selection) || list[list.length - 1];
    for (const m of list) m.chosen = m === chosen;
  }
  return out;
}

// The mapping key for a measurement: its code, the innermost named container,
// the side, and any other modifier values that tell it apart.
export function mappingKey(m) {
  const where = m.pathKeys.filter(k => k && k !== FINDINGS).slice(-1)[0];
  const parts = [m.key];
  if (where) parts.push(`in ${where}`);
  if (m.side) parts.push(m.side);
  for (const x of m.modifiers) {
    if (x.key !== DERIVATION && !LATERALITY.has(x.key) && x.valueKey) parts.push(`with ${x.valueKey}`);
  }
  return parts.join(' ');
}

const CODE_RE = /^[A-Za-z0-9.-]+:[A-Za-z0-9.-]+$/;
const SIDES = new Set(['right', 'left', 'bilateral']);

// Parses a mapping key ("LN:11726-7 in SRT:T-45300 right with SRT:R-FAB5B").
// Returns { code, in: [...], side, with: [...] } or throws with a message.
export function parseSrSpec(text) {
  const tokens = String(text || '').replace(/·/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) throw new Error('is empty');
  const spec = { code: tokens.shift(), in: [], side: '', with: [] };
  if (!CODE_RE.test(spec.code)) throw new Error(`"${spec.code}" isn't a code like LN:11726-7`);
  while (tokens.length) {
    const t = tokens.shift();
    if (t === 'in' || t === 'with') {
      const c = tokens.shift();
      if (!c || !CODE_RE.test(c)) throw new Error(`"${t}" must be followed by a code like SRT:T-45300`);
      spec[t].push(c);
    } else if (SIDES.has(t.toLowerCase())) {
      spec.side = t.toLowerCase();
    } else {
      throw new Error(`doesn't understand "${t}" (expected "in CODE", "with CODE", or right/left/bilateral)`);
    }
  }
  return spec;
}

// "in" matches an enclosing container or a modifier value (some software
// versions give the vessel as a Finding Site modifier rather than a
// container); "with" matches a modifier value.
function matches(m, spec) {
  if (m.key !== canon(spec.code)) return false;
  const values = [...m.modifiers, ...m.context].map(x => x.valueKey);
  if (spec.in.some(c => !m.pathKeys.includes(canon(c)) && !values.includes(canon(c)))) return false;
  if (spec.side && m.side !== spec.side) return false;
  return spec.with.every(c => values.includes(canon(c)));
}

// The value a mapping key picks from a report's measurements: the chosen one
// if several match, else the last match. null if none.
export function findMeasurement(list, specText) {
  const spec = typeof specText === 'string' ? parseSrSpec(specText) : specText;
  const hits = list.filter(m => matches(m, spec) && m.value !== null && m.value !== undefined && Number.isFinite(m.value));
  if (!hits.length) return null;
  return hits.filter(m => m.chosen).slice(-1)[0] || hits[hits.length - 1];
}

// Unit conversion between the units scanners use (UCUM) and form units.
const UNIT_FACTORS = {
  length: { m: 1, cm: 0.01, mm: 0.001 },
  volume: { l: 1, ml: 0.001, cm3: 0.001, mm3: 1e-6 },
  velocity: { 'm/s': 1, 'cm/s': 0.01, 'mm/s': 0.001 },
  area: { m2: 1, cm2: 1e-4, mm2: 1e-6 },
  rate: { '/min': 1, bpm: 1, '{H.B.}/min': 1, '{beats}/min': 1 },
};
const normUnit = u => String(u || '').trim().replace(/^mL$/, 'ml').replace(/^L$/, 'l').replace(/\[cm3\]|cc/, 'cm3').toLowerCase();

// Converts value from unit `from` to unit `to`. A field without a unit only
// takes unitless values (ratios, counts: UCUM "1"), so a length is never
// taken without knowing whether it's cm or mm. Returns null if the units
// don't match.
export function convertUnit(value, from, to) {
  const f = normUnit(from); const t = normUnit(to);
  const unitless = u => u === '' || u === '1' || u === 'ratio' || u === '{ratio}';
  if (unitless(t)) return unitless(f) ? value : null;
  if (f === t) return value;
  for (const table of Object.values(UNIT_FACTORS)) {
    if (f in table && t in table) return value * table[f] / table[t];
  }
  return null;
}

// Values are kept exactly as the scanner sent them; the report rounds them
// once, to the field's decimals, when it prints them. Rounding here too would
// round twice (2.249995 -> 2.25 -> 2.3, not 2.2) and skew values calculated
// from them, like an ovary's volume. Unit conversion can add float noise
// (61.15188000000001), so that's trimmed to 10 significant digits.
const clean = v => Number(v.toPrecision(10));

// Fields with an `sr:` mapping, including dims fields with one per axis.
export function mappedFields(def) {
  return (def.sections || []).flatMap(s => s.fields || []).filter(f => f.sr !== undefined && ['number', 'dims'].includes(f.type));
}

// Values for a form from scanner reports (newest first). Returns
//   { values: { fieldId: value }, sources: { fieldId: { report, keys } },
//     missing: [fieldId…] }
// Dims fields fill only when every axis is found.
export function prefill(def, reports) {
  const values = {};
  const sources = {};
  const missing = [];
  for (const f of mappedFields(def)) {
    const specs = Array.isArray(f.sr) ? f.sr : [f.sr];
    let found = null;
    for (const r of reports) {
      const parts = specs.map((spec) => {
        const m = findMeasurement(r.measurements, spec);
        if (!m) return null;
        const v = convertUnit(m.value, m.unit, f.unit);
        return v === null ? null : clean(v);
      });
      if (parts.every(v => v !== null)) { found = { value: f.type === 'dims' ? parts : parts[0], report: r.id }; break; }
    }
    if (found) {
      values[f.id] = found.value;
      sources[f.id] = { report: found.report, keys: specs };
    } else missing.push(f.id);
  }
  return { values, sources, missing };
}

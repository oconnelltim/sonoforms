// SPDX-License-Identifier: GPL-3.0-or-later
//
// Whitelisted functions available in form expressions. Every function
// tolerates missing input and returns null rather than throwing, so a
// calculated field simply stays blank until its inputs are filled in.
//
// Documented for form authors in docs/FORMS.md — keep that file in sync.

const isBlank = v => v === null || v === undefined || v === '' || (typeof v === 'number' && isNaN(v));
const toNum = v => {
  if (isBlank(v) || typeof v === 'boolean' || Array.isArray(v)) return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
};
const flat = args => args.flat(8);
// Decimal places clamped to 0..10 (toFixed throws above 100).
const places = d => Math.min(10, Math.max(0, Math.trunc(toNum(d) ?? 0)));
const nums = args => flat(args).map(toNum).filter(n => n !== null);

// All three numbers are required for a volume; returns null if any are missing.
function three(args) {
  const list = flat(args).slice(0, 3).map(toNum);
  return list.length === 3 && list.every(n => n !== null && n > 0) ? list : null;
}

function parseDate(v) {
  if (isBlank(v)) return null;
  const d = new Date(typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00` : v);
  return isNaN(d.getTime()) ? null : d;
}

// A local date as YYYY-MM-DD (how date fields store dates).
const isoDate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function addDays(v, n) {
  const d = parseDate(v);
  const k = toNum(n);
  if (!d || k === null) return null;
  d.setDate(d.getDate() + Math.round(k));
  return isoDate(d);
}

// Gestational age in days from crown-rump length in mm, for CRL 3 to 84 mm.
//   robinson (default): Robinson & Fleming, Br J Obstet Gynaecol 1975,
//     GA = 8.052 x sqrt(CRL mm) + 23.73 (as recommended by BMUS, 2009)
//   hadlock: Hadlock et al., Radiology 1992, CRL in cm,
//     GA (weeks) = exp(1.684969 + 0.315646 CRL - 0.049306 CRL^2 + 0.004057 CRL^3 - 0.000120456 CRL^4)
function crlGa(crl, method = 'robinson') {
  const mm = toNum(crl);
  if (mm === null || mm < 3 || mm > 84) return null;
  if (method === 'hadlock') {
    const c = mm / 10;
    return Math.round(7 * Math.exp(1.684969 + 0.315646 * c - 0.049306 * c ** 2 + 0.004057 * c ** 3 - 0.000120456 * c ** 4));
  }
  return Math.round(8.052 * Math.sqrt(mm) + 23.73);
}

export const FUNCTIONS = {
  round: (x, d = 0) => { const n = toNum(x); if (n === null) return null; const f = 10 ** places(d); return Math.round(n * f) / f; },
  floor: x => { const n = toNum(x); return n === null ? null : Math.floor(n); },
  ceil: x => { const n = toNum(x); return n === null ? null : Math.ceil(n); },
  abs: x => { const n = toNum(x); return n === null ? null : Math.abs(n); },
  sqrt: x => { const n = toNum(x); return n === null || n < 0 ? null : Math.sqrt(n); },
  pow: (x, y) => { const a = toNum(x), b = toNum(y); return a === null || b === null ? null : a ** b; },
  min: (...a) => { const n = nums(a); return n.length ? Math.min(...n) : null; },
  max: (...a) => { const n = nums(a); return n.length ? Math.max(...n) : null; },
  sum: (...a) => { const n = nums(a); return n.length ? n.reduce((s, x) => s + x, 0) : null; },
  avg: (...a) => { const n = nums(a); return n.length ? n.reduce((s, x) => s + x, 0) / n.length : null; },
  ratio: (a, b) => { const x = toNum(a), y = toNum(b); return x === null || !y ? null : x / y; },

  // Ellipsoid volume (pi/6 x L x W x H). With dimensions in cm the result is in mL.
  ellipsoid: (...a) => { const d = three(a); return d ? (Math.PI / 6) * d[0] * d[1] * d[2] : null; },
  // Volume with an explicit correction factor, e.g. volume(testis, 0.71) (Lambert).
  volume: (...a) => {
    const all = flat(a);
    const factor = toNum(all[3]);
    const d = three(all.slice(0, 3));
    return d && factor !== null ? d[0] * d[1] * d[2] * factor : null;
  },
  product: (...a) => { const n = nums(a); return n.length ? n.reduce((s, x) => s * x, 1) : null; },
  max_dim: (...a) => { const n = nums(a); return n.length ? Math.max(...n) : null; },
  dim: (dims, i) => (Array.isArray(dims) ? toNum(dims[toNum(i) ?? 0]) : null),

  count: v => (Array.isArray(v) ? v.filter(x => !isBlank(x)).length : (isBlank(v) ? 0 : 1)),
  has: (list, v) => (Array.isArray(list) ? list.some(x => String(x) === String(v)) : String(list ?? '') === String(v)),
  has_any: (list, ...vals) => vals.flat().some(v => FUNCTIONS.has(list, v)),
  empty: v => (Array.isArray(v) ? v.every(isBlank) : isBlank(v)),
  present: v => !FUNCTIONS.empty(v),
  if: (c, a, b = null) => ((Array.isArray(c) ? c.length : c) ? a : b),
  coalesce: (...a) => a.find(x => !FUNCTIONS.empty(x)) ?? null,
  join: (list, sep = ', ') => (Array.isArray(list) ? list.filter(x => !isBlank(x)).join(sep) : (list ?? '')),
  lower: s => (isBlank(s) ? s : String(s).toLowerCase()),
  upper: s => (isBlank(s) ? s : String(s).toUpperCase()),
  fixed: (x, d = 1) => { const n = toNum(x); return n === null ? null : n.toFixed(places(d)); },

  // ACR TI-RADS level from total points (Tessler et al., JACR 2017).
  tirads: p => {
    const n = toNum(p);
    if (n === null) return null;
    if (n === 0) return 'TR1';
    if (n <= 2) return 'TR2';
    if (n === 3) return 'TR3';
    if (n <= 6) return 'TR4';
    return 'TR5';
  },
  // ACR TI-RADS management by level and maximum dimension (cm).
  tirads_rec: (level, size) => {
    const s = toNum(size);
    const thresholds = { TR3: [2.5, 1.5], TR4: [1.5, 1.0], TR5: [1.0, 0.5] }[level];
    if (!level) return null;
    if (!thresholds) return 'No FNA or follow-up indicated';
    if (s === null) return null;
    if (s >= thresholds[0]) return 'FNA recommended';
    if (s >= thresholds[1]) return 'Follow-up recommended';
    return 'No FNA or follow-up indicated';
  },

  days_between: (a, b) => {
    const x = parseDate(a), y = parseDate(b);
    return x && y ? Math.round((y - x) / 86400000) : null;
  },
  // Gestational age from LMP as of a date, formatted "12w 3d".
  ga_from_lmp: (lmp, asOf) => {
    const days = FUNCTIONS.days_between(lmp, asOf);
    return days === null || days < 0 ? null : `${Math.floor(days / 7)}w ${days % 7}d`;
  },
  add_days: addDays,

  // Early pregnancy. Gestational ages are whole days; ga_text() words them.
  crl_ga: crlGa,
  // Rough gestational age from mean sac diameter: days = MSD (mm) + 30.
  // Only for a sac without an embryo; for MSD 2 to 60 mm.
  msd_ga: (msd) => { const mm = toNum(msd); return mm === null || mm < 2 || mm > 60 ? null : Math.round(mm + 30); },
  // "8 weeks 3 days"
  ga_text: (days) => {
    const d = toNum(days);
    if (d === null || d < 0) return null;
    const w = Math.floor(Math.round(d) / 7), r = Math.round(d) % 7;
    return `${w} ${w === 1 ? 'week' : 'weeks'} ${r} ${r === 1 ? 'day' : 'days'}`;
  },
  // Estimated date of delivery: LMP + 280 days, or from a gestational age (days) on a date.
  edd_from_lmp: lmp => addDays(lmp, 280),
  edd_from_ga: (gaDays, asOf) => { const d = toNum(gaDays); return d === null ? null : addDays(asOf, 280 - d); },
  // True when first-trimester CRL dating should replace LMP dating (ACOG
  // Committee Opinion 700, 2017): a difference of more than 5 days before
  // 9w0d, or more than 7 days from 9w0d to 13w6d. Ages are in days.
  redate_by_us: (usDays, lmpDays) => {
    const us = toNum(usDays), lmp = toNum(lmpDays);
    if (us === null || lmp === null || us >= 98) return null;
    return Math.abs(us - lmp) > (us < 63 ? 5 : 7);
  },
};

// Meta functions receive field *names* so they can read the field definition
// (option labels, report text, points) rather than just the stored value.
function selectedOptions(ctx, name) {
  const field = ctx.field(name);
  const value = ctx.lookup(name);
  if (!field || !field.options || isBlank(value)) return [];
  const values = Array.isArray(value) ? value.map(String) : [String(value)];
  return field.options.filter(o => values.includes(String(o.value)));
}

export const META_FUNCTIONS = {
  points: (ctx, ...names) => {
    let total = null;
    for (const name of names) {
      for (const o of selectedOptions(ctx, name)) total = (total ?? 0) + (Number(o.points) || 0);
    }
    return total;
  },
  label: (ctx, name) => selectedOptions(ctx, name).map(o => o.label).join(', ') || null,
  text: (ctx, name) => selectedOptions(ctx, name).map(o => o.text ?? o.label).join(', ') || null,
  shown: (ctx, name) => (ctx.isVisible ? ctx.isVisible(name) : true),
};

export const FUNCTION_NAMES = [...Object.keys(FUNCTIONS), ...Object.keys(META_FUNCTIONS)].sort();

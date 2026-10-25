// SPDX-License-Identifier: GPL-3.0-or-later
//
// Normalizes form definitions (written in YAML or JSON by form authors)
// into a consistent shape, and lints them for mistakes such as typos in
// field references. See docs/FORMS.md for the authoring guide.

import { compile, identifiers } from './expr.js';
import { parseTemplate } from './template.js';

export const FIELD_TYPES = ['text', 'textarea', 'number', 'choice', 'multi', 'boolean', 'date', 'dims', 'calc', 'repeat', 'note'];
const FIELD_KEYS = ['id', 'type', 'label', 'help', 'required', 'show_if', 'default', 'normal', 'unit', 'decimals', 'min', 'max', 'step',
  'options', 'other', 'layout', 'placeholder', 'width', 'axes', 'formula', 'fields', 'item_label', 'min_items', 'max_items',
  'true_text', 'false_text', 'conjunction', 'rows'];
const OPTION_KEYS = ['value', 'label', 'text', 'points', 'help'];
const SECTION_KEYS = ['id', 'title', 'show_if', 'fields', 'report', 'help'];
const RESERVED_IDS = new Set(['__proto__', 'constructor', 'prototype', 'patient', 'exam', 'institution', 'true', 'false', 'null', 'and', 'or', 'not', 'in']);
const TYPE_ALIASES = { radio: 'choice', select: 'choice', checkbox_group: 'multi', checkboxes: 'multi', checkbox: 'boolean', yesno: 'boolean', static: 'note', measurement: 'dims' };

export function slugify(s) {
  return String(s ?? '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s-]+/g, '_').replace(/^_+|_+$/g, '') || 'x';
}

function normalizeOption(o) {
  if (o === null || typeof o !== 'object') {
    const label = String(o);
    return { value: slugify(label), label };
  }
  const out = { ...o };
  if (out.value === undefined || out.value === null) out.value = slugify(out.label);
  out.value = String(out.value);
  if (out.label === undefined) out.label = out.value;
  out.label = String(out.label);
  return out;
}

function normalizeField(f, i) {
  const field = { ...f };
  field.type = TYPE_ALIASES[field.type] || field.type || 'text';
  if (f.type === 'select' && !field.layout) field.layout = 'dropdown';
  if (!field.id) field.id = field.label ? slugify(field.label) : `field_${i + 1}`;
  if (field.options) field.options = field.options.map(normalizeOption);
  if (field.other && field.options && !field.options.some(o => o.value === 'other')) {
    field.options.push({ value: 'other', label: typeof field.other === 'string' ? field.other : 'Other' });
  }
  if (field.type === 'dims') {
    field.axes = field.axes || ['L', 'AP', 'W'];
    if (field.unit === undefined) field.unit = 'cm';
  }
  if (field.type === 'repeat') field.fields = (field.fields || []).map(normalizeField);
  if (field.decimals !== undefined) field.decimals = Math.min(10, Math.max(0, Math.trunc(Number(field.decimals)) || 0));
  for (const k of ['min', 'max', 'step']) if (field[k] !== undefined) field[k] = Number(field[k]);
  return field;
}

export function normalizeForm(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Form definition must be an object');
  const def = { ...raw };
  def.title = def.title || def.name || def.id || 'Untitled form';
  def.id = def.id ? slugify(def.id).replace(/_/g, '-') : slugify(def.title).replace(/_/g, '-');
  def.study_match = (def.study_match || []).map(String);
  def.report = def.report || {};
  def.sections = (def.sections || []).map((s, i) => {
    const section = { ...s };
    if (!section.id) section.id = section.title ? slugify(section.title) : `section_${i + 1}`;
    section.fields = (section.fields || []).map(normalizeField);
    return section;
  });
  return def;
}

// Returns a list of { level: 'error'|'warning', path, message }.
export function lintForm(rawOrDef) {
  const problems = [];
  const err = (path, message) => problems.push({ level: 'error', path, message });
  const warn = (path, message) => problems.push({ level: 'warning', path, message });
  let def;
  try { def = normalizeForm(rawOrDef); } catch (e) { err('', e.message); return problems; }

  if (!def.sections.length) err('sections', 'The form has no sections');
  def.study_match.forEach(p => {
    if (isRegexPattern(String(p).trim())) err('study_match', `Regular expressions are not supported in study_match ('${p}'). List the words to match instead, e.g. "US PELVIS".`);
  });
  if (def.study_match.length > 50) err('study_match', 'At most 50 study_match entries are allowed');

  const known = new Set();
  const repeatSubs = new Map(); // repeat id -> Set of sub-field ids
  const seenSections = new Set();
  for (const s of def.sections) {
    if (seenSections.has(s.id)) err(`sections.${s.id}`, `Duplicate section id '${s.id}'`);
    seenSections.add(s.id);
    for (const f of s.fields) {
      if (known.has(f.id)) err(`${s.id}.${f.id}`, `Duplicate field id '${f.id}'`);
      known.add(f.id);
      if (f.other) known.add(`${f.id}_other`);
      if (f.type === 'repeat') {
        const subs = new Set();
        for (const sub of f.fields) {
          if (subs.has(sub.id)) err(`${s.id}.${f.id}.${sub.id}`, `Duplicate field id '${sub.id}' in ${f.id}`);
          subs.add(sub.id);
          if (sub.other) subs.add(`${sub.id}_other`);
        }
        repeatSubs.set(f.id, subs);
      }
    }
  }

  const checkExpr = (path, src, scopeIds = new Set()) => {
    if (src === true || src === false || src === undefined || src === null) return;
    try {
      for (const id of identifiers(compile(String(src)))) {
        if (id.startsWith('patient.') || id.startsWith('exam.') || id.startsWith('institution.') || id.startsWith('@')) continue;
        if (!known.has(id) && !scopeIds.has(id)) err(path, `Unknown field '${id}' in: ${src}`);
      }
    } catch (e) {
      err(path, e.message);
    }
  };

  const checkTemplate = (path, src) => {
    let nodes;
    try { nodes = parseTemplate(src); } catch (e) { err(path, e.message); return; }
    const walk = (list, scopeIds) => {
      for (const n of list) {
        if (n.k === 'expr') checkExpr(path, n.src, scopeIds);
        if (n.k === 'if') {
          n.branches.forEach(b => { checkExpr(path, b.src, scopeIds); walk(b.body, scopeIds); });
          if (n.elseBody) walk(n.elseBody, scopeIds);
        }
        if (n.k === 'each') {
          if (!repeatSubs.has(n.name)) err(path, `{{#each ${n.name}}} must name a repeat field`);
          walk(n.body, new Set([...scopeIds, ...(repeatSubs.get(n.name) || [])]));
        }
      }
    };
    walk(nodes, new Set());
  };

  const checkKeys = (path, obj, allowed, what) => {
    for (const k of Object.keys(obj)) {
      if (allowed.includes(k)) continue;
      const hint = obj[k] === null ? ' Text containing a comma inside { ... } must be in quotes, e.g. text: "a, b".' : '';
      (obj[k] === null ? err : warn)(path, `Unknown ${what} key '${k}'.${hint}`);
    }
  };

  const checkField = (path, f, scopeIds) => {
    checkKeys(path, f, FIELD_KEYS, 'field');
    for (const o of f.options || []) checkKeys(`${path}.${o.value}`, o, OPTION_KEYS, 'option');
    if (!FIELD_TYPES.includes(f.type)) err(path, `Unknown field type '${f.type}' (use one of: ${FIELD_TYPES.join(', ')})`);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(f.id)) err(path, `Field id '${f.id}' may only contain letters, numbers and underscores, and must not start with a number`);
    if (RESERVED_IDS.has(f.id) || f.id.startsWith('__')) err(path, `Field id '${f.id}' is reserved; choose another name`);
    if (f.id.length > 64) err(path, `Field id '${f.id}' is too long (64 characters at most)`);
    if (['choice', 'multi'].includes(f.type)) {
      if (!f.options || !f.options.length) err(path, `'${f.id}' needs a list of options`);
      const values = new Set();
      for (const o of f.options || []) {
        if (values.has(o.value)) err(path, `Duplicate option value '${o.value}' in '${f.id}'`);
        values.add(o.value);
      }
      if (f.default !== undefined && f.default !== null) {
        const d = Array.isArray(f.default) ? f.default : [f.default];
        d.forEach(v => { if (!values.has(String(v))) err(path, `Default '${v}' is not one of the options of '${f.id}'`); });
      }
      if (f.normal !== undefined && f.normal !== null) {
        const n = Array.isArray(f.normal) ? f.normal : [f.normal];
        n.forEach(v => { if (!values.has(String(v))) err(path, `Normal value '${v}' is not one of the options of '${f.id}'`); });
      }
    }
    if (f.type === 'calc' && !f.formula) err(path, `Calculated field '${f.id}' needs a formula`);
    if (f.formula) checkExpr(path, f.formula, scopeIds);
    if (f.show_if) checkExpr(path, f.show_if, scopeIds);
    if (typeof f.required === 'string') checkExpr(path, f.required, scopeIds);
    if (f.type === 'repeat' && !f.fields.length) err(path, `Repeat field '${f.id}' has no sub-fields`);
    if (f.label === undefined && f.type !== 'note') warn(path, `'${f.id}' has no label`);
  };

  for (const s of def.sections) {
    checkKeys(s.id, s, SECTION_KEYS, 'section');
    if (s.show_if) checkExpr(`${s.id}`, s.show_if);
    if (s.report) checkTemplate(`${s.id}.report`, s.report);
    for (const f of s.fields) {
      checkField(`${s.id}.${f.id}`, f, new Set());
      if (f.type === 'repeat') {
        const subs = repeatSubs.get(f.id);
        for (const sub of f.fields) checkField(`${s.id}.${f.id}.${sub.id}`, sub, subs);
      }
    }
  }
  if (def.report.header) checkTemplate('report.header', def.report.header);
  if (def.report.footer) checkTemplate('report.footer', def.report.footer);
  return problems;
}

// Fill defaults (used when a tech starts a new form).
export function initialAnswers(def) {
  const data = {};
  for (const s of def.sections) {
    for (const f of s.fields) {
      if (f.default !== undefined) data[f.id] = structuredCloneSafe(f.default);
      else if (f.type === 'repeat' && f.min_items) data[f.id] = Array.from({ length: f.min_items }, () => ({}));
    }
  }
  return data;
}

// The values set by a section's "Normal" button.
export function normalAnswers(section) {
  const data = {};
  for (const f of section.fields) if (f.normal !== undefined) data[f.id] = structuredCloneSafe(f.normal);
  return data;
}

function structuredCloneSafe(v) {
  return v === null || typeof v !== 'object' ? v : JSON.parse(JSON.stringify(v));
}

// Score how well a form matches a DICOM study description (higher = better).
// Each study_match entry is a set of whole words that must all appear. An
// entry equal to the whole description wins outright. (Regular expressions
// are deliberately not supported: they run on the server for every study,
// and a badly written one can freeze it.)
export function matchScore(def, studyDescription) {
  const desc = String(studyDescription || '').slice(0, 200).toUpperCase().replace(/\s+/g, ' ').trim();
  if (!desc) return 0;
  const descWords = new Set(desc.split(/[^A-Z0-9]+/).filter(Boolean));
  let best = 0;
  for (const pattern of (def.study_match || []).slice(0, 50)) {
    const p = String(pattern).slice(0, 200).trim().toUpperCase().replace(/\s+/g, ' ');
    if (!p || isRegexPattern(p)) continue;
    if (desc === p) { best = Math.max(best, 1000); continue; }
    const words = p.split(/[^A-Z0-9]+/).filter(Boolean);
    if (words.length && words.every(w => descWords.has(w))) best = Math.max(best, 10 * words.length + p.length / 100);
  }
  return best;
}

const isRegexPattern = p => p.length > 2 && p.startsWith('/') && p.endsWith('/');

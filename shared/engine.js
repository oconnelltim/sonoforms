// SPDX-License-Identifier: GPL-3.0-or-later
//
// Evaluates a normalized form definition against a set of answers:
// which fields are visible, what calculated fields equal, what is
// required, and how each value is formatted for the report.

import { compile, evaluate, isEmpty, truthy } from './expr.js';

// env holds non-form context available to expressions: patient.age,
// patient.sex, exam.date, exam.study_description, ...
export function createEvaluator(def, data = {}, env = {}) {
  const index = indexFields(def);
  return makeScope({ def, index, data: data || {}, env, parent: null, repeatField: null, item: null, itemIndex: 0, itemCount: 0 });
}

export function indexFields(def) {
  if (def.__index) return def.__index;
  const index = new Map();
  for (const section of def.sections || []) {
    for (const field of section.fields || []) {
      index.set(field.id, { field, section });
      if (field.type === 'repeat') {
        for (const sub of field.fields || []) index.set(`${field.id}.${sub.id}`, { field: sub, section, repeat: field });
      }
    }
  }
  Object.defineProperty(def, '__index', { value: index, enumerable: false });
  return index;
}

function envLookup(env, name) {
  let v = env;
  for (const part of name.split('.')) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, part)) return null;
    v = v[part];
  }
  return v ?? null;
}

function makeScope(s) {
  const visMemo = new Map();
  const valMemo = new Map();
  const inProgress = new Set();

  // Within a repeat item, sub-field ids shadow outer ids.
  function resolve(name) {
    if (s.repeatField) {
      const sub = (s.repeatField.fields || []).find(f => f.id === name);
      if (sub) return { field: sub, section: null, local: true };
    }
    const entry = s.index.get(name);
    if (entry && !entry.repeat) return { ...entry, local: false };
    return null;
  }

  const scope = {
    field(name) {
      const r = resolve(name);
      return r ? r.field : (s.parent ? s.parent.field(name) : undefined);
    },

    isVisible(name) {
      const r = resolve(name);
      if (!r) return s.parent ? s.parent.isVisible(name) : true;
      if (!r.local) {
        // Outer field referenced from inside a repeat item: ask the outer scope.
        if (s.parent) return s.parent.isVisible(name);
      }
      if (visMemo.has(name)) return visMemo.get(name);
      if (inProgress.has(`vis:${name}`)) return true; // cycle guard
      inProgress.add(`vis:${name}`);
      let visible = true;
      if (r.section && r.section.show_if) visible = truthy(scope.eval(r.section.show_if));
      if (visible && r.field.show_if) visible = truthy(scope.eval(r.field.show_if));
      inProgress.delete(`vis:${name}`);
      visMemo.set(name, visible);
      return visible;
    },

    sectionVisible(section) {
      return !section.show_if || truthy(scope.eval(section.show_if));
    },

    raw(name) {
      return s.item && Object.hasOwn(s.item, name) ? s.item[name] : (Object.hasOwn(s.data, name) ? s.data[name] : undefined);
    },

    lookup(name) {
      if (name === '@index') return s.itemIndex + 1;
      if (name === '@count') return s.itemCount;
      if (name === '@first') return s.itemIndex === 0;
      if (name === '@last') return s.itemIndex === s.itemCount - 1;
      if (name.startsWith('patient.') || name.startsWith('exam.') || name.startsWith('institution.')) return envLookup(s.env, name);

      const r = resolve(name);
      if (!r) {
        // "<field>_other" holds the free text for an "Other" option.
        if (name.endsWith('_other')) {
          const base = scope.field(name.slice(0, -6));
          if (base && base.other) return scope.raw(name) ?? null;
        }
        return s.parent ? s.parent.lookup(name) : null;
      }
      if (!r.local && s.parent) return s.parent.lookup(name);
      if (!scope.isVisible(name)) return null;
      if (valMemo.has(name)) return valMemo.get(name);
      let value;
      if (r.field.type === 'calc') {
        if (inProgress.has(`val:${name}`)) return null;
        inProgress.add(`val:${name}`);
        try { value = scope.eval(r.field.formula); } catch { value = null; }
        inProgress.delete(`val:${name}`);
        if (typeof value === 'number' && r.field.decimals !== undefined) {
          const f = 10 ** r.field.decimals;
          value = Math.round(value * f) / f;
        }
      } else if (r.field.type === 'note') {
        value = null;
      } else {
        value = scope.raw(name);
        if (value === undefined) value = null;
        if (r.field.type === 'number' && !isEmpty(value)) value = Number(value);
      }
      valMemo.set(name, value);
      return value;
    },

    eval(src) {
      if (src === true || src === false) return src;
      return evaluate(compile(src), scope);
    },

    isRequired(field) {
      if (!field.required) return false;
      if (field.required === true) return true;
      try { return truthy(scope.eval(field.required)); } catch { return false; }
    },

    // Child scopes for each item of a repeat field.
    items(name) {
      const r = resolve(name);
      if (!r || r.field.type !== 'repeat' || !scope.isVisible(name)) return [];
      const list = Array.isArray(scope.raw(name)) ? scope.raw(name) : [];
      return list.map((item, i) => makeScope({
        ...s, parent: scope, repeatField: r.field, item: item || {}, itemIndex: i, itemCount: list.length,
      }));
    },

    format(name, opts = {}) {
      const field = scope.field(name);
      const value = scope.lookup(name);
      if (!field) return formatValue(value);
      return formatField(field, value, scope, opts);
    },

    env: s.env,
    def: s.def,
  };
  return scope;
}

export function naturalJoin(list, conj = 'and') {
  const items = list.filter(x => !isEmpty(x)).map(String);
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0]} ${conj} ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, ${conj} ${items[items.length - 1]}`;
}

export function formatNumber(n, decimals) {
  if (isEmpty(n)) return '';
  const x = Number(n);
  if (isNaN(x)) return String(n);
  if (decimals !== undefined) return x.toFixed(decimals);   // keeps trailing zeros: 6.0 mL
  return String(Math.round(x * 100) / 100);
}

export function formatDate(v) {
  if (isEmpty(v)) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
  return m ? `${m[2]}/${m[3]}/${m[1]}` : String(v);
}

export function formatValue(v) {
  if (isEmpty(v)) return '';
  if (Array.isArray(v)) return naturalJoin(v.map(formatValue));
  if (typeof v === 'number') return formatNumber(v);
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return String(v);
}

function optionText(field, value, scope) {
  if (field.other && String(value) === 'other') return scope.raw(`${field.id}_other`) || 'other';
  const opt = (field.options || []).find(o => String(o.value) === String(value));
  if (!opt) return String(value);
  return opt.text ?? opt.label;
}

export function formatField(field, value, scope, opts = {}) {
  if (isEmpty(value)) return '';
  const unit = opts.nounit ? '' : (field.unit ? ` ${field.unit}` : '');
  switch (field.type) {
    case 'choice':
      return optionText(field, value, scope);
    case 'multi':
      return naturalJoin((Array.isArray(value) ? value : [value]).map(v => optionText(field, v, scope)), field.conjunction || 'and');
    case 'number':
    case 'calc':
      if (typeof value === 'number' || !isNaN(Number(value))) return formatNumber(value, field.decimals) + unit;
      return String(value);
    case 'dims': {
      const parts = (Array.isArray(value) ? value : []).filter(x => !isEmpty(x)).map(x => formatNumber(x, field.decimals));
      return parts.length ? parts.join(' x ') + unit : '';
    }
    case 'boolean':
      return value ? (field.true_text ?? 'yes') : (field.false_text ?? 'no');
    case 'date':
      return formatDate(value);
    default:
      return String(value);
  }
}

// Returns { missing: [{id, label, section}], warnings: [{id, label, message}] }
export function validateAnswers(def, data, env) {
  const scope = createEvaluator(def, data, env);
  const missing = [];
  const warnings = [];

  function check(sc, fields, sectionTitle, prefix = '') {
    for (const field of fields) {
      if (field.type === 'note' || field.type === 'calc') continue;
      if (!sc.isVisible(field.id)) continue;
      const label = prefix + (field.label || field.id);
      const value = sc.lookup(field.id);
      if (field.type === 'repeat') {
        const items = sc.items(field.id);
        if (sc.isRequired(field) && items.length < Math.max(1, field.min_items || 0)) {
          missing.push({ id: field.id, label, section: sectionTitle });
        }
        items.forEach((child, i) => check(child, field.fields || [], sectionTitle, `${field.item_label || 'Item'} ${i + 1}: `));
        continue;
      }
      const empty = field.type === 'dims'
        ? !Array.isArray(value) || value.filter(x => !isEmpty(x)).length < (field.axes || []).length
        : isEmpty(value);
      if (empty && sc.isRequired(field)) missing.push({ id: field.id, label, section: sectionTitle });
      if (!empty && field.other && (value === 'other' || (Array.isArray(value) && value.includes('other'))) && isEmpty(sc.raw(`${field.id}_other`))) {
        missing.push({ id: `${field.id}_other`, label: `${label} (other)`, section: sectionTitle });
      }
      const numbers = field.type === 'number' ? [value] : field.type === 'dims' ? (Array.isArray(value) ? value : [value]) : [];
      if (numbers.some(n => !isEmpty(n) && isNaN(Number(n)))) {
        missing.push({ id: field.id, label: `${label} (not a valid number)`, section: sectionTitle });
        continue;
      }
      for (const n of numbers) {
        if (isEmpty(n)) continue;
        if ((field.min !== undefined && Number(n) < field.min) || (field.max !== undefined && Number(n) > field.max)) {
          warnings.push({ id: field.id, label, message: `${formatNumber(n)} is outside the expected range (${field.min ?? '–'} to ${field.max ?? '–'})` });
        }
      }
    }
  }

  for (const section of def.sections || []) {
    if (!scope.sectionVisible(section)) continue;
    check(scope, section.fields || [], section.title);
  }
  return { missing, warnings };
}

// Snapshot of calculated values (stored with the exam so they are auditable).
export function computeCalcs(def, data, env) {
  const scope = createEvaluator(def, data, env);
  const out = {};
  for (const section of def.sections || []) {
    for (const field of section.fields || []) {
      if (field.type === 'calc') out[field.id] = scope.lookup(field.id);
    }
  }
  return out;
}

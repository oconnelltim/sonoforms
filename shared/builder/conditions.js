// SPDX-License-Identifier: GPL-3.0-or-later
//
// Converts between form-expression conditions (show_if, required, report
// "if" blocks) and the simple row-based structure the visual form builder
// edits: "Right ovary is Visualized and Patient sex is F". Conditions that
// don't fit that shape (mixed and/or, arithmetic, function calls) return
// null, and the builder offers them as text instead.

import { parse } from '../expr.js';

// Operators offered per answer type, in menu order.
export const OPERATORS = {
  '==': { label: 'is', needsValue: true },
  '!=': { label: 'is not', needsValue: true },
  in: { label: 'is one of', needsValue: true, multiple: true },
  has: { label: 'includes', needsValue: true },
  '!has': { label: "doesn't include", needsValue: true },
  '>': { label: 'is more than', needsValue: true, number: true },
  '>=': { label: 'is at least', needsValue: true, number: true },
  '<': { label: 'is less than', needsValue: true, number: true },
  '<=': { label: 'is at most', needsValue: true, number: true },
  checked: { label: 'is checked', needsValue: false },
  unchecked: { label: 'is not checked', needsValue: false },
  filled: { label: 'is filled in', needsValue: false },
  empty: { label: 'is empty', needsValue: false },
};

export function operatorsFor(type) {
  switch (type) {
    case 'choice': return ['==', '!=', 'in', 'filled', 'empty'];
    case 'multi': return ['has', '!has', 'filled', 'empty'];
    case 'number': case 'calc': case 'age': return ['>', '>=', '<', '<=', '==', 'filled', 'empty'];
    case 'boolean': return ['checked', 'unchecked'];
    default: return ['filled', 'empty'];
  }
}

const isId = n => n && n.k === 'id';
const isLit = n => n && n.k === 'lit' && (typeof n.v === 'string' || typeof n.v === 'number');

function leaf(n) {
  if (isId(n)) return { field: n.name, op: 'checked' };
  if (n.k === 'not' && isId(n.a)) return { field: n.a.name, op: 'unchecked' };
  if (n.k === 'not' && n.a.k === 'call' && n.a.name === 'has' && n.a.args.length === 2 && isId(n.a.args[0]) && isLit(n.a.args[1])) {
    return { field: n.a.args[0].name, op: '!has', value: n.a.args[1].v };
  }
  if (n.k === 'call' && n.args.length === 1 && isId(n.args[0]) && (n.name === 'present' || n.name === 'empty')) {
    return { field: n.args[0].name, op: n.name === 'present' ? 'filled' : 'empty' };
  }
  if (n.k === 'call' && n.name === 'has' && n.args.length === 2 && isId(n.args[0]) && isLit(n.args[1])) {
    return { field: n.args[0].name, op: 'has', value: n.args[1].v };
  }
  if (n.k === 'bin' && isId(n.a)) {
    if ((n.op === '==' || n.op === '!=') && isLit(n.b)) return { field: n.a.name, op: n.op, value: n.b.v };
    if (['<', '<=', '>', '>='].includes(n.op) && isLit(n.b) && typeof n.b.v === 'number') return { field: n.a.name, op: n.op, value: n.b.v };
    if (n.op === 'in' && n.b.k === 'list' && n.b.items.every(isLit)) return { field: n.a.name, op: 'in', value: n.b.items.map(i => i.v) };
  }
  return null;
}

// Returns { join: 'and' | 'or', rows: [{ field, op, value }] } or null.
export function parseCondition(src) {
  if (src === undefined || src === null || String(src).trim() === '') return { join: 'and', rows: [] };
  let ast;
  try { ast = parse(String(src)); } catch { return null; }
  let join = null;
  const parts = [];
  const flatten = (n) => {
    if (n.k === 'and' || n.k === 'or') {
      if (join && join !== n.k) throw new Error('mixed');
      join = n.k;
      flatten(n.a);
      flatten(n.b);
    } else parts.push(n);
  };
  try { flatten(ast); } catch { return null; }
  const rows = parts.map(leaf);
  if (rows.some(r => !r)) return null;
  return { join: join || 'and', rows };
}

const quote = v => (typeof v === 'number' ? String(v) : `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`);

function rowToExpr(r) {
  switch (r.op) {
    case 'checked': return r.field;
    case 'unchecked': return `not ${r.field}`;
    case 'filled': return `present(${r.field})`;
    case 'empty': return `empty(${r.field})`;
    case 'has': return `has(${r.field}, ${quote(r.value)})`;
    case '!has': return `not has(${r.field}, ${quote(r.value)})`;
    case 'in': return `${r.field} in [${(Array.isArray(r.value) ? r.value : [r.value]).map(quote).join(', ')}]`;
    case '>': case '>=': case '<': case '<=': {
      const n = Number(r.value);
      return `${r.field} ${r.op} ${Number.isFinite(n) ? n : 0}`;
    }
    default: return `${r.field} ${r.op} ${quote(r.value ?? '')}`;
  }
}

// Builds the expression text; returns '' for no rows.
export function serializeCondition(cond) {
  const rows = (cond?.rows || []).filter(r => r.field && r.op);
  return rows.map(rowToExpr).join(cond?.join === 'or' ? ' or ' : ' and ');
}

// "Right ovary is Visualized and Patient sex is F". lookup(id) returns a
// field definition (or a pseudo-field for patient.age / patient.sex).
export function describeCondition(src, lookup) {
  const cond = parseCondition(src);
  if (!cond) return String(src);
  const optionLabel = (field, v) => field?.options?.find(o => String(o.value) === String(v))?.label ?? v;
  return cond.rows.map((r) => {
    const field = lookup(r.field);
    const name = field?.label || r.field;
    const op = OPERATORS[r.op]?.label || r.op;
    if (!OPERATORS[r.op]?.needsValue) return `${name} ${op}`;
    const value = Array.isArray(r.value) ? r.value.map(v => optionLabel(field, v)).join(' or ') : optionLabel(field, r.value);
    return `${name} ${op} ${value}`;
  }).join(cond.join === 'or' ? ' or ' : ' and ');
}

// Fields that can appear on the left of a condition, beyond form fields.
export const CONTEXT_FIELDS = [
  { id: 'patient.sex', label: 'Patient sex', type: 'choice', options: [{ value: 'F', label: 'Female' }, { value: 'M', label: 'Male' }, { value: 'O', label: 'Other' }] },
  { id: 'patient.age', label: 'Patient age (years)', type: 'age' },
];

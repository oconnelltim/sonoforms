// SPDX-License-Identifier: GPL-3.0-or-later
//
// Finding and renaming references to a field across a form definition, so
// the visual builder can rename fields safely and warn before deleting one
// that something else depends on.

import { compile, identifiers } from '../expr.js';
import { parseTemplate } from '../template.js';
import { slugify } from '../formdef.js';
import { tokenize, join } from './template-tokens.js';

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Renames identifiers in an expression, leaving quoted strings alone.
// References to "<old>_other" (the free-text box of an "Other" choice) follow.
export function renameInExpression(src, oldId, newId) {
  if (src === undefined || src === null || typeof src !== 'string') return src;
  const re = new RegExp(`(?<![A-Za-z0-9_.@])${escapeRe(oldId)}(_other)?(?![A-Za-z0-9_.])`, 'g');
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < src.length && src[j] !== '"' && src[j] !== "'") j++;
    out += src.slice(i, j).replace(re, (_, other) => `${newId}${other || ''}`);
    i = j;
  }
  return out;
}

// Renames inside report-template tags only; filters after "|" are untouched.
export function renameInTemplate(src, oldId, newId) {
  if (typeof src !== 'string') return src;
  return join(tokenize(src).map((t) => {
    if (t.kind !== 'tag') return t;
    const inner = t.raw.slice(2, -2);
    // Split off filters at a single "|" outside quotes.
    let quote = null;
    let cut = inner.length;
    for (let k = 0; k < inner.length; k++) {
      const c = inner[k];
      if (quote) { if (c === quote) quote = null; continue; }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === '|' && inner[k + 1] !== '|' && inner[k - 1] !== '|') { cut = k; break; }
    }
    return { ...t, raw: `{{${renameInExpression(inner.slice(0, cut), oldId, newId)}${inner.slice(cut)}}}` };
  }));
}

function templateIds(src) {
  const ids = new Set();
  let nodes;
  try { nodes = parseTemplate(src); } catch { return ids; }
  const walk = (list) => {
    for (const n of list) {
      if (n.k === 'expr') identifiers(n.ast, ids);
      if (n.k === 'if') n.branches.forEach(b => { identifiers(b.cond, ids); walk(b.body); });
      if (n.k === 'if' && n.elseBody) walk(n.elseBody);
      if (n.k === 'each') { ids.add(n.name); walk(n.body); }
    }
  };
  walk(nodes);
  return ids;
}

function exprIds(src) {
  if (typeof src !== 'string' || !src.trim()) return new Set();
  try { return identifiers(compile(src)); } catch { return new Set(); }
}

// Where is field `id` used? Returns [{ where, path }] with readable text.
export function findReferences(def, id) {
  const hits = [];
  const uses = ids => ids.has(id) || ids.has(`${id}_other`);
  for (const [si, s] of (def.sections || []).entries()) {
    const sTitle = s.title || s.id;
    if (uses(exprIds(s.show_if))) hits.push({ where: `"${sTitle}" section's show-only-when rule`, path: [si] });
    if (typeof s.report === 'string' && uses(templateIds(s.report))) hits.push({ where: `"${sTitle}" report text`, path: [si] });
    for (const [fi, f] of (s.fields || []).entries()) {
      const check = (field, path, prefix = '') => {
        if (field.id === id) return;
        const name = `${prefix}"${field.label || field.id}"`;
        if (uses(exprIds(field.show_if))) hits.push({ where: `${name}'s show-only-when rule`, path });
        if (typeof field.required === 'string' && uses(exprIds(field.required))) hits.push({ where: `${name}'s required-when rule`, path });
        if (uses(exprIds(field.formula))) hits.push({ where: `${name}'s calculation`, path });
      };
      check(f, [si, fi]);
      for (const [ki, sub] of (f.fields || []).entries()) check(sub, [si, fi, ki], `${f.label || f.id} › `);
    }
  }
  const report = def.report || {};
  if (uses(templateIds(report.header || ''))) hits.push({ where: 'the report header', path: [] });
  if (uses(templateIds(report.footer || ''))) hits.push({ where: 'the report footer', path: [] });
  return hits;
}

const RESERVED = new Set(['__proto__', 'constructor', 'prototype', 'patient', 'exam', 'institution', 'true', 'false', 'null', 'and', 'or', 'not', 'in', 'if', 'each', 'else']);

// An id for a new field, derived from its question text, unique in the form.
export function uniqueFieldId(def, label, { exclude } = {}) {
  let base = slugify(label || 'field').replace(/^(\d)/, 'f_$1').slice(0, 48) || 'field';
  if (RESERVED.has(base) || base.startsWith('__')) base = `${base.replace(/^_+/, '')}_field`;
  const taken = new Set();
  for (const s of def.sections || []) {
    for (const f of s.fields || []) {
      taken.add(f.id);
      if (f.other) taken.add(`${f.id}_other`);
      for (const sub of f.fields || []) taken.add(sub.id);
    }
  }
  if (exclude) taken.delete(exclude);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}_${n}`)) return `${base}_${n}`;
}

export function uniqueSectionId(def, title) {
  const base = slugify(title || 'section').replace(/^(\d)/, 's_$1').slice(0, 48) || 'section';
  const taken = new Set((def.sections || []).map(s => s.id));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}_${n}`)) return `${base}_${n}`;
}

// SPDX-License-Identifier: GPL-3.0-or-later
//
// Report templates. Syntax (documented in docs/FORMS.md):
//
//   {{ field }}                 report text for a field (option text, value + unit, ...)
//   {{ field | num }}           filters: num, upper, lower, cap, sentence
//   {{ round(ellipsoid(ovary), 1) }}   any expression
//   {{#if expr}} ... {{else if expr}} ... {{else}} ... {{/if}}
//   {{#each nodules}} {{@index}}. {{size}} {{/each}}
//   {{! comment }}
//
// A line holding only a block tag ({{#if}}, {{else}}, {{/if}}, ...) is
// removed entirely, so templates can be laid out one tag per line.

import { compile, evaluate, truthy, isEmpty } from './expr.js';
import { createEvaluator, formatValue, naturalJoin } from './engine.js';

export class TemplateError extends Error {}

const TAG = /\{\{([\s\S]*?)\}\}/g;

function lex(src) {
  const parts = [];
  let last = 0;
  let m;
  TAG.lastIndex = 0;
  while ((m = TAG.exec(src))) {
    if (m.index > last) parts.push({ type: 'text', value: src.slice(last, m.index) });
    const inner = m[1].trim();
    let tag;
    if (inner.startsWith('!')) tag = { type: 'comment' };
    else if (/^#if\b/.test(inner)) tag = { type: 'if', expr: inner.slice(3).trim() };
    else if (/^else\s+if\b/.test(inner)) tag = { type: 'elseif', expr: inner.replace(/^else\s+if/, '').trim() };
    else if (inner === 'else') tag = { type: 'else' };
    else if (inner === '/if') tag = { type: 'endif' };
    else if (/^#each\b/.test(inner)) tag = { type: 'each', expr: inner.slice(5).trim() };
    else if (inner === '/each') tag = { type: 'endeach' };
    else tag = { type: 'expr', expr: inner };
    tag.block = tag.type !== 'expr';
    parts.push(tag);
    last = TAG.lastIndex;
  }
  if (last < src.length) parts.push({ type: 'text', value: src.slice(last) });

  // Standalone block tags: strip the indentation before them and the newline after.
  // startsLine[i] is true when part i begins at the start of a line.
  const startsLine = [true];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.block) {
      const prev = parts[i - 1];
      const next = parts[i + 1];
      const prevOk = !prev || (prev.type === 'text' &&
        (/\n[ \t]*$/.test(prev.value) || (startsLine[i - 1] && /^[ \t]*$/.test(prev.value))));
      const nextOk = !next || (next.type === 'text' && /^[ \t]*(\r?\n|$)/.test(next.value));
      if (prevOk && nextOk) {
        if (prev) prev.value = prev.value.replace(/[ \t]*$/, '');
        if (next) next.value = next.value.replace(/^[ \t]*\r?\n?/, '');
        startsLine[i + 1] = true;
        continue;
      }
    }
    startsLine[i + 1] = p.type === 'text' ? /\n$/.test(p.value) || (startsLine[i] && p.value === '') : false;
  }
  return parts;
}

function splitFilters(expr) {
  // Split on single '|' (not '||') outside of quotes.
  const out = [];
  let cur = '', quote = null;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (quote) { cur += c; if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '|' && expr[i + 1] !== '|' && expr[i - 1] !== '|') { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  out.push(cur.trim());
  return { expr: out[0], filters: out.slice(1).filter(Boolean) };
}

export const FILTERS = {
  num: v => v,          // handled specially: drops the unit
  raw: v => v,          // handled specially: raw stored value
  upper: s => s.toUpperCase(),
  lower: s => s.toLowerCase(),
  cap: s => s.charAt(0).toUpperCase() + s.slice(1),
  sentence: s => {
    const t = s.trim();
    if (!t) return t;
    const c = t.charAt(0).toUpperCase() + t.slice(1);
    return /[.!?:]$/.test(c) ? c : `${c}.`;
  },
};

export function parseTemplate(src) {
  const parts = lex(String(src ?? ''));
  let pos = 0;

  function parseBlock(stopAt) {
    const nodes = [];
    while (pos < parts.length) {
      const p = parts[pos];
      if (stopAt.includes(p.type)) return nodes;
      pos++;
      if (p.type === 'text') nodes.push({ k: 'text', v: p.value });
      else if (p.type === 'comment') continue;
      else if (p.type === 'expr') {
        const { expr, filters } = splitFilters(p.expr);
        for (const f of filters) if (!FILTERS[f]) throw new TemplateError(`Unknown filter '${f}' in {{${p.expr}}}`);
        nodes.push({ k: 'expr', src: expr, ast: compile(expr), filters });
      } else if (p.type === 'if') {
        const branches = [{ cond: compile(p.expr), src: p.expr, body: parseBlock(['elseif', 'else', 'endif']) }];
        let elseBody = null;
        for (;;) {
          const t = parts[pos];
          if (!t) throw new TemplateError(`Missing {{/if}} for {{#if ${p.expr}}}`);
          pos++;
          if (t.type === 'elseif') branches.push({ cond: compile(t.expr), src: t.expr, body: parseBlock(['elseif', 'else', 'endif']) });
          else if (t.type === 'else') elseBody = parseBlock(['endif']);
          else if (t.type === 'endif') break;
        }
        nodes.push({ k: 'if', branches, elseBody });
      } else if (p.type === 'each') {
        const body = parseBlock(['endeach']);
        if (!parts[pos]) throw new TemplateError(`Missing {{/each}} for {{#each ${p.expr}}}`);
        pos++;
        nodes.push({ k: 'each', name: p.expr, body });
      } else {
        throw new TemplateError(`Unexpected {{${p.type === 'endif' ? '/if' : p.type === 'endeach' ? '/each' : p.type}}}`);
      }
    }
    if (stopAt.length) throw new TemplateError(`Template ended before {{/${stopAt.includes('endif') ? 'if' : 'each'}}}`);
    return nodes;
  }
  return parseBlock([]);
}

const templateCache = new Map();
function getTemplate(src) {
  let t = templateCache.get(src);
  if (!t) {
    t = parseTemplate(src);
    if (templateCache.size > 500) templateCache.clear();
    templateCache.set(src, t);
  }
  return t;
}

function renderNodes(nodes, scope) {
  let out = '';
  for (const n of nodes) {
    if (n.k === 'text') out += n.v;
    else if (n.k === 'expr') out += renderExpr(n, scope);
    else if (n.k === 'if') {
      const branch = n.branches.find(b => truthy(evaluate(b.cond, scope)));
      if (branch) out += renderNodes(branch.body, scope);
      else if (n.elseBody) out += renderNodes(n.elseBody, scope);
    } else if (n.k === 'each') {
      for (const child of scope.items(n.name)) out += renderNodes(n.body, child);
    }
  }
  return out;
}

function renderExpr(node, scope) {
  let text;
  const isField = node.ast.k === 'id' && scope.field(node.ast.name);
  if (node.filters.includes('raw')) text = formatValue(evaluate(node.ast, scope));
  else if (isField) text = scope.format(node.ast.name, { nounit: node.filters.includes('num') });
  else {
    const v = evaluate(node.ast, scope);
    text = Array.isArray(v) ? naturalJoin(v.map(formatValue)) : formatValue(v);
  }
  for (const f of node.filters) if (f !== 'num' && f !== 'raw') text = FILTERS[f](text);
  return text;
}

// Tidy whitespace and punctuation left behind by empty conditionals.
export function tidy(text) {
  return text
    .split('\n')
    .map(line => {
      const indent = /^\s*/.exec(line)[0];
      return indent + line.slice(indent.length).replace(/[ \t]{2,}/g, ' ').replace(/\s+([.,;:])/g, '$1').replace(/([.,;:])\1+/g, '$1').replace(/\s+$/, '');
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function renderTemplate(src, scope) {
  return tidy(renderNodes(getTemplate(src), scope));
}

// Fallback when a section has no report template: "TITLE: Label: value. Label: value."
function defaultSectionText(section, scope) {
  const bits = [];
  for (const field of section.fields || []) {
    if (['note', 'repeat'].includes(field.type)) continue;
    const text = scope.format(field.id);
    if (!isEmpty(text)) bits.push(`${field.label ? `${field.label}: ` : ''}${text}`);
  }
  if (!bits.length) return '';
  return `${(section.title || '').toUpperCase()}: ${bits.join('. ')}.`;
}

// Build the full findings text for an exam.
// Returns { text, sections: [{id, title, text, error?}], errors: [] }
export function generateReport(def, data, env = {}) {
  const scope = createEvaluator(def, data, env);
  const sections = [];
  const errors = [];
  const render = (src, label) => {
    try { return renderTemplate(src, scope); } catch (e) { errors.push(`${label}: ${e.message}`); return ''; }
  };
  for (const section of def.sections || []) {
    if (section.report === false) continue;
    let text = '';
    try {
      if (!scope.sectionVisible(section)) continue;
      text = section.report ? renderTemplate(section.report, scope) : defaultSectionText(section, scope);
    } catch (e) {
      errors.push(`${section.title || section.id}: ${e.message}`);
      sections.push({ id: section.id, title: section.title, text: '', error: e.message });
      continue;
    }
    if (text) sections.push({ id: section.id, title: section.title, text });
  }
  const report = def.report || {};
  const pieces = [];
  if (report.header) { const h = render(report.header, 'Report header'); if (h) pieces.push(h); }
  pieces.push(...sections.map(s => s.text));
  if (report.footer) { const f = render(report.footer, 'Report footer'); if (f) pieces.push(f); }
  const separator = report.separator ?? '\n\n';
  return { text: pieces.join(separator).trim(), sections, errors };
}

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
import { REPORT_FIELDS, REPORT_FIELD_IDS, DEFAULT_REPORT_FIELD, reportText, defaultHeading } from './report-fields.js';

export class TemplateError extends Error {}

// Length of the run of spaces/tabs at the end (or start) of s. Written as
// loops rather than regexes so long whitespace runs can't cause slow
// backtracking (templates and answers are user-supplied).
function trailingBlanks(s) {
  let i = s.length;
  while (i > 0 && (s[i - 1] === ' ' || s[i - 1] === '\t')) i--;
  return s.length - i;
}
function leadingBlanks(s) {
  let i = 0;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  return i;
}

function classifyTag(inner) {
  if (inner.startsWith('!')) return { type: 'comment' };
  if (/^#if\b/.test(inner)) return { type: 'if', expr: inner.slice(3).trim() };
  if (/^else\s+if\b/.test(inner)) return { type: 'elseif', expr: inner.replace(/^else\s+if/, '').trim() };
  if (inner === 'else') return { type: 'else' };
  if (inner === '/if') return { type: 'endif' };
  if (/^#each\b/.test(inner)) return { type: 'each', expr: inner.slice(5).trim() };
  if (inner === '/each') return { type: 'endeach' };
  return { type: 'expr', expr: inner };
}

function lex(src) {
  const parts = [];
  let pos = 0;
  // Linear scan: find "{{", then the next "}}". An unclosed "{{" ends the scan.
  for (;;) {
    const open = src.indexOf('{{', pos);
    if (open === -1) break;
    const close = src.indexOf('}}', open + 2);
    if (close === -1) throw new TemplateError('A "{{" has no matching "}}"');
    if (open > pos) parts.push({ type: 'text', value: src.slice(pos, open) });
    const tag = classifyTag(src.slice(open + 2, close).trim());
    tag.block = tag.type !== 'expr';
    parts.push(tag);
    pos = close + 2;
  }
  if (pos < src.length) parts.push({ type: 'text', value: src.slice(pos) });

  // Standalone block tags: strip the indentation before them and the newline after.
  // startsLine[i] is true when part i begins at the start of a line.
  const startsLine = [true];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.block) {
      const prev = parts[i - 1];
      const next = parts[i + 1];
      let prevOk = !prev;
      if (prev && prev.type === 'text') {
        const before = prev.value.slice(0, prev.value.length - trailingBlanks(prev.value));
        prevOk = before.endsWith('\n') || (startsLine[i - 1] && before === '');
      }
      let nextOk = !next;
      if (next && next.type === 'text') {
        const after = next.value.slice(leadingBlanks(next.value));
        nextOk = after === '' || after.startsWith('\n') || after.startsWith('\r\n');
      }
      if (prevOk && nextOk) {
        if (prev) prev.value = prev.value.slice(0, prev.value.length - trailingBlanks(prev.value));
        if (next) {
          let v = next.value.slice(leadingBlanks(next.value));
          if (v.startsWith('\r\n')) v = v.slice(2); else if (v.startsWith('\n')) v = v.slice(1);
          next.value = v;
        }
        startsLine[i + 1] = true;
        continue;
      }
    }
    startsLine[i + 1] = p.type === 'text' ? p.value.endsWith('\n') || (startsLine[i] && p.value === '') : false;
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
// Every pattern here is linear-time: runs of spaces/tabs are collapsed
// first, and only single space/tab characters precede punctuation after that.
export function tidy(text) {
  return text
    .split('\n')
    .map(line => {
      const n = leadingBlanks(line);
      const body = line.slice(n).replace(/[ \t]{2,}/g, ' ').replace(/[ \t]([.,;:])/g, '$1').replace(/([.,;:])\1+/g, '$1');
      return (line.slice(0, n) + body).trimEnd();
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

// The report parts a section contributes: [[reportFieldId, template]].
// `report` is a template string (going to the section's report_field,
// Findings by default), a map of { reportFieldId: template }, or false.
// A missing template means "use the default text".
export function sectionReportParts(section) {
  const r = section.report;
  if (r === false) return [];
  if (r && typeof r === 'object') {
    return Object.entries(r).map(([field, tpl]) => [REPORT_FIELD_IDS.includes(field) ? field : DEFAULT_REPORT_FIELD, tpl ?? '']);
  }
  const field = REPORT_FIELD_IDS.includes(section.report_field) ? section.report_field : DEFAULT_REPORT_FIELD;
  return [[field, r ?? null]];
}

// Build the report for an exam.
// Returns {
//   fields:   [{ id, label, text }]  one per report field that has text, in report order
//   text:     the whole report as one block (headings added when there are several fields)
//   heading:  e.g. "ULTRASOUND ABDOMEN", for a report combined with other exams
//   sections: [{ id, title, text, parts: [{ field, text }], error? }]
//   errors:   []
// }
export function generateReport(def, data, env = {}) {
  const scope = createEvaluator(def, data, env);
  const sections = [];
  const errors = [];
  const byField = new Map(REPORT_FIELD_IDS.map(id => [id, []]));
  const render = (src, label) => {
    try { return renderTemplate(src, scope); } catch (e) { errors.push(`${label}: ${e.message}`); return ''; }
  };
  for (const section of def.sections || []) {
    const partsSpec = sectionReportParts(section);
    if (!partsSpec.length) continue;
    try {
      if (!scope.sectionVisible(section)) continue;
      const parts = [];
      for (const [field, tpl] of partsSpec) {
        const text = tpl === null ? defaultSectionText(section, scope) : renderTemplate(tpl, scope);
        if (text) parts.push({ field, text });
      }
      for (const p of parts) byField.get(p.field).push(p.text);
      if (parts.length) sections.push({ id: section.id, title: section.title, text: parts.map(p => p.text).join('\n'), parts });
    } catch (e) {
      errors.push(`${section.title || section.id}: ${e.message}`);
      sections.push({ id: section.id, title: section.title, text: '', parts: [], error: e.message });
    }
  }
  const report = def.report || {};
  const findings = byField.get(DEFAULT_REPORT_FIELD);
  if (report.header) { const h = render(report.header, 'Report header'); if (h) findings.unshift(h); }
  if (report.footer) { const f = render(report.footer, 'Report footer'); if (f) findings.push(f); }
  const separator = report.separator ?? '\n\n';
  const fields = REPORT_FIELDS
    .map(f => ({ id: f.id, label: f.label, text: byField.get(f.id).join(separator).trim() }))
    .filter(f => f.text);
  // Used when this exam is reported together with others from the same visit.
  const heading = (report.heading ? render(report.heading, 'Report heading').trim() : '') || defaultHeading(def.title);
  return { fields, text: reportText(fields), heading, sections, errors };
}

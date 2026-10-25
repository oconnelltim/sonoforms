// SPDX-License-Identifier: GPL-3.0-or-later
//
// Splits a report template into plain text and "tags" so the visual editor
// can show each tag as a labelled chip ([Size], [If Right ovary is
// Visualized], [Otherwise], [End if]) while keeping the exact template text.
// join(tokenize(src)) === src for any input.

import { describeCondition } from './conditions.js';

const FIELD_TAG = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*((?:\|\s*[a-z]+\s*)*)$/;

export const FILTER_LABELS = { cap: 'capitalized', upper: 'UPPER CASE', lower: 'lower case', sentence: 'as a sentence', num: 'number only', raw: 'stored value' };

function classify(inner) {
  const t = inner.trim();
  if (t.startsWith('!')) return { type: 'comment', text: t.slice(1).trim() };
  if (/^#if\b/.test(t)) return { type: 'if', expr: t.slice(3).trim() };
  if (/^else\s+if\b/.test(t)) return { type: 'elseif', expr: t.replace(/^else\s+if/, '').trim() };
  if (t === 'else') return { type: 'else' };
  if (t === '/if') return { type: 'endif' };
  if (/^#each\b/.test(t)) return { type: 'each', name: t.slice(5).trim() };
  if (t === '/each') return { type: 'endeach' };
  const m = FIELD_TAG.exec(inner);
  if (m) return { type: 'field', id: m[1], filters: m[2].split('|').map(x => x.trim()).filter(Boolean) };
  return { type: 'expr', expr: t };
}

// Linear-time split into [{ kind: 'text', text } | { kind: 'tag', raw, ...classification }].
export function tokenize(src) {
  const s = String(src ?? '');
  const out = [];
  let pos = 0;
  for (;;) {
    const open = s.indexOf('{{', pos);
    const close = open === -1 ? -1 : s.indexOf('}}', open + 2);
    if (open === -1 || close === -1) break;
    if (open > pos) out.push({ kind: 'text', text: s.slice(pos, open) });
    const raw = s.slice(open, close + 2);
    out.push({ kind: 'tag', raw, ...classify(raw.slice(2, -2)) });
    pos = close + 2;
  }
  if (pos < s.length) out.push({ kind: 'text', text: s.slice(pos) });
  return out;
}

export function join(tokens) {
  return tokens.map(t => (t.kind === 'text' ? t.text : t.raw)).join('');
}

// Readable chip label. lookup(id) returns a field definition or undefined.
export function chipLabel(token, lookup) {
  const name = id => lookup(id)?.label || id;
  switch (token.type) {
    case 'field': {
      const f = token.filters.length ? ` · ${token.filters.map(x => FILTER_LABELS[x] || x).join(', ')}` : '';
      return `${name(token.id)}${f}`;
    }
    case 'if': return `If ${describeCondition(token.expr, lookup)}`;
    case 'elseif': return `Otherwise, if ${describeCondition(token.expr, lookup)}`;
    case 'else': return 'Otherwise';
    case 'endif': return 'End if';
    case 'each': return `For each ${String(lookup(token.name)?.item_label || name(token.name)).toLowerCase()}`;
    case 'endeach': return 'End for each';
    case 'comment': return `Note: ${token.text}`;
    default: return `= ${token.expr}`;
  }
}

export const fieldTag = (id, filters = []) => `{{${id}${filters.map(f => ` | ${f}`).join('')}}}`;

// A sensible first draft of report text for a section, built from its fields.
export function defaultSectionTemplate(section) {
  const title = String(section.title || section.id || '').toUpperCase();
  const parts = [];
  const lines = [];
  for (const f of section.fields || []) {
    const label = f.label || f.id;
    switch (f.type) {
      case 'note': break;
      case 'choice': parts.push(`{{${f.id} | sentence}}`); break;
      case 'multi': parts.push(`${label}: {{${f.id}}}.`); break;
      case 'dims': parts.push(`${label} measures {{${f.id}}}.`); break;
      case 'number': case 'calc': parts.push(`${label}: {{${f.id}}}.`); break;
      case 'boolean': parts.push(`{{#if ${f.id}}}${label}.{{/if}}`); break;
      case 'date': parts.push(`${label}: {{${f.id}}}.`); break;
      case 'repeat': {
        const subs = (f.fields || []).filter(x => x.type !== 'note').map(x => `{{${x.id}}}`).join(', ');
        lines.push(`{{#each ${f.id}}}`, `- ${f.item_label || 'Item'} {{@index}}: ${subs}.`, '{{/each}}');
        break;
      }
      default: parts.push(`{{${f.id}}}`);
    }
  }
  return [`${title}: ${parts.join(' ')}`.trimEnd(), ...lines].join('\n');
}

// SPDX-License-Identifier: GPL-3.0-or-later
//
// "Show only when" editor: rows of [field] [is / is not / …] [value],
// joined by "and" or "or". Conditions too complex for rows are edited as
// text instead, so nothing a form author wrote is ever lost.

import { h, mount } from '../dom.js';
import { parseCondition, serializeCondition, operatorsFor, OPERATORS, CONTEXT_FIELDS } from '/shared/builder/conditions.js';

// fields: [{ id, label, type, options }] that a rule may refer to.
export function conditionEditor({ value, fields, onChange, readOnly = false, emptyText = 'Always shown' }) {
  const el = h('div.cond-editor');
  const all = [...fields, ...CONTEXT_FIELDS];
  const byId = id => all.find(f => f.id === id);
  let cond = parseCondition(value);
  let raw = value || '';

  const emit = () => onChange(cond ? serializeCondition(cond) : raw);

  function defaultValue(field, op) {
    const o = OPERATORS[op];
    if (!o?.needsValue) return undefined;
    if (o.multiple) return [];
    if (field?.options?.length) return field.options[0].value;
    return o.number ? 0 : '';
  }

  function valueControl(row, field) {
    const op = OPERATORS[row.op];
    if (!op?.needsValue) return null;
    if (field?.options && op.multiple) {
      const chosen = new Set((Array.isArray(row.value) ? row.value : [row.value]).filter(v => v !== undefined).map(String));
      return h('div.cond-multi', field.options.map(o => h('label.check.small',
        h('input', { type: 'checkbox', disabled: readOnly, checked: chosen.has(String(o.value)), onchange: (e) => {
          if (e.target.checked) chosen.add(String(o.value)); else chosen.delete(String(o.value));
          row.value = field.options.map(x => String(x.value)).filter(v => chosen.has(v));
          emit();
        } }), ` ${o.label}`)));
    }
    if (field?.options) {
      return h('select.input.tiny-select', { disabled: readOnly, onchange: (e) => { row.value = e.target.value; emit(); } },
        field.options.map(o => h('option', { value: o.value, selected: String(o.value) === String(row.value) }, o.label)));
    }
    return h('input.input.tiny-num', {
      type: op.number ? 'number' : 'text', value: row.value ?? '', disabled: readOnly,
      oninput: (e) => { row.value = op.number ? Number(e.target.value) : e.target.value; emit(); },
    });
  }

  function draw() {
    if (!cond) {
      mount(el,
        h('p.hint', 'This rule is more complex than the builder can show, so it is edited as text.'),
        h('input.input.mono', { value: raw, disabled: readOnly, oninput: (e) => { raw = e.target.value; emit(); } }));
      return;
    }
    const rows = cond.rows.map((row, i) => {
      const field = byId(row.field);
      const ops = operatorsFor(field?.type);
      if (!ops.includes(row.op)) row.op = ops[0];
      return h('div.cond-row',
        i === 0 ? h('span.cond-join', 'When') : h('select.input.tiny-select', {
          disabled: readOnly, 'aria-label': 'and / or',
          onchange: (e) => { cond.join = e.target.value; emit(); draw(); },
        }, h('option', { value: 'and', selected: cond.join === 'and' }, 'and'), h('option', { value: 'or', selected: cond.join === 'or' }, 'or')),
        h('select.input.tiny-select', {
          disabled: readOnly, 'aria-label': 'Field',
          onchange: (e) => {
            row.field = e.target.value;
            row.op = operatorsFor(byId(row.field)?.type)[0];
            row.value = defaultValue(byId(row.field), row.op);
            emit();
            draw();
          },
        }, all.map(f => h('option', { value: f.id, selected: f.id === row.field }, f.label || f.id)),
        field ? null : h('option', { value: row.field, selected: true }, `${row.field} (missing)`)),
        h('select.input.tiny-select', {
          disabled: readOnly, 'aria-label': 'Comparison',
          onchange: (e) => { row.op = e.target.value; row.value = defaultValue(field, row.op); emit(); draw(); },
        }, ops.map(o => h('option', { value: o, selected: o === row.op }, OPERATORS[o].label))),
        valueControl(row, field),
        readOnly ? null : h('button.icon-btn.small', { type: 'button', 'aria-label': 'Remove rule', onclick: () => { cond.rows.splice(i, 1); emit(); draw(); } }, '×'));
    });
    mount(el,
      rows.length ? rows : h('p.muted.small', emptyText),
      readOnly ? null : h('button.link.small', {
        type: 'button',
        onclick: () => {
          const first = all.find(f => f.type !== 'note' && f.type !== 'repeat');
          if (!first) return;
          const op = operatorsFor(first.type)[0];
          cond.rows.push({ field: first.id, op, value: defaultValue(first, op) });
          emit();
          draw();
        },
      }, rows.length ? '+ Add another rule' : '+ Add a rule'));
  }

  draw();
  return { el, setValue(v) { cond = parseCondition(v); raw = v || ''; draw(); } };
}

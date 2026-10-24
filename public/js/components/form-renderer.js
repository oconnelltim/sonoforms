// SPDX-License-Identifier: GPL-3.0-or-later
//
// Renders a form definition as an interactive, touch-friendly form.
// Widgets are built once; refresh() re-evaluates visibility, required
// markers and calculated values after every change without re-rendering,
// so focus and scroll position are never lost.

import { h, clear, append } from '../dom.js';
import { createEvaluator, validateAnswers } from '/shared/engine.js';
import { normalAnswers } from '/shared/formdef.js';

const isBlank = v => v === null || v === undefined || v === '' || (Array.isArray(v) && v.every(isBlank));

function parseNum(s) {
  const t = String(s).trim().replace(',', '.');
  if (t === '') return null;
  const n = Number(t);
  return isNaN(n) ? t : n; // keep invalid text so the tech can see/fix it
}

export function renderForm(def, answers, { env = {}, readOnly = false, onChange = () => {}, compact = false } = {}) {
  const entries = [];         // { el, field, scopeOf(root), sync(), update(scope) }
  const sectionEls = [];      // { section, el, navItem }
  const changed = (id) => { refresh(); onChange(id); };

  // ---- widgets ------------------------------------------------------------

  function choiceWidget(field, get, set) {
    const otherInput = field.other ? h('input.input.other-input', {
      placeholder: 'Describe…', disabled: readOnly,
      oninput: (e) => { set(`${field.id}_other`, e.target.value, true); },
    }) : null;
    if (field.layout === 'dropdown') {
      const sel = h('select.input', {
        disabled: readOnly,
        onchange: (e) => { set(field.id, e.target.value || null); sync(); },
      }, h('option', { value: '' }, '—'), field.options.map(o => h('option', { value: o.value }, o.label)));
      const sync = () => {
        sel.value = get(field.id) ?? '';
        if (otherInput) { otherInput.hidden = get(field.id) !== 'other'; otherInput.value = get(`${field.id}_other`) || ''; }
      };
      sync();
      return { el: h('div', sel, otherInput), sync };
    }
    const buttons = field.options.map(o => h('button.choice', {
      type: 'button', role: 'radio', disabled: readOnly, dataset: { value: o.value }, title: o.help || '',
      onclick: () => {
        const cur = get(field.id);
        set(field.id, String(cur) === o.value ? null : o.value);
        sync();
        if (o.value === 'other' && otherInput) otherInput.focus();
      },
    }, o.label));
    const sync = () => {
      const cur = get(field.id);
      for (const b of buttons) {
        const on = String(cur) === b.dataset.value;
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', String(on));
      }
      if (otherInput) { otherInput.hidden = cur !== 'other'; otherInput.value = get(`${field.id}_other`) || ''; }
    };
    sync();
    return { el: h('div', h(`div.choices${field.options.length > 6 ? '.many' : ''}`, { role: 'radiogroup', 'aria-label': field.label }, buttons), otherInput), sync };
  }

  function multiWidget(field, get, set) {
    const otherInput = field.other ? h('input.input.other-input', {
      placeholder: 'Describe…', disabled: readOnly,
      oninput: (e) => set(`${field.id}_other`, e.target.value, true),
    }) : null;
    const list = () => (Array.isArray(get(field.id)) ? get(field.id) : []);
    const buttons = field.options.map(o => h('button.choice.check', {
      type: 'button', role: 'checkbox', disabled: readOnly, dataset: { value: o.value },
      onclick: () => {
        const cur = list();
        const next = cur.includes(o.value) ? cur.filter(v => v !== o.value) : [...cur, o.value];
        // Keep the definition's option order.
        set(field.id, field.options.map(x => x.value).filter(v => next.includes(v)));
        sync();
        if (o.value === 'other' && otherInput && next.includes('other')) otherInput.focus();
      },
    }, o.label));
    const sync = () => {
      const cur = list();
      for (const b of buttons) {
        const on = cur.includes(b.dataset.value);
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', String(on));
      }
      if (otherInput) { otherInput.hidden = !cur.includes('other'); otherInput.value = get(`${field.id}_other`) || ''; }
    };
    sync();
    return { el: h('div', h(`div.choices${field.options.length > 6 ? '.many' : ''}`, buttons), otherInput), sync };
  }

  function numberWidget(field, get, set) {
    const input = h('input.input.num', {
      inputmode: 'decimal', autocomplete: 'off', disabled: readOnly, placeholder: field.placeholder || '',
      oninput: (e) => set(field.id, parseNum(e.target.value), true),
    });
    const sync = () => { const v = get(field.id); if (document.activeElement !== input) input.value = v ?? ''; };
    sync();
    return { el: h('div.input-unit', input, field.unit ? h('span.unit', field.unit) : null), sync };
  }

  function dimsWidget(field, get, set) {
    const axes = field.axes || ['L', 'AP', 'W'];
    const inputs = axes.map((axis, i) => h('input.input.num.dim', {
      inputmode: 'decimal', autocomplete: 'off', disabled: readOnly, 'aria-label': `${field.label} ${axis}`, placeholder: axis,
      oninput: (e) => {
        const cur = Array.isArray(get(field.id)) ? [...get(field.id)] : axes.map(() => null);
        // "8.2 x 4.1 x 5" typed or pasted into one box is spread across the axes.
        const parts = e.target.value.trim().split(/\s*[x×*]\s*|\s+/i).filter(Boolean);
        if (parts.length > 1 && parts.every(p => !isNaN(Number(p.replace(',', '.'))))) {
          parts.slice(0, axes.length - i).forEach((p, k) => { cur[i + k] = parseNum(p); inputs[i + k].value = p; });
          set(field.id, cur, true);
          inputs[Math.min(i + parts.length, axes.length - 1)].focus();
          return;
        }
        cur[i] = parseNum(e.target.value);
        set(field.id, cur.every(isBlank) ? null : cur, true);
      },
      onkeydown: (e) => {
        // Enter / space jumps to the next measurement, like most US machines' calipers.
        if ((e.key === 'Enter' || e.key === ' ') && i < axes.length - 1) { e.preventDefault(); inputs[i + 1].focus(); inputs[i + 1].select(); }
      },
    }));
    const parts = [];
    inputs.forEach((inp, i) => {
      parts.push(h('label.dim-wrap', h('span.dim-axis', axes[i]), inp));
      if (i < inputs.length - 1) parts.push(h('span.times', '×'));
    });
    const sync = () => {
      const v = Array.isArray(get(field.id)) ? get(field.id) : [];
      inputs.forEach((inp, i) => { if (document.activeElement !== inp) inp.value = v[i] ?? ''; });
    };
    sync();
    return { el: h('div.dims', parts, field.unit ? h('span.unit', field.unit) : null), sync };
  }

  function textWidget(field, get, set) {
    const multiline = field.type === 'textarea';
    const input = h(multiline ? 'textarea.input' : 'input.input', {
      disabled: readOnly, placeholder: field.placeholder || '', rows: multiline ? (field.rows || 3) : undefined,
      oninput: (e) => set(field.id, e.target.value, true),
    });
    const sync = () => { if (document.activeElement !== input) input.value = get(field.id) ?? ''; };
    sync();
    return { el: input, sync };
  }

  function dateWidget(field, get, set) {
    const input = h('input.input.date', { type: 'date', disabled: readOnly, onchange: (e) => set(field.id, e.target.value || null) });
    const sync = () => { input.value = get(field.id) ?? ''; };
    sync();
    return { el: input, sync };
  }

  function booleanWidget(field, get, set) {
    const box = h('input', { type: 'checkbox', disabled: readOnly, onchange: (e) => set(field.id, e.target.checked) });
    const sync = () => { box.checked = !!get(field.id); };
    sync();
    return { el: h('label.toggle', box, h('span.toggle-track'), h('span.toggle-label', field.label)), sync, inlineLabel: true };
  }

  function calcWidget() {
    const out = h('output.calc-value', '—');
    return { el: out, sync: () => {}, update: (scope, field) => { out.textContent = scope.format(field.id) || '—'; } };
  }

  function repeatWidget(field, get, set, scopeOfParent, level) {
    const container = h('div.repeat');
    const list = () => (Array.isArray(get(field.id)) ? get(field.id) : []);
    const draw = () => {
      // Drop registry entries for the old items before redrawing.
      for (let i = entries.length - 1; i >= 0; i--) if (entries[i].owner === field.id && entries[i].level === level + 1) entries.splice(i, 1);
      clear(container);
      list().forEach((item, idx) => {
        const itemGet = id => list()[idx]?.[id];
        const itemSet = (id, value, typing) => {
          const items = list().map(x => ({ ...x }));
          items[idx] = { ...items[idx], [id]: value };
          set(field.id, items, typing);
        };
        const scopeOf = root => scopeOfParent(root).items(field.id)[idx];
        const card = h('div.repeat-item',
          h('div.repeat-head',
            h('strong', `${field.item_label || 'Item'} ${idx + 1}`),
            readOnly ? null : h('button.btn.small.ghost', {
              type: 'button',
              onclick: () => {
                if (!confirm(`Remove ${field.item_label || 'item'} ${idx + 1}?`)) return;
                set(field.id, list().filter((_, i) => i !== idx));
                draw();
                changed(field.id);
              },
            }, 'Remove')),
          h('div.field-grid', field.fields.map(sub => fieldEl(sub, itemGet, itemSet, scopeOf, level + 1, field.id))));
        container.appendChild(card);
      });
      const max = field.max_items || 50;
      if (!readOnly && list().length < max) {
        container.appendChild(h('button.btn.add-item', {
          type: 'button',
          onclick: () => { set(field.id, [...list(), {}]); draw(); changed(field.id); container.querySelector('.repeat-item:last-of-type .input, .repeat-item:last-of-type .choice')?.focus(); },
        }, `+ Add ${String(field.item_label || 'item').toLowerCase()}`));
      }
      if (readOnly && !list().length) container.appendChild(h('p.muted', 'None'));
    };
    draw();
    return { el: container, sync: draw };
  }

  // ---- field wrapper ------------------------------------------------------

  function fieldEl(field, get, setRaw, scopeOf, level = 0, owner = null) {
    // typing=true: value changed by keystrokes; avoid re-syncing the widget.
    const set = (id, value, typing) => { setRaw(id, value, typing); changed(id); };
    let w;
    switch (field.type) {
      case 'choice': w = choiceWidget(field, get, set); break;
      case 'multi': w = multiWidget(field, get, set); break;
      case 'number': w = numberWidget(field, get, set); break;
      case 'dims': w = dimsWidget(field, get, set); break;
      case 'calc': w = calcWidget(field); break;
      case 'textarea': case 'text': w = textWidget(field, get, set); break;
      case 'date': w = dateWidget(field, get, set); break;
      case 'boolean': w = booleanWidget(field, get, set); break;
      case 'repeat': w = repeatWidget(field, get, setRaw, scopeOf, level); break;
      case 'note': w = { el: null, sync: () => {} }; break;
      default: w = textWidget(field, get, set);
    }
    const required = h('span.req', { title: 'Required', hidden: true }, '*');
    const el = field.type === 'note'
      ? h('div.field.note', { dataset: { field: field.id } }, h('div.note-text', field.label || ''))
      : h(`div.field.type-${field.type}${field.width === 'short' ? '.short' : ''}`, { dataset: { field: field.id } },
        w.inlineLabel ? null : h('div.field-label', field.label || field.id, required),
        w.el,
        field.help ? h('div.hint', field.help) : null);
    entries.push({ el, field, scopeOf, sync: w.sync, update: w.update, level, owner, required });
    return el;
  }

  // ---- layout -------------------------------------------------------------

  const rootGet = id => answers[id];
  const rootSet = (id, value) => {
    if (value === null || value === undefined) delete answers[id];
    else answers[id] = value;
  };
  const rootScope = root => root;

  const nav = h('nav.section-nav', { 'aria-label': 'Sections' });
  const body = h('div.form-body');
  for (const section of def.sections) {
    const hasNormals = section.fields.some(f => f.normal !== undefined);
    const fieldEls = section.fields.map(f => fieldEl(f, rootGet, rootSet, rootScope));
    const status = h('span.section-status');
    const el = h('section.form-section', { id: `sec-${section.id}`, dataset: { section: section.id } },
      h('div.section-head',
        h('h3', section.title || section.id),
        hasNormals && !readOnly ? h('button.btn.small.normal-btn', {
          type: 'button', title: 'Fill in the normal values for this section',
          onclick: () => {
            Object.assign(answers, normalAnswers(section));
            for (const e of entries) if (fieldEls.includes(e.el)) e.sync();
            changed(null);
          },
        }, '✓ Normal') : null),
      section.help ? h('p.hint', section.help) : null,
      h('div.field-grid', fieldEls));
    const navItem = h('a.nav-item', { href: `#sec-${section.id}`, onclick: (e) => { e.preventDefault(); el.scrollIntoView({ behavior: 'smooth', block: 'start' }); } },
      status, h('span', section.title || section.id));
    nav.appendChild(navItem);
    body.appendChild(el);
    sectionEls.push({ section, el, navItem, status });
  }

  let lastMissing = [];
  function refresh() {
    let scope;
    try { scope = createEvaluator(def, answers, env); } catch { return; }
    for (const s of sectionEls) {
      let visible = true;
      try { visible = scope.sectionVisible(s.section); } catch { /* bad expression: show */ }
      s.el.hidden = !visible;
      s.navItem.hidden = !visible;
    }
    for (const e of entries) {
      let sc;
      try { sc = e.scopeOf(scope); } catch { sc = null; }
      if (!sc) continue;
      let visible = true;
      try { visible = sc.isVisible(e.field.id); } catch { /* show */ }
      e.el.hidden = !visible;
      if (e.required) e.required.hidden = !sc.isRequired(e.field);
      if (e.update) { try { e.update(sc, e.field); } catch { /* ignore */ } }
    }
    // Section completion badges.
    try {
      const { missing } = validateAnswers(def, answers, env);
      lastMissing = missing;
      const bySection = new Map();
      for (const m of missing) bySection.set(m.section, (bySection.get(m.section) || 0) + 1);
      for (const s of sectionEls) {
        const n = bySection.get(s.section.title) || 0;
        s.status.className = `section-status ${n ? 'todo' : 'done'}`;
        s.status.textContent = n ? String(n) : '✓';
        s.status.title = n ? `${n} required item(s) left` : 'Complete';
      }
      for (const e of entries) e.el.classList.remove('missing');
      if (highlighted) highlightMissing(missing);
    } catch { /* ignore */ }
  }

  let highlighted = false;
  function highlightMissing(missing) {
    highlighted = true;
    const ids = new Set(missing.map(m => m.id.replace(/_other$/, '')));
    for (const e of entries) e.el.classList.toggle('missing', ids.has(e.field.id) && !e.el.hidden);
  }

  function focusField(id) {
    const e = entries.find(x => x.field.id === id && !x.el.hidden);
    if (!e) return;
    e.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => e.el.querySelector('input, button, select, textarea')?.focus({ preventScroll: true }), 300);
  }

  function syncAll() {
    for (const e of [...entries]) if (e.level === 0) e.sync();
    refresh();
  }

  refresh();
  const el = h(`div.form-render${compact ? '.compact' : ''}${readOnly ? '.readonly' : ''}`, body);
  return { el, nav, refresh, syncAll, highlightMissing, focusField, missing: () => lastMissing };
}

// Read-only "what the tech entered" summary used on the radiologist screen.
export function answersSummary(def, answers, env) {
  const scope = createEvaluator(def, answers, env);
  const out = h('div.answers');
  for (const section of def.sections) {
    if (!scope.sectionVisible(section)) continue;
    const rows = [];
    const addRows = (sc, fields, prefix = '') => {
      for (const f of fields) {
        if (f.type === 'note' || !sc.isVisible(f.id)) continue;
        if (f.type === 'repeat') {
          sc.items(f.id).forEach((child, i) => addRows(child, f.fields, `${prefix}${f.item_label || 'Item'} ${i + 1} · `));
          continue;
        }
        // Show what the tech picked (option labels), not the report sentence.
        let text;
        if (f.options) {
          const v = sc.lookup(f.id);
          const vals = (Array.isArray(v) ? v : [v]).filter(x => x !== null && x !== undefined && x !== '');
          text = vals.map(x => (x === 'other' && f.other ? `Other: ${sc.raw(`${f.id}_other`) || ''}` : (f.options.find(o => o.value === String(x))?.label ?? x))).join(', ');
        } else text = sc.format(f.id);
        if (text) rows.push(h('tr', h('th', prefix + (f.label || f.id)), h('td', text)));
      }
    };
    addRows(scope, section.fields);
    if (rows.length) append(out, [h('h4', section.title), h('table.kv', h('tbody', rows))]);
  }
  return out;
}

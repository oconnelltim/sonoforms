// SPDX-License-Identifier: GPL-3.0-or-later
//
// Visual form builder: an outline of sections and fields on the left and a
// plain-language settings panel for the selected item on the right. Every
// edit is applied to the form's YAML through shared/builder/yamldoc.js, so
// comments and formatting survive and the Source tab always matches.

import { h, mount, toast, modal, confirmDialog, promptDialog } from '../dom.js';
import YAML from '/vendor/yaml/index.js';
import { normalizeForm, lintForm, slugify } from '/shared/formdef.js';
import { parse as parseExpr } from '/shared/expr.js';
import { createDocTools } from '/shared/builder/yamldoc.js';
import { findReferences, uniqueFieldId, uniqueSectionId, renameInExpression, renameInTemplate } from '/shared/builder/refs.js';
import { defaultSectionTemplate, fieldTag } from '/shared/builder/template-tokens.js';
import { conditionEditor } from './condition-editor.js';
import { templateEditor } from './template-editor.js';

const tools = createDocTools(YAML);

export const TYPE_INFO = {
  choice: { label: 'Pick one', icon: '◉', hint: 'Buttons; the tech picks one answer' },
  multi: { label: 'Pick several', icon: '☑', hint: 'Check all that apply' },
  dims: { label: 'Measurement (L × AP × W)', icon: '⤢', hint: 'Two or three dimensions' },
  number: { label: 'Number', icon: '#', hint: 'One value, e.g. a thickness in mm' },
  calc: { label: 'Calculated', icon: 'ƒ', hint: 'Worked out automatically, e.g. a volume' },
  boolean: { label: 'Yes/no check box', icon: '✓', hint: 'A single check box' },
  date: { label: 'Date', icon: '◷', hint: 'A calendar date' },
  text: { label: 'Short text', icon: 'T', hint: 'One line of free text' },
  textarea: { label: 'Paragraph', icon: '¶', hint: 'Several lines of free text' },
  repeat: { label: 'Repeating group', icon: '⟳', hint: 'As many as needed, e.g. nodules' },
  note: { label: 'Instruction note', icon: 'i', hint: 'Guidance for the tech, not a question' },
};

// Keys that only make sense for some answer types (removed on type change).
const TYPE_KEYS = {
  options: ['choice', 'multi'], other: ['choice', 'multi'], layout: ['choice'], conjunction: ['multi'],
  unit: ['number', 'dims', 'calc'], decimals: ['number', 'dims', 'calc'], min: ['number', 'dims'], max: ['number', 'dims'], step: ['number'],
  axes: ['dims'], formula: ['calc'], true_text: ['boolean'], false_text: ['boolean'],
  fields: ['repeat'], item_label: ['repeat'], min_items: ['repeat'], max_items: ['repeat'], rows: ['textarea'], placeholder: ['text', 'textarea', 'number'],
};

const RECIPES = [
  { id: 'ellipsoid', label: 'Ellipsoid volume of a measurement (π/6 × L × AP × W)', params: [{ kind: 'field', types: ['dims'], label: 'Measurement' }], build: ([a]) => `ellipsoid(${a})` },
  { id: 'volume', label: 'Measurement × correction factor (e.g. 0.52 bladder, 0.71 testis)', params: [{ kind: 'field', types: ['dims'], label: 'Measurement' }, { kind: 'number', label: 'Factor', initial: 0.52 }], build: ([a, f]) => `volume(${a}, ${f})` },
  { id: 'max_dim', label: 'Largest dimension of a measurement', params: [{ kind: 'field', types: ['dims'], label: 'Measurement' }], build: ([a]) => `max_dim(${a})` },
  { id: 'points', label: 'Total points from several answers', params: [{ kind: 'fields', types: ['choice', 'multi'], label: 'Answers' }], build: ([list]) => `points(${list.join(', ')})` },
  { id: 'tirads', label: 'ACR TI-RADS level from a points total', params: [{ kind: 'field', types: ['calc', 'number'], label: 'Points total' }], build: ([a]) => `tirads(${a})` },
  { id: 'ratio', label: 'Ratio of two numbers', params: [{ kind: 'field', types: ['number', 'calc'], label: 'Top' }, { kind: 'field', types: ['number', 'calc'], label: 'Bottom' }], build: ([a, b]) => `ratio(${a}, ${b})` },
];

function matchRecipe(formula) {
  if (!formula) return { recipe: null, values: [] };
  let ast;
  try { ast = parseExpr(String(formula)); } catch { return null; }
  if (ast.k !== 'call') return null;
  const r = RECIPES.find(x => x.id === ast.name);
  if (!r) return null;
  if (r.id === 'points') return ast.args.every(a => a.k === 'id') ? { recipe: r, values: [ast.args.map(a => a.name)] } : null;
  if (ast.args.length !== r.params.length) return null;
  const values = [];
  for (const [i, p] of r.params.entries()) {
    const a = ast.args[i];
    if (p.kind === 'field' && a.k === 'id') values.push(a.name);
    else if (p.kind === 'number' && a.k === 'lit' && typeof a.v === 'number') values.push(a.v);
    else return null;
  }
  return { recipe: r, values };
}

const normalizeOption = o => (o !== null && typeof o === 'object'
  ? { ...o, value: String(o.value ?? slugify(o.label)), label: String(o.label ?? o.value) }
  : { value: slugify(String(o)), label: String(o) });

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function formBuilder({ source, readOnly = false, onChange, onSelect = () => {}, sectionPreview = () => '' }) {
  let doc = null;
  let def = null;
  let problems = [];
  let parseError = null;
  let lastSource = null;
  let sel = { kind: 'form', path: [] };
  const fresh = new Set();               // new field ids that still follow their question text
  const savedReports = new Map();        // report text kept while "include in report" is off
  const outline = h('div.fb-outline', { role: 'tree', 'aria-label': 'Form outline' });
  const panel = h('div.fb-panel');
  const el = h('div.form-builder', outline, panel);
  let previewLine = null;

  function load(src) {
    lastSource = src;
    try {
      doc = tools.parse(src);
      const raw = doc.toJS();
      def = normalizeForm(raw);
      problems = lintForm(raw);
      parseError = null;
    } catch (e) {
      parseError = e.message;
    }
  }

  // ---- model helpers ------------------------------------------------------

  const itemAt = (path) => {
    if (!def) return null;
    if (path.length === 0) return def;
    const s = def.sections[path[0]];
    if (path.length === 1) return s || null;
    const f = s?.fields?.[path[1]];
    if (path.length === 2) return f || null;
    return f?.fields?.[path[2]] || null;
  };

  const problemsFor = (path) => {
    const s = def.sections[path[0]];
    if (!s) return [];
    if (path.length === 1) return problems.filter(p => p.level === 'error' && (p.path === s.id || p.path === `${s.id}.report`));
    const ids = [s.id, s.fields[path[1]]?.id, path.length === 3 ? s.fields[path[1]]?.fields?.[path[2]]?.id : null].filter(Boolean).join('.');
    return problems.filter(p => p.level === 'error' && (p.path === ids || p.path.startsWith(`${ids}.`)) && (path.length === 3 || p.path.split('.').length <= 3));
  };

  function commit(fn, { redraw = true } = {}) {
    if (readOnly || !doc) return;
    try { fn(); } catch (e) { toast(e.message, 'error'); return; }
    lastSource = tools.stringify(doc);
    const raw = doc.toJS();
    def = normalizeForm(raw);
    problems = lintForm(raw);
    onChange(lastSource);
    drawOutline();
    if (redraw) drawPanel();
  }

  function select(next) {
    sel = next;
    drawOutline();
    drawPanel();
    const item = itemAt(sel.path);
    onSelect({ kind: sel.kind, path: sel.path, id: item?.id, sectionId: def?.sections[sel.path[0]]?.id });
  }

  // Fields a rule can refer to: siblings in the same repeat group, then
  // top-level fields (never the field itself).
  function conditionFields(path) {
    const self = path.length >= 2 ? itemAt(path) : null;
    const usable = f => f && f !== self && !['note', 'repeat'].includes(f.type);
    const list = [];
    if (path.length === 3) {
      const group = def.sections[path[0]].fields[path[1]];
      list.push(...group.fields.filter(usable).map(f => ({ f, where: group.label })));
    }
    for (const s of def.sections) list.push(...s.fields.filter(usable).map(f => ({ f, where: s.title })));
    // Names like "Size" appear in several sections; say which one.
    const counts = new Map();
    for (const { f } of list) counts.set(f.label, (counts.get(f.label) || 0) + 1);
    return list.map(({ f, where }) => (counts.get(f.label) > 1 ? { ...f, label: `${where} › ${f.label || f.id}` } : f));
  }

  const lookupField = (id) => {
    for (const s of def.sections) {
      for (const f of s.fields) {
        if (f.id === id) return f;
        for (const sub of f.fields || []) if (sub.id === id) return sub;
      }
    }
    if (id === 'patient.sex') return { label: 'Patient sex', options: [{ value: 'F', label: 'Female' }, { value: 'M', label: 'Male' }, { value: 'O', label: 'Other' }] };
    if (id === 'patient.age') return { label: 'Patient age' };
    return undefined;
  };

  // ---- outline ------------------------------------------------------------

  let dragging = null;

  function canDrop(from, to) {
    if (!from || JSON.stringify(from) === JSON.stringify(to)) return false;
    if (from.length === 1) return to.length === 1;
    if (from.length === 2) return to.length === 1 || to.length === 2;
    return to.length === 3 && to[0] === from[0] && to[1] === from[1];
  }

  function drop(from, to) {
    commit(() => {
      let moved;
      if (from.length === 1) moved = tools.move(doc, from, [], to[0]);
      else if (from.length === 2 && to.length === 1) moved = tools.move(doc, from, [to[0]], 0);
      else if (from.length === 2) moved = tools.move(doc, from, [to[0]], to[1]);
      else moved = tools.move(doc, from, [to[0], to[1]], to[2]);
      sel = { kind: moved.length === 1 ? 'section' : 'field', path: moved };
    });
  }

  function row(path, content, { cls = '', depth = 0 } = {}) {
    const selected = JSON.stringify(sel.path) === JSON.stringify(path) && sel.kind !== 'form';
    const r = h(`div.fb-row${cls}${selected ? '.selected' : ''}`, {
      role: 'treeitem', tabindex: 0, 'aria-selected': String(selected), draggable: readOnly ? null : 'true',
      style: { paddingLeft: `${8 + depth * 14}px` },
      onclick: () => select({ kind: path.length === 1 ? 'section' : 'field', path }),
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select({ kind: path.length === 1 ? 'section' : 'field', path }); } },
      ondragstart: (e) => { dragging = path; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', JSON.stringify(path)); },
      ondragend: () => { dragging = null; outline.querySelectorAll('.fb-drop').forEach(x => x.classList.remove('fb-drop')); },
      ondragover: (e) => { if (canDrop(dragging, path)) { e.preventDefault(); r.classList.add('fb-drop'); } },
      ondragleave: () => r.classList.remove('fb-drop'),
      ondrop: (e) => { e.preventDefault(); r.classList.remove('fb-drop'); const from = dragging; dragging = null; if (canDrop(from, path)) drop(from, path); },
    }, content);
    return r;
  }

  const dot = list => (list.length ? h('span.fb-dot', { title: list.map(p => p.message).join('\n') }) : null);

  function drawOutline() {
    if (parseError || !def) { mount(outline); return; }
    const items = [
      h(`div.fb-row.fb-form${sel.kind === 'form' ? '.selected' : ''}`, { role: 'treeitem', tabindex: 0, onclick: () => select({ kind: 'form', path: [] }) },
        h('span.fb-icon', '⚙'), h('span', 'Form settings'),
        dot(problems.filter(p => p.level === 'error' && !def.sections.some(s => p.path === s.id || p.path.startsWith(`${s.id}.`))))),
    ];
    def.sections.forEach((s, si) => {
      items.push(row([si], [h('span.fb-sec-title', s.title || s.id), s.report === false ? h('span.fb-tag', 'not in report') : null, dot(problemsFor([si]))], { cls: '.fb-section' }));
      s.fields.forEach((f, fi) => {
        items.push(row([si, fi], [h('span.fb-icon', { title: TYPE_INFO[f.type]?.label }, TYPE_INFO[f.type]?.icon || '?'), h('span.fb-label', f.label || f.id), f.show_if ? h('span.fb-tag', { title: 'Shown only sometimes' }, 'if') : null, dot(problemsFor([si, fi]))], { depth: 1 }));
        if (f.type === 'repeat') {
          (f.fields || []).forEach((sub, ki) => items.push(row([si, fi, ki], [h('span.fb-icon', TYPE_INFO[sub.type]?.icon || '?'), h('span.fb-label', sub.label || sub.id), dot(problemsFor([si, fi, ki]))], { depth: 2 })));
          if (!readOnly) items.push(h('button.fb-add.link.small', { type: 'button', style: { paddingLeft: '50px' }, onclick: () => addField([si, fi]) }, `+ Add to ${String(f.item_label || 'group').toLowerCase()}`));
        }
      });
      if (!readOnly) items.push(h('button.fb-add.link.small', { type: 'button', onclick: () => addField([si]) }, '+ Add field'));
    });
    if (!readOnly) items.push(h('button.fb-add.link', { type: 'button', onclick: addSection }, '+ Add section'));
    mount(outline, items);
  }

  // ---- adding, moving, deleting ---------------------------------------------

  function newField(type) {
    const label = type === 'note' ? 'Instructions for the tech' : 'New question';
    const f = { id: uniqueFieldId(def, type === 'note' ? 'note' : label), type, label };
    if (type === 'choice') f.options = [{ value: 'normal', label: 'Normal' }, { value: 'abnormal', label: 'Abnormal' }];
    if (type === 'multi') f.options = [{ value: 'option_1', label: 'Option 1' }, { value: 'option_2', label: 'Option 2' }];
    if (type === 'repeat') {
      f.item_label = 'Item';
      f.fields = [{ id: uniqueFieldId(def, 'Size'), type: 'dims', label: 'Size' }];
    }
    return f;
  }

  async function addField(parentPath) {
    const type = await modal({
      title: 'Add a field',
      body: h('div.fb-type-grid', Object.entries(TYPE_INFO)
        .filter(([t]) => !(parentPath.length === 2 && t === 'repeat'))
        .map(([t, info]) => h('button.fb-type', { type: 'button', dataset: { type: t } },
          h('span.fb-type-icon', info.icon), h('span.fb-type-name', info.label), h('span.fb-type-hint', info.hint)))),
      onOpen: (dlg, close) => dlg.querySelectorAll('.fb-type').forEach(b => b.addEventListener('click', () => close(b.dataset.type))),
    });
    if (!type) return;
    const f = newField(type);
    commit(() => {
      // Insert after the selected field when it's in the same list, else at the end.
      const sameList = sel.kind === 'field' && sel.path.length === parentPath.length + 1 && sel.path.slice(0, -1).every((v, i) => v === parentPath[i]);
      const index = sameList ? sel.path[sel.path.length - 1] + 1 : undefined;
      const at = tools.insert(doc, parentPath, index, f);
      const path = parentPath.concat(at);
      if (f.options) tools.setOptions(doc, path, f.options);
      fresh.add(f.id);
      sel = { kind: 'field', path };
    });
    panel.querySelector('.fb-question')?.select();
  }

  async function addSection() {
    const title = await promptDialog('Add a section', 'Section title (e.g. Left kidney)', { confirmLabel: 'Add section' });
    if (!title) return;
    commit(() => {
      const index = sel.path.length ? sel.path[0] + 1 : undefined;
      const at = tools.insert(doc, [], index, { id: uniqueSectionId(def, title), title, fields: [] });
      sel = { kind: 'section', path: [at] };
    });
  }

  function moveBy(path, delta) {
    const list = path.length === 1 ? def.sections : path.length === 2 ? def.sections[path[0]].fields : def.sections[path[0]].fields[path[1]].fields;
    const i = path[path.length - 1];
    const j = i + delta;
    if (j < 0 || j >= list.length) return;
    commit(() => {
      const moved = tools.move(doc, path, path.slice(0, -1), delta > 0 ? j + 1 : j);
      sel = { kind: sel.kind, path: moved };
    });
  }

  async function deleteField(path) {
    const f = itemAt(path);
    const refs = findReferences(def, f.id);
    const ok = await confirmDialog(`Delete "${f.label || f.id}"?`,
      refs.length
        ? h('div', h('p', 'Other parts of the form use this field, and will show problems until you change them:'), h('ul', refs.map(r => h('li', r.where))))
        : 'You can undo this.',
      { confirmLabel: 'Delete field', danger: true });
    if (!ok) return;
    commit(() => {
      tools.remove(doc, path);
      sel = path.length === 3 ? { kind: 'field', path: path.slice(0, 2) } : { kind: 'section', path: [path[0]] };
    });
  }

  async function deleteSection(path) {
    const s = itemAt(path);
    const ids = new Set(s.fields.flatMap(f => [f.id, ...(f.fields || []).map(x => x.id)]));
    const outside = [...ids].flatMap(id => findReferences(def, id)).filter(r => r.path[0] !== path[0]);
    const ok = await confirmDialog(`Delete the "${s.title}" section?`,
      h('div', h('p', `This removes it and its ${s.fields.length} field(s).`), outside.length ? h('div', h('p', 'Other sections use its fields:'), h('ul', outside.map(r => h('li', r.where)))) : h('p', 'You can undo this.')),
      { confirmLabel: 'Delete section', danger: true });
    if (!ok) return;
    commit(() => {
      tools.remove(doc, path);
      sel = def.sections.length > 1 ? { kind: 'section', path: [Math.max(0, path[0] - 1)] } : { kind: 'form', path: [] };
    });
  }

  function duplicateField(path) {
    const raw = tools.node(doc, path).toJSON();
    const copy = { ...raw, label: `${raw.label || raw.id} (copy)`, id: uniqueFieldId(def, `${raw.label || raw.id} copy`) };
    commit(() => {
      const at = tools.insert(doc, path.slice(0, -1), path[path.length - 1] + 1, copy);
      const p = path.slice(0, -1).concat(at);
      if (copy.options) tools.setOptions(doc, p, copy.options.map(normalizeOption));
      sel = { kind: 'field', path: p };
    });
  }

  function renameField(path, newId) {
    const f = itemAt(path);
    const oldId = f.id;
    if (newId === oldId) return true;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(newId)) { toast('Use letters, numbers and underscores, starting with a letter.', 'error'); return false; }
    if (uniqueFieldId(def, newId, { exclude: oldId }) !== newId) { toast(`"${newId}" is already used or reserved.`, 'error'); return false; }
    commit(() => {
      tools.setProp(doc, path, 'id', newId);
      tools.rewriteStrings(doc, ['show_if', 'required', 'formula'], v => renameInExpression(v, oldId, newId));
      tools.rewriteStrings(doc, ['report', 'header', 'footer'], v => renameInTemplate(v, oldId, newId));
    }, { redraw: false });
    if (fresh.delete(oldId)) fresh.add(newId);
    return true;
  }

  // ---- panel building blocks ------------------------------------------------

  const field = (label, control, hint) => h('label.fb-field', h('span.fb-field-label', label), control, hint ? h('span.hint', hint) : null);

  function textInput(path, key, { multiline = false, placeholder = '', cls = '', type = 'text', onAfter } = {}) {
    const current = itemAt(path)?.[key];
    const save = debounce((v) => commit(() => tools.setProp(doc, path, key, v), { redraw: false }), 250);
    return h(multiline ? `textarea.input${cls}` : `input.input${cls}`, {
      value: current ?? '', type, placeholder, disabled: readOnly, rows: multiline ? 3 : undefined,
      oninput: (e) => {
        const raw = e.target.value;
        const v = type === 'number' ? (raw === '' ? '' : Number(raw)) : raw;
        save(v);
        if (onAfter) onAfter(v);
      },
    });
  }

  function checkbox(label, checked, onToggle) {
    return h('label.check.fb-check', h('input', { type: 'checkbox', checked, disabled: readOnly, onchange: e => onToggle(e.target.checked) }), ` ${label}`);
  }

  function actions(buttons) {
    return readOnly ? null : h('div.fb-actions', buttons);
  }

  // ---- form panel -----------------------------------------------------------

  function formPanel() {
    const report = def.report || {};
    return [
      h('h3.fb-heading', 'Form settings'),
      field('Title', textInput([], 'title')),
      field('Description', textInput([], 'description'), 'Shown to technologists when they choose a form.'),
      field('Study descriptions that pick this form', h('textarea.input', {
        rows: 4, disabled: readOnly, value: (def.study_match || []).join('\n'), placeholder: 'US PELVIS\nTRANSVAGINAL',
        oninput: debounce((e) => commit(() => tools.setProp(doc, [], 'study_match', e.target.value.split('\n').map(x => x.trim()).filter(Boolean)), { redraw: false }), 300),
      }), 'One per line. All the words on a line must appear in the PACS study description, in any order.'),
      h('details.fb-advanced',
        h('summary', 'Advanced'),
        h('p.small.muted', `Form id: ${def.id} (fixed)`),
        field('Text before all sections', h('textarea.input.mono', { rows: 2, disabled: readOnly, value: report.header || '', oninput: debounce(e => commit(() => setReportKey('header', e.target.value), { redraw: false }), 300) })),
        field('Text after all sections', h('textarea.input.mono', { rows: 2, disabled: readOnly, value: report.footer || '', oninput: debounce(e => commit(() => setReportKey('footer', e.target.value), { redraw: false }), 300) }))),
    ];
  }

  function setReportKey(key, value) {
    const current = { ...(tools.getProp(doc, [], 'report') || {}) };
    if (value) current[key] = value; else delete current[key];
    tools.setProp(doc, [], 'report', Object.keys(current).length ? current : undefined);
  }

  // ---- section panel ----------------------------------------------------------

  function sectionPanel(path) {
    const s = itemAt(path);
    const si = path[0];
    const inReport = s.report !== false;
    const parts = [
      h('h3.fb-heading', 'Section'),
      field('Title', textInput(path, 'title')),
      field('Help for the tech', textInput(path, 'help'), 'Optional, shown under the section title.'),
      h('div.fb-field', h('span.fb-field-label', 'Show this section only when'),
        conditionEditor({ value: s.show_if, fields: conditionFields(path), readOnly, emptyText: 'Always shown', onChange: v => commit(() => tools.setProp(doc, path, 'show_if', v), { redraw: false }) }).el),
      checkbox('Include this section in the report', inReport, (on) => {
        commit(() => {
          if (on) tools.setProp(doc, path, 'report', savedReports.get(s.id) ?? defaultSectionTemplate(s));
          else {
            if (typeof s.report === 'string') savedReports.set(s.id, s.report);
            tools.setProp(doc, path, 'report', false);
          }
        });
      }),
    ];
    if (inReport) parts.push(reportEditor(path, s, si));
    parts.push(actions([
      h('button.btn.small', { type: 'button', onclick: () => moveBy(path, -1), disabled: si === 0 }, '↑ Move up'),
      h('button.btn.small', { type: 'button', onclick: () => moveBy(path, 1), disabled: si === def.sections.length - 1 }, '↓ Move down'),
      h('button.btn.small.ghost', { type: 'button', onclick: () => deleteSection(path) }, 'Delete section'),
    ]));
    return parts;
  }

  function reportEditor(path, s, si) {
    const save = debounce(v => commit(() => tools.setProp(doc, path, 'report', v), { redraw: false }), 250);
    let editor;
    const editCondition = async (token, chipEl) => {
      if (token.type !== 'if' && token.type !== 'elseif') return;
      const expr = await conditionDialog(token.expr, conditionFields([si]));
      if (expr === null || expr === undefined) return;
      editor.replaceChip(chipEl, token.type === 'if' ? `{{#if ${expr}}}` : `{{else if ${expr}}}`);
    };
    editor = templateEditor({
      value: typeof s.report === 'string' ? s.report : '', lookup: lookupField, readOnly,
      placeholder: 'Type the report text. Use the buttons above to insert answers.',
      onChange: (v) => save(v), onChipClick: editCondition,
    });
    const others = def.sections.flatMap((x, i) => (i === si ? [] : x.fields.filter(f => f.type !== 'note').map(f => ({ f, s: x }))));
    const toolbar = readOnly ? null : h('div.fb-chip-bar',
      h('span.small.muted', 'Insert:'),
      s.fields.filter(f => f.type !== 'note').map(f => (f.type === 'repeat'
        ? h('button.fb-insert.loop', { type: 'button', onclick: () => editor.insertTemplate(`{{#each ${f.id}}}\n${(f.fields || []).map(x => fieldTag(x.id)).join(' ')}\n{{/each}}`) }, `For each ${String(f.item_label || 'item').toLowerCase()}`)
        : h('button.fb-insert', { type: 'button', title: TYPE_INFO[f.type]?.label, onclick: () => editor.insertTemplate(fieldTag(f.id)) }, f.label || f.id))),
      others.length ? h('select.input.tiny-select', {
        'aria-label': 'Insert an answer from another section',
        onchange: (e) => { if (e.target.value) editor.insertTemplate(fieldTag(e.target.value)); e.target.value = ''; },
      }, h('option', { value: '' }, 'Other sections…'), others.map(({ f, s: x }) => h('option', { value: f.id }, `${x.title} › ${f.label || f.id}`))) : null,
      h('button.fb-insert.logic', {
        type: 'button',
        onclick: async () => {
          const expr = await conditionDialog('', conditionFields([si]));
          if (expr) editor.insertTemplate(`{{#if ${expr}}}…{{else}}…{{/if}}`);
        },
      }, 'If… otherwise…'),
      h('button.btn.small.ghost', {
        type: 'button',
        onclick: async () => {
          if (editor.getValue().trim() && !(await confirmDialog('Replace the report text?', 'This writes a simple first draft from the section\'s fields, replacing what is there now. You can undo it.', { confirmLabel: 'Replace' }))) return;
          const draft = defaultSectionTemplate(s);
          editor.setValue(draft);
          save(draft);
        },
      }, 'Start from the fields'));
    previewLine = h('div.fb-preview-line', { 'aria-live': 'polite' });
    refreshPreviewLine();
    return h('div.fb-field.fb-report',
      h('span.fb-field-label', 'Report text for this section'),
      typeof s.report !== 'string' ? h('p.hint', 'No report text yet, so a plain "Question: answer" line is used. Write your own below, or press "Start from the fields".') : null,
      toolbar, editor.el,
      h('div.fb-preview-wrap', h('span.small.muted', 'With the sample answers on the right:'), previewLine),
      h('p.hint', 'Tip: click an "If…" chip to change its condition. Text between the chips appears only in that case.'));
  }

  function refreshPreviewLine() {
    if (!previewLine || !previewLine.isConnected || sel.kind !== 'section') return;
    const text = sectionPreview(sel.path[0]);
    previewLine.textContent = text || '(nothing: this section produces no text with the current sample answers)';
    previewLine.classList.toggle('muted', !text);
  }

  async function conditionDialog(initial, fields) {
    let value = initial || '';
    const editor = conditionEditor({ value, fields, onChange: (v) => { value = v; }, emptyText: 'Add a rule to say when the first text appears.' });
    return modal({
      title: 'When should this text appear?',
      body: [editor.el, h('p.hint', 'The text before "Otherwise" is used when the rule matches; the text after it is used when it does not.')],
      actions: [{ label: 'Cancel', value: null }, { label: 'OK', primary: true, onClick: (close) => { close(value.trim() || null); return false; } }],
    });
  }

  // ---- field panel ------------------------------------------------------------

  function changeType(path, type) {
    const f = itemAt(path);
    const loses = Object.keys(TYPE_KEYS).filter(k => f[k] !== undefined && !TYPE_KEYS[k].includes(type) && !(k === 'options' && f.other));
    const apply = () => commit(() => {
      tools.setProp(doc, path, 'type', type);
      for (const k of Object.keys(TYPE_KEYS)) if (!TYPE_KEYS[k].includes(type)) tools.setProp(doc, path, k, undefined);
      if (['default', 'normal'].some(k => f[k] !== undefined) && !(['choice', 'multi'].includes(f.type) && ['choice', 'multi'].includes(type))) {
        tools.setProp(doc, path, 'default', undefined);
        tools.setProp(doc, path, 'normal', undefined);
      }
      if (type === 'multi' && f.normal !== undefined && !Array.isArray(f.normal)) tools.setProp(doc, path, 'normal', [f.normal]);
      if (type === 'choice' && Array.isArray(f.normal)) tools.setProp(doc, path, 'normal', f.normal[0]);
      if (['choice', 'multi'].includes(type) && !f.options) tools.setOptions(doc, path, newField(type).options);
      if (type === 'repeat' && !f.fields) {
        tools.setProp(doc, path, 'item_label', 'Item');
        tools.setProp(doc, path, 'fields', newField('repeat').fields);
      }
    });
    if (!loses.length) return apply();
    confirmDialog('Change the answer type?', `This removes settings that don't apply to "${TYPE_INFO[type].label}" (${loses.join(', ')}). You can undo it.`, { confirmLabel: 'Change type' })
      .then(ok => (ok ? apply() : drawPanel()));
  }

  function choicesEditor(path, f) {
    const rawOpts = tools.getProp(doc, path, 'options') || [];
    // Raw options from the YAML (an "Other" choice is added later, from `other: true`).
    const opts = rawOpts.map(normalizeOption);
    const autoValue = new WeakSet();
    let scoring = opts.some(o => o.points !== undefined);
    const multi = f.type === 'multi';
    const normals = new Set((Array.isArray(f.normal) ? f.normal : f.normal !== undefined ? [f.normal] : []).map(String));
    const save = debounce(redraw => commit(() => tools.setOptions(doc, path, opts), { redraw }), 250);
    const uniqueValue = (label, self) => {
      const base = slugify(label) || 'option';
      const taken = new Set(opts.filter(o => o !== self).map(o => o.value));
      if (!taken.has(base)) return base;
      for (let n = 2; ; n++) if (!taken.has(`${base}_${n}`)) return `${base}_${n}`;
    };
    const setNormal = () => commit(() => tools.setProp(doc, path, 'normal', multi ? [...normals] : [...normals][0]), { redraw: false });

    const body = h('div.fb-choices');
    const draw = () => mount(body,
      h('div.fb-choice-row.head', h('span'), h('span', 'Button'), h('span', 'Report text'), scoring ? h('span', 'Points') : null, h('span', { title: 'Value set by the section\'s Normal button' }, 'Normal'), h('span')),
      opts.map((o, i) => h('div.fb-choice-row',
        readOnly ? h('span') : h('span.fb-reorder',
          h('button.icon-btn.small', { type: 'button', 'aria-label': 'Move up', disabled: i === 0, onclick: () => { [opts[i - 1], opts[i]] = [opts[i], opts[i - 1]]; save(false); draw(); } }, '↑'),
          h('button.icon-btn.small', { type: 'button', 'aria-label': 'Move down', disabled: i === opts.length - 1, onclick: () => { [opts[i + 1], opts[i]] = [opts[i], opts[i + 1]]; save(false); draw(); } }, '↓')),
        h('input.input', { value: o.label, disabled: readOnly, 'aria-label': 'Button text', oninput: (e) => {
          o.label = e.target.value;
          if (autoValue.has(o)) {
            const before = o.value;
            o.value = uniqueValue(o.label, o);
            if (normals.delete(before)) { normals.add(o.value); setNormal(); }
          }
          save(false);
        } }),
        h('input.input', { value: o.text ?? '', placeholder: o.label, disabled: readOnly, 'aria-label': 'Report text', oninput: (e) => { o.text = e.target.value || undefined; save(false); } }),
        scoring ? h('input.input.tiny-num', { type: 'number', value: o.points ?? '', disabled: readOnly, 'aria-label': 'Points', oninput: (e) => { o.points = e.target.value === '' ? undefined : Number(e.target.value); save(false); } }) : null,
        h('input', {
          type: multi ? 'checkbox' : 'radio', name: `normal-${f.id}`, checked: normals.has(o.value), disabled: readOnly, 'aria-label': 'Normal',
          onclick: (e) => {
            if (multi) { if (e.target.checked) normals.add(o.value); else normals.delete(o.value); }
            else if (normals.has(o.value)) { normals.clear(); e.target.checked = false; }
            else { normals.clear(); normals.add(o.value); }
            setNormal();
          },
        }),
        readOnly ? h('span') : h('button.icon-btn.small', { type: 'button', 'aria-label': 'Delete choice', onclick: () => { opts.splice(i, 1); normals.delete(o.value); save(true); } }, '×'))),
      readOnly ? null : h('button.link.small', {
        type: 'button',
        onclick: () => {
          const o = { label: `Option ${opts.length + 1}` };
          o.value = uniqueValue(o.label, o);
          autoValue.add(o);
          opts.push(o);
          save(false);
          draw();
          body.querySelector('.fb-choice-row:last-of-type input.input')?.select();
        },
      }, '+ Add choice'));
    draw();
    return [
      h('div.fb-field', h('span.fb-field-label', 'Choices'), h('span.hint', 'What the tech taps, and the words that go into the report (leave blank to use the button text).'), body),
      h('div.fb-inline',
        checkbox('Allow "Other" with a description', !!f.other, on => commit(() => tools.setProp(doc, path, 'other', on || undefined))),
        checkbox('Choices score points', scoring, (on) => { scoring = on; if (!on) opts.forEach(o => { delete o.points; }); save(true); })),
      f.type === 'choice' ? h('div.fb-inline',
        field('Show as', h('select.input', { disabled: readOnly, onchange: e => commit(() => tools.setProp(doc, path, 'layout', e.target.value || undefined), { redraw: false }) },
          h('option', { value: '', selected: f.layout !== 'dropdown' }, 'Buttons'), h('option', { value: 'dropdown', selected: f.layout === 'dropdown' }, 'Drop-down list'))),
        field('Answer filled in at the start', h('select.input', { disabled: readOnly, onchange: e => commit(() => tools.setProp(doc, path, 'default', e.target.value || undefined), { redraw: false }) },
          h('option', { value: '' }, 'None'), opts.map(o => h('option', { value: o.value, selected: String(f.default) === o.value }, o.label))))) : null,
    ];
  }

  function calcEditor(path, f) {
    const match = matchRecipe(f.formula);
    const candidates = types => conditionFields(path).filter(x => types.includes(x.type));
    const box = h('div');
    let recipe = match ? (match.recipe?.id ?? null) : (f.formula ? 'custom' : null);
    let values = match ? [...match.values] : [];
    const save = () => {
      if (!recipe || recipe === 'custom') return;
      const r = RECIPES.find(x => x.id === recipe);
      const vals = r.params.map((p, i) => values[i] ?? (p.kind === 'number' ? p.initial : p.kind === 'fields' ? [] : candidates(p.types)[0]?.id));
      if (vals.some(v => v === undefined || (Array.isArray(v) && !v.length))) return;
      commit(() => tools.setProp(doc, path, 'formula', r.build(vals)), { redraw: false });
    };
    const draw = () => {
      const r = RECIPES.find(x => x.id === recipe);
      mount(box,
        field('What to calculate', h('select.input', {
          disabled: readOnly,
          onchange: (e) => { recipe = e.target.value; values = []; draw(); save(); },
        }, !recipe ? h('option', { value: '' }, 'Choose…') : null,
        RECIPES.map(x => h('option', { value: x.id, selected: recipe === x.id }, x.label)),
        h('option', { value: 'custom', selected: recipe === 'custom' }, 'Custom formula (see the form writing guide)'))),
        r ? r.params.map((p, i) => {
          if (p.kind === 'number') {
            if (values[i] === undefined) values[i] = p.initial;
            return field(p.label, h('input.input.tiny-num', { type: 'number', step: 'any', value: values[i], disabled: readOnly, oninput: (e) => { values[i] = Number(e.target.value); save(); } }));
          }
          const list = candidates(p.types);
          if (!list.length) return h('p.alert.warn.small', `Add a "${p.types.map(t => TYPE_INFO[t].label).join('" or "')}" field first.`);
          if (p.kind === 'fields') {
            const chosen = new Set(values[i] || []);
            return field(p.label, h('div.cond-multi', list.map(x => h('label.check.small', h('input', {
              type: 'checkbox', checked: chosen.has(x.id), disabled: readOnly,
              onchange: (e) => { if (e.target.checked) chosen.add(x.id); else chosen.delete(x.id); values[i] = list.map(y => y.id).filter(id => chosen.has(id)); save(); },
            }), ` ${x.label}`))));
          }
          if (values[i] === undefined) values[i] = list[0].id;
          return field(p.label, h('select.input', { disabled: readOnly, onchange: (e) => { values[i] = e.target.value; save(); } },
            list.map(x => h('option', { value: x.id, selected: x.id === values[i] }, x.label))));
        }) : null,
        recipe === 'custom' ? field('Formula', textInput(path, 'formula', { cls: '.mono' }), 'For example: round(ellipsoid(r_ovary), 1)') : null);
    };
    draw();
    if (recipe && recipe !== 'custom' && !f.formula) save();
    return box;
  }

  function typeSettings(path, f) {
    switch (f.type) {
      case 'choice': case 'multi': return choicesEditor(path, f);
      case 'number': return [
        h('div.fb-inline', field('Unit', textInput(path, 'unit', { placeholder: 'mm' })), field('Decimal places', textInput(path, 'decimals', { type: 'number' }))),
        h('div.fb-inline', field('Expected from', textInput(path, 'min', { type: 'number' })), field('to', textInput(path, 'max', { type: 'number' }))),
        h('p.hint', 'Values outside the expected range ask the tech to double-check, but are allowed.'),
      ];
      case 'dims': return [
        field('Dimensions', h('input.input', {
          value: (f.axes || ['L', 'AP', 'W']).join(', '), disabled: readOnly,
          oninput: debounce((e) => {
            const axes = e.target.value.split(',').map(x => x.trim()).filter(Boolean);
            const isDefault = axes.join() === 'L,AP,W';
            commit(() => tools.setProp(doc, path, 'axes', isDefault ? undefined : axes, { flow: true }), { redraw: false });
          }, 300),
        }), 'Labels for each measurement box, separated by commas, e.g. L, AP, W.'),
        h('div.fb-inline', field('Unit', textInput(path, 'unit', { placeholder: 'cm' })), field('Decimal places', textInput(path, 'decimals', { type: 'number' }))),
        h('div.fb-inline', field('Expected from', textInput(path, 'min', { type: 'number' })), field('to', textInput(path, 'max', { type: 'number' }))),
      ];
      case 'calc': return [calcEditor(path, f), h('div.fb-inline', field('Unit', textInput(path, 'unit', { placeholder: 'mL' })), field('Decimal places', textInput(path, 'decimals', { type: 'number' })))];
      case 'boolean': return [
        field('Report text when checked', textInput(path, 'true_text', { placeholder: 'yes' })),
        field('Report text when not checked', textInput(path, 'false_text', { placeholder: 'no' })),
      ];
      case 'text': case 'textarea': return [field('Example shown in the empty box', textInput(path, 'placeholder'))];
      case 'repeat': return [
        h('div.fb-inline', field('Name of one item', textInput(path, 'item_label', { placeholder: 'Nodule' })), field('Most items allowed', textInput(path, 'max_items', { type: 'number' }))),
        h('p.hint', 'Add the questions asked for each item in the outline, under this group.'),
      ];
      default: return [];
    }
  }

  function fieldPanel(path) {
    const f = itemAt(path);
    const s = def.sections[path[0]];
    const parent = path.length === 3 ? s.fields[path[1]] : null;
    const isNote = f.type === 'note';
    const used = findReferences(def, f.id);
    const requiredWhen = typeof f.required === 'string';
    const list = parent ? parent.fields : s.fields;
    const index = path[path.length - 1];

    const question = textInput(path, 'label', {
      multiline: isNote, cls: '.fb-question',
      onAfter: (label) => {
        // New fields' internal names follow their question until they're used elsewhere.
        if (!fresh.has(f.id) || findReferences(def, f.id).length) return;
        const next = uniqueFieldId(def, label, { exclude: f.id });
        if (next !== f.id && renameField(path, next)) {
          f.id = next;
          const box = panel.querySelector('#fb-rename');
          if (box) box.value = next;
        }
      },
    });

    return [
      h('div.small.muted', `${s.title}${parent ? ` › ${parent.label}` : ''}`),
      h('h3.fb-heading', isNote ? 'Instruction note' : 'Question'),
      field(isNote ? 'Text the tech sees' : 'Question', question),
      field('Answer type', h('select.input', { disabled: readOnly, onchange: e => changeType(path, e.target.value) },
        Object.entries(TYPE_INFO).filter(([t]) => !(parent && t === 'repeat')).map(([t, info]) => h('option', { value: t, selected: t === f.type }, info.label)))),
      isNote ? null : h('div.fb-field',
        checkbox(requiredWhen ? 'Required in some cases' : 'Required', !!f.required, on => commit(() => tools.setProp(doc, path, 'required', on || undefined))),
        f.required ? (requiredWhen
          ? h('div', conditionEditor({ value: f.required, fields: conditionFields(path), readOnly, emptyText: 'Required always', onChange: v => commit(() => tools.setProp(doc, path, 'required', v || true), { redraw: false }) }).el,
            readOnly ? null : h('button.link.small', { type: 'button', onclick: () => commit(() => tools.setProp(doc, path, 'required', true)) }, 'Make it always required'))
          : readOnly ? null : h('button.link.small', { type: 'button', onclick: () => commit(() => tools.setProp(doc, path, 'required', conditionFields(path)[0] ? `present(${conditionFields(path)[0].id})` : true)) }, 'Only required in some cases…'))
          : null),
      isNote ? null : field('Help for the tech', textInput(path, 'help'), 'Optional, shown under the question.'),
      typeSettings(path, f),
      h('div.fb-field', h('span.fb-field-label', 'Show only when'),
        conditionEditor({ value: f.show_if, fields: conditionFields(path), readOnly, emptyText: 'Always shown', onChange: v => commit(() => tools.setProp(doc, path, 'show_if', v), { redraw: false }) }).el),
      used.length ? h('p.hint', `Used in: ${used.map(u => u.where).join('; ')}.`) : (isNote || f.type === 'repeat' ? null : h('p.hint', 'Not used in any report text yet. Insert it from the section\'s report text.')),
      h('details.fb-advanced',
        h('summary', 'Advanced'),
        field('Internal name', h('div.fb-inline-input',
          h('input.input.mono', { value: f.id, disabled: readOnly, id: 'fb-rename' }),
          readOnly ? null : h('button.btn.small', { type: 'button', onclick: () => { if (renameField(path, panel.querySelector('#fb-rename').value.trim())) drawPanel(); } }, 'Rename')),
        'Used in report text and rules; renaming updates them all.'),
        ['number', 'text', 'date', 'calc'].includes(f.type) ? checkbox('Narrow box (several fit on one row)', f.width === 'short', on => commit(() => tools.setProp(doc, path, 'width', on ? 'short' : undefined), { redraw: false })) : null),
      actions([
        h('button.btn.small', { type: 'button', onclick: () => moveBy(path, -1), disabled: index === 0 }, '↑ Move up'),
        h('button.btn.small', { type: 'button', onclick: () => moveBy(path, 1), disabled: index === list.length - 1 }, '↓ Move down'),
        h('button.btn.small', { type: 'button', onclick: () => duplicateField(path) }, 'Duplicate'),
        h('button.btn.small.ghost', { type: 'button', onclick: () => deleteField(path) }, 'Delete'),
      ]),
    ];
  }

  function drawPanel() {
    previewLine = null;
    if (parseError) {
      mount(panel, h('div.alert.error', h('strong', 'The form source has an error, so the builder can’t show it. '), parseError, h('p.small', 'Open the Source tab to fix it.')));
      return;
    }
    if (!itemAt(sel.path)) sel = { kind: 'form', path: [] };
    const content = sel.kind === 'form' ? formPanel() : sel.kind === 'section' ? sectionPanel(sel.path) : fieldPanel(sel.path);
    const errs = sel.kind === 'form' ? [] : problemsFor(sel.path);
    mount(panel, errs.length ? h('div.alert.error.small', errs.map(p => h('div', p.message))) : null, content);
    refreshPreviewLine();
  }

  function findPath(id) {
    for (const [si, s] of def.sections.entries()) {
      for (const [fi, f] of s.fields.entries()) {
        if (f.id === id) return [si, fi];
        for (const [ki, sub] of (f.fields || []).entries()) if (sub.id === id) return [si, fi, ki];
      }
    }
    return null;
  }

  load(source);
  drawOutline();
  drawPanel();

  return {
    el,
    // Called when the source changed outside the builder (Source tab, undo).
    refresh(src) {
      if (src === lastSource) return;
      load(src);
      drawOutline();
      drawPanel();
    },
    refreshPreview: refreshPreviewLine,
    selectField(id) {
      const p = def && findPath(id);
      if (!p) return;
      select({ kind: 'field', path: p });
      outline.querySelector('.fb-row.selected')?.scrollIntoView({ block: 'nearest' });
    },
    selectSection(id) {
      const i = def?.sections.findIndex(s => s.id === id);
      if (i >= 0) select({ kind: 'section', path: [i] });
    },
  };
}

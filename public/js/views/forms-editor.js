// SPDX-License-Identifier: GPL-3.0-or-later
//
// Form editor. The left pane edits the form, either in the visual Builder
// or as YAML Source (both edit the same text). The middle pane is a live,
// fillable preview of the tech's form; the right pane shows the findings it
// produces. Changes are undoable and saved automatically as a draft;
// technologists only see them once someone presses Publish.

import { h, mount, toast, modal, confirmDialog, promptDialog, debounce, fmtDateTime, downloadUrl } from '../dom.js';
import { get, post, put, del } from '../api.js';
import { renderForm } from '../components/form-renderer.js';
import { formBuilder } from '../components/form-builder.js';
import { normalizeForm, lintForm, initialAnswers, normalAnswers } from '/shared/formdef.js';
import { generateReport } from '/shared/template.js';
import YAML from '/vendor/yaml/index.js';

const SAMPLE_ENV = { patient: { age: 45, sex: 'F' }, exam: { date: new Date().toISOString().slice(0, 10), study_description: '' }, institution: { name: 'Preview', code: 'PREVIEW' } };

function storedMode() {
  try { return localStorage.getItem('sf.formsMode') === 'source' ? 'source' : 'builder'; } catch { return 'builder'; }
}

export async function render({ root, params, navigate, session }) {
  const id = Number(params[0]);
  let data = await get(`/forms/${id}`);
  const { form } = data;
  const canEdit = form.institution_id !== null || session.can.superuser;

  const editor = h('textarea.code-editor', { spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', wrap: 'off', readOnly: !canEdit, value: data.source, 'aria-label': 'Form source (YAML)' });
  const problemsBox = h('div.problems');
  const formPane = h('div.pane-body');
  const reportPane = h('pre.report-text');
  const reportErrors = h('div');
  const saveState = h('span.save-state');
  const env = { ...SAMPLE_ENV, patient: { ...SAMPLE_ENV.patient } };
  let sample = {};            // preview answers, kept across edits by field id
  let def = null;
  let dirty = false;
  let changeCount = 0;
  let lastProblems = [];
  let mode = storedMode();

  // ---- undo / redo ----------------------------------------------------------
  // Snapshots of the source, taken when typing pauses.
  const history = [data.source];
  let at = 0;
  const snapshot = debounce(() => {
    if (history[at] === editor.value) return;
    history.splice(at + 1);
    history.push(editor.value);
    if (history.length > 200) history.shift();
    at = history.length - 1;
    drawUndo();
  }, 700);

  function travel(delta) {
    snapshot.flush();
    const next = at + delta;
    if (next < 0 || next >= history.length) return;
    at = next;
    applySource(history[at], 'history');
    drawUndo();
  }

  const undoBtn = h('button.btn.small', { type: 'button', title: 'Undo (Ctrl+Z)', onclick: () => travel(-1) }, '↶ Undo');
  const redoBtn = h('button.btn.small', { type: 'button', title: 'Redo (Ctrl+Shift+Z)', onclick: () => travel(1) }, '↷ Redo');
  function drawUndo() {
    undoBtn.disabled = at === 0;
    redoBtn.disabled = at >= history.length - 1;
  }

  // ---- source changes -------------------------------------------------------

  // Every change (builder, Source tab, undo) comes through here.
  function applySource(src, from) {
    if (from !== 'source') editor.value = src;
    if (from !== 'builder') builder.refresh(src);
    if (from !== 'history') {
      snapshot();
      // There's now something to undo, even before the snapshot is taken.
      undoBtn.disabled = false;
      redoBtn.disabled = true;
    }
    changeCount++;
    if (!dirty) { dirty = true; setState('Unsaved changes'); }
    publishBtn.disabled = true;
    (from === 'builder' ? quickRebuild : liveRebuild)();
    if (canEdit) autosave();
  }

  function setState(text, kind = '') {
    saveState.textContent = text;
    saveState.className = `save-state ${kind}`;
  }

  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && !e.shiftKey && !editor.readOnly) {
      e.preventDefault();
      const { selectionStart: s, selectionEnd: t } = editor;
      editor.setRangeText('  ', s, t, 'end');
      editor.dispatchEvent(new Event('input'));
    }
  });
  editor.addEventListener('input', () => applySource(editor.value, 'source'));

  function parse() {
    let raw;
    try {
      raw = YAML.parse(editor.value, { prettyErrors: true });
    } catch (e) {
      const line = e.linePos?.[0]?.line;
      return { problems: [{ level: 'error', path: line ? `line ${line}` : '', message: e.message.split('\n')[0], line }] };
    }
    if (!raw || typeof raw !== 'object') return { problems: [{ level: 'error', path: '', message: 'The form must start with id:, title: and sections:' }] };
    const problems = lintForm(raw);
    let d = null;
    try { d = normalizeForm(raw); } catch (e) { problems.push({ level: 'error', path: '', message: e.message }); }
    return { def: d, problems };
  }

  function drawProblems(problems) {
    lastProblems = problems;
    const errors = problems.filter(p => p.level === 'error');
    mount(problemsBox, problems.length
      ? problems.map(p => h(`div.problem.${p.level}`, {
        onclick: () => { if (p.line && mode === 'source') goToLine(p.line); },
      }, h('span.problem-level', p.level === 'error' ? '✖' : '⚠'), p.path ? h('code', p.path) : null, ' ', p.message))
      : h('div.problem.ok', '✓ No problems found'));
    publishBtn.disabled = !canEdit || errors.length > 0 || (!form.draft_version && !dirty);
  }

  function goToLine(line) {
    const lines = editor.value.split('\n');
    const start = lines.slice(0, line - 1).join('\n').length + (line > 1 ? 1 : 0);
    editor.focus();
    editor.setSelectionRange(start, start + (lines[line - 1] || '').length);
    editor.scrollTop = Math.max(0, (line - 5) * parseFloat(getComputedStyle(editor).lineHeight || 18));
  }

  let formView = null;
  let selected = null;
  function rebuild() {
    const { def: d, problems } = parse();
    drawProblems(problems);
    if (!d) return;
    def = d;
    // Keep preview answers for fields that still exist; add defaults for new ones.
    sample = { ...initialAnswers(def), ...sample };
    try {
      formView = renderForm(def, sample, { env, onChange: updateReport, compact: true });
      mount(formPane, formView.el);
      highlight(selected);
    } catch (e) {
      mount(formPane, h('div.alert.error', `Preview failed: ${e.message}`));
    }
    updateReport();
  }

  function updateReport() {
    if (!def) return;
    try {
      const r = generateReport(def, sample, env);
      reportPane.textContent = r.text || '(the report is empty, fill in the preview form)';
      mount(reportErrors, r.errors.map(e => h('div.alert.error.small', e)));
    } catch (e) {
      mount(reportErrors, h('div.alert.error.small', e.message));
    }
    builder.refreshPreview();
  }

  const liveRebuild = debounce(rebuild, 400);
  const quickRebuild = debounce(rebuild, 120);

  // The text one section produces with the current sample answers.
  function sectionPreview(index) {
    if (!def?.sections[index]) return '';
    try {
      const r = generateReport(def, sample, env);
      return r.sections.find(s => s.id === def.sections[index].id)?.text || '';
    } catch (e) {
      return `(error: ${e.message})`;
    }
  }

  // ---- saving ---------------------------------------------------------------

  async function saveDraft({ quiet = false } = {}) {
    if (!canEdit) return false;
    const savingCount = changeCount;
    if (!quiet) setState('Saving…');
    try {
      const r = await put(`/forms/${id}/draft`, { source: editor.value });
      dirty = changeCount !== savingCount;
      if (!dirty) setState(`Draft saved ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, 'ok');
      data = await get(`/forms/${id}`);
      Object.assign(form, data.form);
      drawHeader();
      drawProblems(r.problems || lastProblems);
      return true;
    } catch (e) {
      // A form that doesn't parse can't be saved; the problems list explains why.
      if (e.body?.problems) drawProblems(e.body.problems);
      setState(quiet ? 'Not saved: fix the problems listed' : 'Not saved', 'error');
      if (!quiet) toast(e.message, 'error', 8000);
      return false;
    }
  }
  const autosave = debounce(() => saveDraft({ quiet: true }), 2000);

  async function publish() {
    autosave.cancel();
    if (dirty && !(await saveDraft())) return;
    const notes = await promptDialog('Publish this version', 'What changed? (shown in the version history)', { required: false, confirmLabel: 'Publish' });
    if (notes === null) return;
    try {
      const r = await post(`/forms/${id}/publish`, { notes });
      toast(`Published version ${r.version}. Technologists will get it on new forms.`, 'success', 5000);
      data = await get(`/forms/${id}`);
      Object.assign(form, data.form);
      drawHeader();
      drawProblems(lastProblems);
    } catch (e) {
      toast(e.message, 'error', 8000);
      if (e.body?.problems) drawProblems(e.body.problems);
    }
  }

  async function discard() {
    const neverPublished = !form.current_version_id;
    const ok = await confirmDialog(neverPublished ? 'Delete this form?' : 'Discard the draft?',
      neverPublished ? 'This form was never published, so discarding the draft deletes it.' : 'The editor will go back to the published version.',
      { confirmLabel: neverPublished ? 'Delete form' : 'Discard draft', danger: true });
    if (!ok) return;
    autosave.cancel();
    try {
      const r = await del(`/forms/${id}/draft`);
      dirty = false;
      if (r.deletedForm) return navigate('/forms');
      navigate(`/forms/${id}`);
    } catch (e) { toast(e.message, 'error'); }
  }

  async function showHistory() {
    const rows = form.versions.map(v => h('tr',
      h('td', `v${v.version}`), h('td', h(`span.badge${v.status === 'published' ? '.status-submitted' : v.status === 'draft' ? '.accent' : ''}`, v.status)),
      h('td.small', fmtDateTime(v.published_at || v.created_at)), h('td.small', v.published_by_name || v.created_by_name || ''),
      h('td.small', v.notes || ''),
      h('td.right.nowrap',
        h('button.btn.small', { type: 'button', onclick: async () => {
          const full = await get(`/forms/${id}/versions/${v.id}`);
          modal({ title: `${form.title}: version ${v.version}`, wide: true, body: h('pre.code-view', full.source), actions: [
            canEdit ? { label: 'Load into editor', onClick: () => { applySource(full.source, 'load'); toast('Loaded into the draft. Publish to make it live again.', 'info', 5000); } } : null,
            { label: 'Close', primary: true },
          ].filter(Boolean) });
        } }, 'View'),
        h('button.btn.small', { type: 'button', onclick: () => downloadUrl(`/api/forms/${id}/export?version=${v.id}`) }, 'Download'))));
    modal({ title: 'Version history', wide: true, body: h('div.table-wrap', h('table.table', h('thead', h('tr', h('th', 'Version'), h('th', 'Status'), h('th', 'Date'), h('th', 'By'), h('th', 'Notes'), h('th', ''))), h('tbody', rows))) });
  }

  async function toggleActive() {
    try {
      await put(`/forms/${id}/active`, { active: !form.active });
      form.active = !form.active;
      drawHeader();
      toast(form.active ? 'Form is active' : 'Form deactivated: techs can no longer choose it', 'success');
    } catch (e) { toast(e.message, 'error'); }
  }

  async function copyToInstitution() {
    const insts = session.institutions;
    const sel = h('select.input', insts.map(i => h('option', { value: i.id, selected: i.id === session.institution_id }, i.name)));
    const ok = await modal({ title: 'Copy to institution', body: [h('label.label', 'Institution'), sel], actions: [{ label: 'Cancel', value: false }, { label: 'Copy', primary: true, value: true }] });
    if (!ok) return;
    try {
      const r = await post(`/forms/${id}/copy`, { institution_id: Number(sel.value) });
      navigate(`/forms/${r.id}`);
    } catch (e) { toast(e.message, 'error', 8000); }
  }

  function fillNormals() {
    if (!def) return;
    for (const s of def.sections) Object.assign(sample, normalAnswers(s));
    formView?.syncAll();
    updateReport();
  }
  function clearSample() {
    for (const k of Object.keys(sample)) delete sample[k];
    Object.assign(sample, initialAnswers(def || { sections: [] }));
    formView?.syncAll();
    updateReport();
  }

  // ---- builder <-> preview ----------------------------------------------------

  function highlight(sel) {
    selected = sel;
    formPane.querySelectorAll('.builder-selected').forEach(x => x.classList.remove('builder-selected'));
    if (!sel || mode !== 'builder') return;
    const target = sel.kind === 'field' ? formPane.querySelector(`[data-field="${CSS.escape(sel.id || '')}"]`)
      : sel.kind === 'section' ? formPane.querySelector(`[data-section="${CSS.escape(sel.sectionId || '')}"]`) : null;
    if (target) {
      target.classList.add('builder-selected');
      target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  const builder = formBuilder({
    source: data.source,
    readOnly: !canEdit,
    onChange: src => applySource(src, 'builder'),
    onSelect: highlight,
    sectionPreview,
  });

  // Clicking something in the preview selects it in the builder.
  formPane.addEventListener('click', (e) => {
    if (mode !== 'builder') return;
    const f = e.target.closest('[data-field]');
    if (f) return builder.selectField(f.dataset.field);
    const s = e.target.closest('[data-section]');
    if (s) builder.selectSection(s.dataset.section);
  });

  // ---- layout -----------------------------------------------------------------

  const publishBtn = h('button.btn.primary', { type: 'button', onclick: publish }, 'Publish');
  const header = h('div.editor-head');
  function drawHeader() {
    const scope = form.institution_id === null ? 'General library' : form.institution_name;
    mount(header,
      h('div',
        h('a.back', { href: '#/forms' }, '← Forms'),
        h('h1', form.title, !form.active ? h('span.badge', 'Inactive') : null),
        h('div.muted.small', `${scope} · ${form.current_version ? `published v${form.current_version}` : 'not yet published'}${form.draft_version ? ` · editing draft v${form.draft_version}` : ''}`)),
      h('div.page-actions',
        saveState,
        h('button.btn', { type: 'button', onclick: showHistory }, 'History'),
        h('button.btn', { type: 'button', onclick: () => downloadUrl(`/api/forms/${id}/export`), disabled: !form.current_version_id }, 'Export'),
        !canEdit ? h('button.btn.primary', { type: 'button', onclick: copyToInstitution }, 'Copy to my institution') : null,
        canEdit && form.current_version_id ? h('button.btn.ghost', { type: 'button', onclick: toggleActive }, form.active ? 'Deactivate' : 'Activate') : null,
        canEdit && (form.draft_version || !form.current_version_id) ? h('button.btn.ghost', { type: 'button', onclick: discard }, form.current_version_id ? 'Discard draft' : 'Delete') : null,
        canEdit ? publishBtn : null));
  }

  const editPane = h('div.edit-pane-body');
  const modeTabs = h('div.seg');
  const panes = h('div.editor-panes');
  function setMode(next) {
    mode = next;
    try { localStorage.setItem('sf.formsMode', mode); } catch { /* ignore */ }
    mount(modeTabs, ['builder', 'source'].map(m => h(`button.seg-btn${m === mode ? '.on' : ''}`, { type: 'button', onclick: () => setMode(m) }, m === 'builder' ? 'Builder' : 'Source')));
    if (mode === 'builder') builder.refresh(editor.value);
    mount(editPane, mode === 'builder' ? builder.el : editor, problemsBox);
    panes.classList.toggle('builder-mode', mode === 'builder');
    highlight(mode === 'builder' ? selected : null);
  }

  // Narrow screens show one pane at a time.
  const tabs = h('div.seg.pane-tabs', ['source', 'form', 'report'].map(p => h(`button.seg-btn${p === 'source' ? '.on' : ''}`, {
    type: 'button', onclick: (e) => { panes.dataset.show = p; tabs.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('on', b === e.currentTarget)); },
  }, { source: 'Edit', form: 'Tech form', report: 'Report' }[p])));
  panes.dataset.show = 'source';

  mount(panes,
    h('section.pane.pane-source',
      h('div.pane-head', modeTabs, h('div.pane-tools', canEdit ? [undoBtn, redoBtn] : null, h('a.small', { href: '/help.html?doc=FORMS', target: '_blank', rel: 'noopener' }, 'Help'))),
      !canEdit ? h('div.alert.info.small', 'General-library forms can only be edited by a superuser. Copy it to your institution to customize it.') : null,
      editPane),
    h('section.pane.pane-form',
      h('div.pane-head', h('h3', 'What the tech fills in'),
        h('div', h('button.btn.small', { type: 'button', onclick: fillNormals }, 'Fill normals'), h('button.btn.small.ghost', { type: 'button', onclick: clearSample }, 'Clear'))),
      h('div.preview-env',
        h('label.small', 'Preview patient: age ', h('input.input.tiny', { type: 'number', value: env.patient.age, oninput: (e) => { env.patient.age = Number(e.target.value) || null; formView?.refresh(); updateReport(); } })),
        h('label.small', ' sex ', h('select.input.tiny', { onchange: (e) => { env.patient.sex = e.target.value; formView?.refresh(); updateReport(); } }, ['F', 'M', 'O'].map(s => h('option', { value: s }, s))))),
      formPane),
    h('section.pane.pane-report',
      h('div.pane-head', h('h3', 'Findings for the radiologist')),
      reportErrors, reportPane));

  drawHeader();
  drawUndo();
  setMode(mode);
  if (canEdit) setState(form.draft_version ? 'Editing the draft; changes save automatically' : 'Changes save automatically as a draft');
  mount(root, h('div.editor-page', header, tabs, panes));
  rebuild();

  const onKey = (e) => {
    const inField = e.target.closest?.('input, textarea, select, [contenteditable="true"]');
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); autosave.cancel(); saveDraft(); return; }
    if (inField || !canEdit || !(e.ctrlKey || e.metaKey)) return;
    if (e.key.toLowerCase() === 'z') { e.preventDefault(); travel(e.shiftKey ? 1 : -1); }
    if (e.key.toLowerCase() === 'y') { e.preventDefault(); travel(1); }
  };
  window.addEventListener('keydown', onKey);
  const beforeUnload = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', beforeUnload);
  return () => {
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('beforeunload', beforeUnload);
    // Leaving the editor saves any pending changes rather than dropping them.
    if (dirty && canEdit) { autosave.cancel(); saveDraft({ quiet: true }); }
  };
}

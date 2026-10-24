// SPDX-License-Identifier: GPL-3.0-or-later
//
// Form editor: YAML source on the left, a live, fillable preview of the
// tech's form in the middle, and the generated findings on the right.

import { h, mount, toast, modal, confirmDialog, promptDialog, debounce, fmtDateTime, downloadUrl } from '../dom.js';
import { get, post, put, del } from '../api.js';
import { renderForm } from '../components/form-renderer.js';
import { normalizeForm, lintForm, initialAnswers, normalAnswers } from '/shared/formdef.js';
import { generateReport } from '/shared/template.js';
import YAML from '/vendor/yaml/index.js';

const SAMPLE_ENV = { patient: { age: 45, sex: 'F' }, exam: { date: new Date().toISOString().slice(0, 10), study_description: '' }, institution: { name: 'Preview', code: 'PREVIEW' } };

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
  let lastProblems = [];

  // Tab key inserts two spaces instead of leaving the editor.
  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && !e.shiftKey && !editor.readOnly) {
      e.preventDefault();
      const { selectionStart: s, selectionEnd: t } = editor;
      editor.setRangeText('  ', s, t, 'end');
      editor.dispatchEvent(new Event('input'));
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveDraft(); }
  });

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
        onclick: () => { if (p.line) goToLine(p.line); },
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
  }

  const liveRebuild = debounce(rebuild, 400);
  editor.addEventListener('input', () => {
    if (!dirty) { dirty = true; saveState.textContent = 'Unsaved changes'; saveState.className = 'save-state'; }
    liveRebuild();
  });

  async function saveDraft() {
    if (!canEdit) return false;
    try {
      const r = await put(`/forms/${id}/draft`, { source: editor.value });
      dirty = false;
      saveState.textContent = `Draft saved ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      saveState.className = 'save-state ok';
      data = await get(`/forms/${id}`);
      Object.assign(form, data.form);
      drawHeader();
      drawProblems(r.problems || lastProblems);
      return true;
    } catch (e) {
      toast(e.message, 'error', 8000);
      if (e.body?.problems) drawProblems(e.body.problems);
      return false;
    }
  }

  async function publish() {
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
    try {
      const r = await del(`/forms/${id}/draft`);
      dirty = false;
      if (r.deletedForm) return navigate('/forms');
      navigate(`/forms/${id}`);
    } catch (e) { toast(e.message, 'error'); }
  }

  async function history() {
    const rows = form.versions.map(v => h('tr',
      h('td', `v${v.version}`), h('td', h(`span.badge${v.status === 'published' ? '.status-submitted' : v.status === 'draft' ? '.accent' : ''}`, v.status)),
      h('td.small', fmtDateTime(v.published_at || v.created_at)), h('td.small', v.published_by_name || v.created_by_name || ''),
      h('td.small', v.notes || ''),
      h('td.right.nowrap',
        h('button.btn.small', { type: 'button', onclick: async () => {
          const full = await get(`/forms/${id}/versions/${v.id}`);
          modal({ title: `${form.title}: version ${v.version}`, wide: true, body: h('pre.code-view', full.source), actions: [
            canEdit ? { label: 'Load into editor', onClick: () => { editor.value = full.source; editor.dispatchEvent(new Event('input')); toast('Loaded. Save the draft and publish to restore this version.', 'info', 5000); } } : null,
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
        h('button.btn', { type: 'button', onclick: history }, 'History'),
        h('button.btn', { type: 'button', onclick: () => downloadUrl(`/api/forms/${id}/export`), disabled: !form.current_version_id }, 'Export'),
        !canEdit ? h('button.btn.primary', { type: 'button', onclick: copyToInstitution }, 'Copy to my institution') : null,
        canEdit && form.current_version_id ? h('button.btn.ghost', { type: 'button', onclick: toggleActive }, form.active ? 'Deactivate' : 'Activate') : null,
        canEdit && (form.draft_version || !form.current_version_id) ? h('button.btn.ghost', { type: 'button', onclick: discard }, form.current_version_id ? 'Discard draft' : 'Delete') : null,
        canEdit ? h('button.btn', { type: 'button', onclick: saveDraft }, 'Save draft') : null,
        canEdit ? publishBtn : null));
  }

  // Narrow screens show one pane at a time.
  const panes = h('div.editor-panes');
  const tabs = h('div.seg.pane-tabs', ['source', 'form', 'report'].map(p => h(`button.seg-btn${p === 'source' ? '.on' : ''}`, {
    type: 'button', onclick: (e) => { panes.dataset.show = p; tabs.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('on', b === e.currentTarget)); },
  }, { source: 'Source', form: 'Tech form', report: 'Report' }[p])));
  panes.dataset.show = 'source';

  mount(panes,
    h('section.pane.pane-source',
      h('div.pane-head', h('h3', 'Form source'), h('a.small', { href: '/help.html?doc=FORMS', target: '_blank', rel: 'noopener' }, 'Help')),
      !canEdit ? h('div.alert.info.small', 'General-library forms can only be edited by a superuser. Copy it to your institution to customize it.') : null,
      editor, problemsBox),
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
  mount(root, h('div.editor-page', header, tabs, panes));
  rebuild();

  const beforeUnload = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', beforeUnload);
  return () => {
    window.removeEventListener('beforeunload', beforeUnload);
    if (dirty && canEdit) toast('Unsaved form changes were discarded', 'info');
  };
}

// SPDX-License-Identifier: GPL-3.0-or-later
//
// The technologist's form screen: patient banner, section navigation,
// the form itself, a live preview of the findings text, autosave and submit.

import { h, mount, toast, modal, confirmDialog, debounce, patientName, patientLine, statusBadge, fmtDateTime } from '../dom.js';
import { get, post, put } from '../api.js';
import { renderForm } from '../components/form-renderer.js';
import { generateReport } from '/shared/template.js';
import { validateAnswers } from '/shared/engine.js';
import { initialAnswers } from '/shared/formdef.js';
import { chooseForm, chooseLinkedStudies, startFromStudy } from './tech-worklist.js';

export async function render({ root, params, navigate, session }) {
  const id = Number(params[0]);
  let data = await get(`/exams/${id}`);
  let { exam } = data;
  let rowVersion = exam.row_version;
  const editable = () => ['draft', 'returned'].includes(exam.status) && session.can.tech;

  const saveState = h('span.save-state');
  let dirty = false;
  let saving = null;
  let conflict = false;
  const setSaveState = (text, kind = '') => { saveState.textContent = text; saveState.className = `save-state ${kind}`; };

  let answers = exam.answers || {};
  const techNote = h('textarea.input', { rows: 3, placeholder: 'Anything the radiologist should know (optional). This is not included in the findings text.', value: exam.tech_note || '' });

  async function save() {
    if (!dirty || conflict || !editable()) return;
    if (saving) { await saving; if (!dirty) return; }
    dirty = false;
    setSaveState('Saving…');
    saving = (async () => {
      try {
        const r = await put(`/exams/${id}`, { answers, tech_note: techNote.value, row_version: rowVersion });
        rowVersion = r.row_version;
        setSaveState(`Saved ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, 'ok');
      } catch (e) {
        dirty = true;
        if (e.body?.code === 'CONFLICT') {
          conflict = true;
          setSaveState('Not saved: changed elsewhere', 'error');
          modal({ title: 'This form was changed elsewhere', body: h('p', 'Someone else (or another window) saved this form after you opened it. Reload to see the latest version; your unsaved changes here will be lost.'), actions: [{ label: 'Reload', primary: true, onClick: () => { location.reload(); } }] });
        } else {
          setSaveState('Not saved, will retry', 'error');
          setTimeout(() => autosave(), 5000);
        }
      } finally {
        saving = null;
      }
    })();
    await saving;
  }
  const autosave = debounce(save, 1200);
  const markDirty = () => { if (!editable()) return; dirty = true; setSaveState('Unsaved changes'); autosave(); };
  techNote.addEventListener('input', markDirty);

  const beforeUnload = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', beforeUnload);

  // ---- layout ---------------------------------------------------------------
  const preview = h('pre.report-text', '');
  const previewErrors = h('div');
  const previewPanel = h('aside.preview-panel',
    h('div.panel-head', h('h3', 'Findings preview'), h('span.muted.small', 'What the radiologist will see')),
    previewErrors, preview);
  let showPreview = localStorage.getItem('sf.techPreview') !== '0';
  const previewToggle = h('button.btn.small', { type: 'button', onclick: () => { showPreview = !showPreview; try { localStorage.setItem('sf.techPreview', showPreview ? '1' : '0'); } catch { /* ignore */ } layoutPreview(); } });
  const layoutPreview = () => {
    previewPanel.hidden = !showPreview;
    previewToggle.textContent = showPreview ? 'Hide preview' : 'Show preview';
    grid.classList.toggle('with-preview', showPreview);
  };

  const updatePreview = debounce(() => {
    if (!data.form || previewPanel.hidden) return;
    try {
      const r = generateReport(data.form.definition, answers, data.env);
      preview.textContent = r.text || '(nothing yet)';
      mount(previewErrors, r.errors.map(e => h('div.alert.error.small', e)));
    } catch (e) {
      mount(previewErrors, h('div.alert.error.small', e.message));
    }
  }, 150);

  let form = null;
  const formHost = h('div.form-host');
  const navHost = h('div.nav-host');
  const grid = h('div.exam-grid', navHost, formHost, previewPanel);

  function buildForm() {
    if (!data.form) {
      mount(navHost);
      mount(formHost, h('div.empty',
        h('h2', 'Choose a form'),
        h('p', 'No form was matched to this study automatically.'),
        editable() ? h('button.btn.primary', { type: 'button', onclick: changeForm }, 'Choose form…') : null));
      return;
    }
    const def = data.form.definition;
    if (!Object.keys(answers).filter(k => !k.startsWith('__')).length && editable()) {
      answers = { ...initialAnswers(def) };
    }
    form = renderForm(def, answers, {
      env: data.env,
      readOnly: !editable(),
      onChange: () => { markDirty(); updatePreview(); },
    });
    mount(navHost, form.nav);
    mount(formHost, form.el,
      h('section.form-section', h('div.section-head', h('h3', 'Note to radiologist')), techNote));
    techNote.disabled = !editable();
    updatePreview();
  }

  async function changeForm() {
    const chosen = await chooseForm(exam.study.description, { title: 'Change form', current: data.form ? null : null });
    if (!chosen) return;
    await save();
    try {
      const r = await post(`/exams/${id}/form`, { form_id: chosen.id, row_version: rowVersion });
      rowVersion = r.row_version;
      data = await get(`/exams/${id}`);
      exam = data.exam;
      rowVersion = exam.row_version;
      answers = exam.answers || {};
      drawHeader();
      buildForm();
    } catch (e) { toast(e.message, 'error'); }
  }

  async function submit() {
    if (!data.form) return changeForm();
    autosave.cancel();
    const { missing, warnings } = validateAnswers(data.form.definition, answers, data.env);
    if (missing.length) {
      form.highlightMissing(missing);
      form.focusField(missing[0].id);
      modal({
        title: `${missing.length} required item${missing.length > 1 ? 's' : ''} missing`,
        body: h('ul.missing-list', missing.map(m => h('li', h('a', { href: '#', onclick: (e) => { e.preventDefault(); document.querySelector('dialog.modal')?.close(); document.querySelector('dialog.modal')?.remove(); form.focusField(m.id); } }, `${m.section}: ${m.label}`)))),
        actions: [{ label: 'OK', primary: true }],
      });
      return;
    }
    if (warnings.length) {
      const ok = await confirmDialog('Check these values', h('div', h('p', 'These measurements are outside the usual range:'), h('ul', warnings.map(w => h('li', `${w.label}: ${w.message}`))), h('p', 'Submit anyway?')), { confirmLabel: 'Submit anyway' });
      if (!ok) return;
    }
    if (saving) await saving;
    submitBtn.disabled = true;
    try {
      await post(`/exams/${id}/submit`, { answers, tech_note: techNote.value, row_version: rowVersion });
      dirty = false;
      toast('Submitted. The radiologist can now dictate it.', 'success');
      if (!(await offerNextStudy())) navigate('/tech');
    } catch (e) {
      if (e.body?.row_version) rowVersion = e.body.row_version;
      if (e.body?.missing) form.highlightMissing(e.body.missing);
      toast(e.message, 'error', 6000);
      submitBtn.disabled = false;
    }
  }

  // After submitting: if the patient has another study today without a form,
  // offer to start it. Returns true if one was started.
  async function offerNextStudy() {
    let related;
    try { related = await get(`/exams/${id}/related-studies`); } catch { return false; }
    const free = (related.studies || []).filter(st => st.state === 'free');
    if (!free.length) return false;
    const choice = await modal({
      title: 'Next study for this patient',
      body: [h('p', `${patientName(exam.patient)} has ${free.length === 1 ? 'another study' : 'other studies'} today without a form:`),
        h('ul', free.map(st => h('li', [st.description || 'Study', st.accession && `Acc ${st.accession}`].filter(Boolean).join(' · '))))],
      actions: [{ label: 'Back to worklist', value: null }, ...free.slice(0, 3).map(st => ({ label: `Start ${st.description || 'study'}`, primary: true, value: st }))],
    });
    if (!choice) return false;
    await startFromStudy(choice, navigate, free);
    return true;
  }

  // Which of the patient's PACS studies today this form covers.
  async function editStudies() {
    let related;
    try { related = await get(`/exams/${id}/related-studies`); } catch (e) { toast(e.message, 'error'); return; }
    const others = (related.studies || []).filter(st => st.state !== 'this');
    if (!others.length) { toast(related.error || 'This patient has no other studies in today’s PACS worklist.', 'info'); return; }
    const picked = await chooseLinkedStudies(patientName(exam.patient), data.form?.definition?.title || 'this', others.map(st => ({
      ...st,
      checked: st.state === 'linked',
      disabled: st.state === 'other',
      note: st.state === 'other' ? `on the ${st.exam.form_title || 'other'} form` : '',
    })));
    if (picked === null) return;
    try {
      const r = await put(`/exams/${id}/studies`, { study_uids: picked });
      exam.linked_studies = r.linked_studies;
      drawHeader();
      toast(r.linked_studies.length ? `This form now covers ${r.linked_studies.length + 1} studies` : 'This form covers its own study only', 'success');
    } catch (e) { toast(e.message, 'error'); }
  }

  async function reopen() {
    if (!(await confirmDialog('Reopen this form?', 'It will be removed from the radiologist worklist until you submit it again.', { confirmLabel: 'Reopen' }))) return;
    try {
      await post(`/exams/${id}/reopen`, { row_version: rowVersion });
      data = await get(`/exams/${id}`);
      exam = data.exam;
      rowVersion = exam.row_version;
      answers = exam.answers || {};
      drawHeader();
      buildForm();
    } catch (e) { toast(e.message, 'error'); }
  }

  async function cancelExam() {
    if (!(await confirmDialog('Cancel this exam?', 'Use this if the study was started by mistake or not performed. It will disappear from worklists.', { confirmLabel: 'Cancel exam', danger: true }))) return;
    try {
      await post(`/exams/${id}/cancel`, { row_version: rowVersion });
      dirty = false;
      navigate('/tech');
    } catch (e) { toast(e.message, 'error'); }
  }

  const submitBtn = h('button.btn.primary', { type: 'button', onclick: submit }, 'Submit to radiologist');
  const header = h('div.exam-banner');
  function drawHeader() {
    const p = exam.patient;
    mount(header,
      h('div.banner-left',
        h('a.back', { href: '#/tech' }, '← Worklist'),
        h('div.banner-name', patientName(p), ' ', statusBadge(exam.status)),
        h('div.banner-sub', patientLine(p)),
        h('div.banner-sub', [exam.study.description, exam.study.accession && `Acc ${exam.study.accession}`, exam.study.referring && `Ref: ${exam.study.referring}`].filter(Boolean).join(' · ')),
        (exam.linked_studies || []).length ? h('div.banner-sub.linked-line', h('span.badge', 'Also covers'), ' ',
          exam.linked_studies.map(st => [st.description, st.accession && `Acc ${st.accession}`].filter(Boolean).join(' · ')).join('; ')) : null,
        exam.source === 'pacs' && ['draft', 'returned', 'submitted'].includes(exam.status) && session.can.tech
          ? h('button.link.small', { type: 'button', onclick: editStudies }, (exam.linked_studies || []).length ? 'Change studies covered…' : 'Covers another study too?') : null),
      h('div.banner-right',
        h('div.banner-form',
          h('span.muted.small', 'Form'),
          h('strong', data.form ? data.form.definition.title : '—'),
          editable() && data.form ? h('button.link', { type: 'button', onclick: changeForm }, 'change') : null),
        h('div.banner-actions',
          saveState,
          previewToggle,
          editable() ? h('button.btn.ghost', { type: 'button', onclick: cancelExam }, 'Cancel exam') : null,
          exam.status === 'submitted' ? h('button.btn', { type: 'button', onclick: reopen }, 'Reopen to edit') : null,
          editable() ? submitBtn : null)),
    );
    if (exam.status === 'returned' && exam.return_reason) {
      header.appendChild(h('div.alert.warn.banner-alert', h('strong', `Returned by ${exam.rad_name || 'radiologist'}: `), exam.return_reason));
    }
    if (['submitted', 'dictated'].includes(exam.status)) {
      header.appendChild(h('div.alert.info.banner-alert', exam.status === 'dictated'
        ? `Dictated by ${exam.rad_name || 'radiologist'} ${fmtDateTime(exam.dictated_at)}. This form is read-only.`
        : `Submitted ${fmtDateTime(exam.submitted_at)} by ${exam.tech_name || ''}. Waiting for the radiologist.`));
    }
  }

  drawHeader();
  mount(root, h('div.exam-page', header, grid));
  layoutPreview();
  buildForm();
  if (editable()) setSaveState(exam.status === 'returned' ? 'Returned for changes' : 'All changes saved', 'ok');

  // Keyboard: Ctrl/Cmd+S saves now.
  const onKey = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); autosave.cancel(); save(); }
  };
  window.addEventListener('keydown', onKey);

  return () => {
    window.removeEventListener('beforeunload', beforeUnload);
    window.removeEventListener('keydown', onKey);
    autosave.cancel();
    if (dirty) save();
  };
}

// SPDX-License-Identifier: GPL-3.0-or-later
//
// Radiologist view of a submitted exam: editable findings text to copy into
// the dictation system, the tech's note, and what the tech entered.

import { h, mount, toast, confirmDialog, promptDialog, debounce, copyText, patientName, patientLine, statusBadge, fmtDateTime } from '../dom.js';
import { get, post, put } from '../api.js';
import { answersSummary } from '../components/form-renderer.js';

export async function render({ root, params, navigate, session }) {
  const id = Number(params[0]);
  const data = await get(`/exams/${id}`);
  const { exam } = data;
  let rowVersion = exam.row_version;
  const generated = exam.report || '';
  const editable = exam.status === 'submitted';

  const queue = JSON.parse(sessionStorage.getItem('sf.radQueue') || '[]');
  const nextId = () => {
    const i = queue.indexOf(id);
    const rest = i >= 0 ? queue.slice(i + 1) : queue.filter(x => x !== id);
    return rest[0] || null;
  };

  const saveState = h('span.save-state');
  const text = h('textarea.findings', { spellcheck: 'true', readOnly: !editable, value: exam.final_report ?? generated, 'aria-label': 'Findings text' });
  const edited = () => text.value !== generated;
  const resetBtn = h('button.btn.small.ghost', { type: 'button', hidden: !edited() || !editable, onclick: async () => {
    if (!(await confirmDialog('Discard your edits?', 'The findings will go back to the text generated from the tech’s form.', { confirmLabel: 'Discard edits', danger: true }))) return;
    text.value = generated;
    onEdit();
  } }, 'Reset to generated');

  const saveEdits = debounce(async () => {
    try {
      const r = await put(`/exams/${id}/report`, { text: edited() ? text.value : null, row_version: rowVersion });
      rowVersion = r.row_version;
      saveState.textContent = edited() ? 'Edits saved' : '';
      saveState.className = 'save-state ok';
    } catch (e) {
      saveState.textContent = 'Edits not saved';
      saveState.className = 'save-state error';
      toast(e.message, 'error');
    }
  }, 800);
  function onEdit() {
    resetBtn.hidden = !edited();
    saveState.textContent = 'Saving…';
    saveState.className = 'save-state';
    saveEdits();
  }
  text.addEventListener('input', onEdit);

  const forClipboard = () => {
    const t = text.value.replace(/\r\n/g, '\n');
    return session.settings.report_line_ending === 'lf' ? t : t.replace(/\n/g, '\r\n');
  };

  async function copy() {
    if (await copyText(forClipboard())) {
      toast('Findings copied: paste into your dictation', 'success', 2500);
      post(`/exams/${id}/copied`).catch(() => {});
      return true;
    }
    toast('Copy failed: select the text and press Ctrl+C', 'error');
    return false;
  }

  async function markDictated({ goNext = true } = {}) {
    saveEdits.cancel();
    try {
      await post(`/exams/${id}/dictated`, { row_version: rowVersion, text: edited() ? text.value : null });
      toast('Marked dictated', 'success', 2000);
      const next = goNext ? nextId() : null;
      navigate(next ? `/rad/exam/${next}` : '/rad');
    } catch (e) { toast(e.message, 'error'); }
  }

  async function copyAndDictate() {
    if (await copy()) await markDictated();
  }

  async function returnToTech() {
    const reason = await promptDialog('Return to technologist', 'What needs to be fixed or added?', { multiline: true, confirmLabel: 'Return' });
    if (!reason) return;
    try {
      await post(`/exams/${id}/return`, { row_version: rowVersion, reason });
      toast('Returned to the technologist', 'success');
      navigate('/rad');
    } catch (e) { toast(e.message, 'error'); }
  }

  async function undictate() {
    if (!(await confirmDialog('Move back to the worklist?', 'This marks the exam as not yet dictated.', { confirmLabel: 'Move back' }))) return;
    try {
      await post(`/exams/${id}/undictate`, { row_version: rowVersion });
      navigate(`/rad/exam/${id}`);
    } catch (e) { toast(e.message, 'error'); }
  }

  const p = exam.patient;
  const banner = h('div.exam-banner',
    h('div.banner-left',
      h('a.back', { href: '#/rad' }, '← Worklist'),
      h('div.banner-name', patientName(p), ' ', statusBadge(exam.status)),
      h('div.banner-sub', patientLine(p)),
      h('div.banner-sub', [exam.institution_name, exam.study.description, exam.study.accession && `Acc ${exam.study.accession}`].filter(Boolean).join(' · '))),
    h('div.banner-right',
      h('div.banner-form', h('span.muted.small', 'Form'), h('strong', data.form?.definition?.title || exam.form_title || '—')),
      h('div.muted.small', `Tech: ${exam.tech_name || '—'} · submitted ${fmtDateTime(exam.submitted_at)}`),
      exam.status === 'dictated' ? h('div.muted.small', `Dictated by ${exam.rad_name || '—'} ${fmtDateTime(exam.dictated_at)}`) : null));

  const actions = editable ? h('div.rad-actions',
    h('button.btn.primary.big', { type: 'button', onclick: copy, title: 'Ctrl+Shift+C' }, '⧉ Copy findings'),
    h('button.btn.big', { type: 'button', onclick: copyAndDictate, title: 'Ctrl+Shift+D' }, 'Copy & mark dictated'),
    h('button.btn', { type: 'button', onclick: () => markDictated() }, 'Mark dictated'),
    h('button.btn.ghost', { type: 'button', onclick: returnToTech }, '↩ Return to tech'),
  ) : h('div.rad-actions',
    h('button.btn.primary', { type: 'button', onclick: copy }, '⧉ Copy findings'),
    exam.status === 'dictated' ? h('button.btn.ghost', { type: 'button', onclick: undictate }, 'Move back to worklist') : null);

  const side = h('aside.rad-side',
    exam.tech_note ? h('div.tech-note', h('h3', 'Note from tech'), h('p', exam.tech_note)) : null,
    h('h3', 'What the tech entered'),
    data.form ? answersSummary(data.form.definition, exam.answers, data.env) : h('p.muted', 'No form.'));

  mount(root, h('div.exam-page.rad',
    banner,
    h('div.rad-grid',
      h('section.rad-main',
        h('div.panel-head', h('h3', 'Findings'), h('div', saveState, resetBtn)),
        exam.status === 'returned' ? h('div.alert.warn', `Returned to tech: ${exam.return_reason || ''}`) : null,
        !generated && exam.status !== 'returned' ? h('div.alert.info', 'No findings text has been generated yet.') : null,
        text,
        actions,
        h('p.muted.small', 'Shortcuts: Ctrl+Shift+C copy · Ctrl+Shift+D copy & mark dictated · edits are saved automatically.')),
      side)));

  const onKey = (e) => {
    if (!(e.ctrlKey || e.metaKey) || !e.shiftKey) return;
    if (e.key.toLowerCase() === 'c') { e.preventDefault(); copy(); }
    if (e.key.toLowerCase() === 'd' && editable) { e.preventDefault(); copyAndDictate(); }
  };
  window.addEventListener('keydown', onKey);
  return () => {
    window.removeEventListener('keydown', onKey);
    saveEdits.flush();
  };
}

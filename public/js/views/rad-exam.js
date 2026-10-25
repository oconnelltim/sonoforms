// SPDX-License-Identifier: GPL-3.0-or-later
//
// Radiologist view of a submitted exam. The report is shown as one card per
// report field (Indication, Comparison, Technique, Findings, Impression),
// because these are separate fields in speech-recognition templates: each
// card has its own Copy button. Edits are saved per field.

import { h, mount, toast, confirmDialog, promptDialog, debounce, copyText, patientName, patientLine, statusBadge, fmtDateTime } from '../dom.js';
import { get, post, put } from '../api.js';
import { answersSummary } from '../components/form-renderer.js';
import { reportFields, reportText } from '/shared/report-fields.js';

export async function render({ root, params, navigate, session }) {
  const id = Number(params[0]);
  const data = await get(`/exams/${id}`);
  const { exam } = data;
  let rowVersion = exam.row_version;
  const editable = exam.status === 'submitted';
  const generated = reportFields(exam.report);
  const edited = reportFields(exam.final_report);
  // Fields to show: the generated ones, plus any only present in saved edits.
  const fieldList = [...generated, ...edited.filter(e => !generated.some(g => g.id === e.id))];
  const generatedText = fid => generated.find(f => f.id === fid)?.text ?? '';

  const queue = JSON.parse(sessionStorage.getItem('sf.radQueue') || '[]');
  const nextId = () => {
    const i = queue.indexOf(id);
    const rest = i >= 0 ? queue.slice(i + 1) : queue.filter(x => x !== id);
    return rest[0] || null;
  };

  const saveState = h('span.save-state');
  const cards = [];   // { field, textarea, copiedBadge, resetBtn, card }

  // Only fields the radiologist changed are sent; null means "all as generated".
  const changes = () => {
    const out = {};
    for (const c of cards) if (c.textarea.value !== generatedText(c.field.id)) out[c.field.id] = c.textarea.value;
    return Object.keys(out).length ? out : null;
  };

  const saveEdits = debounce(async () => {
    try {
      const r = await put(`/exams/${id}/report`, { fields: changes(), row_version: rowVersion });
      rowVersion = r.row_version;
      saveState.textContent = changes() ? 'Edits saved' : '';
      saveState.className = 'save-state ok';
    } catch (e) {
      saveState.textContent = 'Edits not saved';
      saveState.className = 'save-state error';
      toast(e.message, 'error');
    }
  }, 800);

  const clipboardText = (t) => {
    const s = String(t).replace(/\r\n/g, '\n');
    return session.settings.report_line_ending === 'lf' ? s : s.replace(/\n/g, '\r\n');
  };

  function autosize(ta) {
    ta.style.height = 'auto';
    ta.style.height = `${Math.max(ta.scrollHeight + 2, 48)}px`;
  }

  async function copyCard(c) {
    if (!(await copyText(clipboardText(c.textarea.value)))) {
      toast('Copy failed: select the text and press Ctrl+C', 'error');
      return;
    }
    c.card.classList.add('copied');
    c.copiedBadge.hidden = false;
    toast(`${c.field.label} copied`, 'success', 1800);
    post(`/exams/${id}/copied`, { field: c.field.id }).catch(() => {});
    if (editable && cards.every(x => x.card.classList.contains('copied'))) dictateBtn.classList.add('primary');
  }

  async function copyAll() {
    const fields = cards.map(c => ({ id: c.field.id, label: c.field.label, text: c.textarea.value })).filter(f => f.text.trim());
    if (await copyText(clipboardText(reportText(fields)))) {
      toast('Whole report copied as one block', 'success', 2000);
      post(`/exams/${id}/copied`, { field: 'all' }).catch(() => {});
    }
  }

  fieldList.forEach((field, i) => {
    const textarea = h('textarea.findings', {
      spellcheck: 'true', readOnly: !editable, 'aria-label': `${field.label} text`, value: edited.find(e => e.id === field.id)?.text ?? field.text,
    });
    const copiedBadge = h('span.badge.status-submitted', { hidden: true }, 'Copied');
    const resetBtn = h('button.btn.small.ghost', {
      type: 'button', hidden: true,
      onclick: async () => {
        if (!(await confirmDialog(`Discard your edits to ${field.label}?`, 'This card goes back to the text generated from the tech’s form.', { confirmLabel: 'Discard edits', danger: true }))) return;
        textarea.value = generatedText(field.id);
        onEdit(c);
      },
    }, 'Reset to generated');
    const c = { field, textarea, copiedBadge, resetBtn };
    c.card = h('section.report-card',
      h('div.report-card-head',
        h('h3', field.label), copiedBadge, h('span.spacer'), resetBtn,
        h('button.btn.small', { type: 'button', onclick: () => copyCard(c), title: i < 9 ? `Ctrl+Shift+${i + 1}` : '' }, '⧉ Copy')),
      textarea);
    textarea.addEventListener('input', () => onEdit(c));
    resetBtn.hidden = !editable || textarea.value === generatedText(field.id);
    cards.push(c);
  });

  function onEdit(c) {
    c.resetBtn.hidden = c.textarea.value === generatedText(c.field.id);
    c.card.classList.remove('copied');
    c.copiedBadge.hidden = true;
    autosize(c.textarea);
    saveState.textContent = 'Saving…';
    saveState.className = 'save-state';
    saveEdits();
  }

  async function markDictated({ goNext = true } = {}) {
    saveEdits.cancel();
    try {
      await post(`/exams/${id}/dictated`, { row_version: rowVersion, fields: changes() });
      toast('Marked dictated', 'success', 2000);
      const next = goNext ? nextId() : null;
      navigate(next ? `/rad/exam/${next}` : '/rad');
    } catch (e) { toast(e.message, 'error'); }
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

  const dictateBtn = h('button.btn.big', { type: 'button', onclick: () => markDictated() }, '✓ Mark dictated');
  const actions = editable
    ? h('div.rad-actions', dictateBtn, h('button.btn.ghost', { type: 'button', onclick: returnToTech }, '↩ Return to tech'), h('span.spacer'), h('button.btn.small.ghost', { type: 'button', onclick: copyAll }, 'Copy all as one block'))
    : h('div.rad-actions', exam.status === 'dictated' ? h('button.btn.ghost', { type: 'button', onclick: undictate }, 'Move back to worklist') : null, h('span.spacer'), h('button.btn.small.ghost', { type: 'button', onclick: copyAll }, 'Copy all as one block'));

  const side = h('aside.rad-side',
    exam.tech_note ? h('div.tech-note', h('h3', 'Note from tech'), h('p', exam.tech_note)) : null,
    h('h3', 'What the tech entered'),
    data.form ? answersSummary(data.form.definition, exam.answers, data.env) : h('p.muted', 'No form.'));

  mount(root, h('div.exam-page.rad',
    banner,
    h('div.rad-grid',
      h('section.rad-main',
        h('div.panel-head', h('h3', 'Report'), saveState),
        exam.status === 'returned' ? h('div.alert.warn', `Returned to tech: ${exam.return_reason || ''}`) : null,
        !cards.length && exam.status !== 'returned' ? h('div.alert.info', 'No report text has been generated yet.') : null,
        h('div.report-cards', cards.map(c => c.card)),
        actions,
        h('p.muted.small', `Each card goes into its own field in your dictation template. Shortcuts: Ctrl+Shift+1–${Math.min(cards.length, 9) || 1} copy a card. Edits are saved automatically.`)),
      side)));
  cards.forEach(c => autosize(c.textarea));

  const onKey = (e) => {
    if (!(e.ctrlKey || e.metaKey) || !e.shiftKey) return;
    const n = Number(e.code?.replace('Digit', ''));
    if (n >= 1 && n <= cards.length) { e.preventDefault(); copyCard(cards[n - 1]); }
  };
  window.addEventListener('keydown', onKey);
  return () => {
    window.removeEventListener('keydown', onKey);
    saveEdits.flush();
  };
}

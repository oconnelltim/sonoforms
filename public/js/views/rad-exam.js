// SPDX-License-Identifier: GPL-3.0-or-later
//
// Radiologist view of a submitted exam. The report is shown as one card per
// report field (Indication, Comparison, Technique, Findings, Impression),
// because these are separate fields in speech-recognition templates: each
// card has its own Copy button. Edits are saved per field.
//
// When the patient has other submitted exams the same day (e.g. an abdomen
// and a DVT study), they are reported together by default: one set of
// cards, with a heading per exam in Findings and Impression. The combined
// edits are kept on the first exam of the group.

import { h, mount, toast, modal, confirmDialog, promptDialog, debounce, copyText, patientName, patientLine, statusBadge, fmtDateTime } from '../dom.js';
import { get, post, put } from '../api.js';
import { answersSummary } from '../components/form-renderer.js';
import { reportFields, reportText, combineReports } from '/shared/report-fields.js';

const ownFields = e => reportFields(e.final_report && !e.final_report.combined ? e.final_report : e.report);
const studyLine = st => [st.description, st.accession && `Acc ${st.accession}`].filter(Boolean).join(' · ');

export async function render({ root, params, navigate, session }) {
  const id = Number(params[0]);
  const [data, visit] = await Promise.all([get(`/exams/${id}`), get(`/exams/${id}/visit`).catch(() => ({ exams: [] }))]);
  const { exam } = data;
  const self = visit.exams.find(e => e.id === id) || { ...exam, heading: '' };

  // Exams that can be reported with this one, and ones still with the tech.
  const readyOthers = visit.exams.filter(e => e.id !== id && e.status === 'submitted');
  const pending = visit.exams.filter(e => e.id !== id && ['draft', 'returned'].includes(e.status));
  const dictatedGroup = exam.status === 'dictated' && exam.final_report?.combined?.length > 1 ? exam.final_report.combined : null;
  const visitKey = `sf.radSeparate.${visit.exams.map(e => e.id).join('-')}`;
  const canCombine = exam.status === 'submitted' && readyOthers.length > 0;
  const combined = canCombine && sessionStorage.getItem(visitKey) !== '1';
  const group = combined ? [self, ...readyOthers].sort((a, b) => a.id - b.id) : [self];
  const lead = group[0];
  const groupIds = group.map(e => e.id);
  const sameGroup = ids => Array.isArray(ids) && ids.length === groupIds.length && ids.every(x => groupIds.includes(x));

  // What the cards start from, and any saved edits.
  let generated;
  let edited;
  if (combined) {
    generated = combineReports(group.map(e => ({ heading: e.heading, fields: ownFields(e) })));
    edited = sameGroup(lead.final_report?.combined) ? reportFields(lead.final_report) : [];
  } else if (dictatedGroup) {
    generated = reportFields(exam.final_report);
    edited = [];
  } else {
    generated = reportFields(exam.report);
    edited = exam.final_report?.combined ? [] : reportFields(exam.final_report);
  }
  const saveId = combined ? lead.id : id;
  let rowVersion = combined ? lead.row_version : exam.row_version;
  const editable = exam.status === 'submitted';
  // Fields to show: the generated ones, plus any only present in saved edits.
  const fieldList = [...generated, ...edited.filter(e => !generated.some(g => g.id === e.id))];
  const generatedText = fid => generated.find(f => f.id === fid)?.text ?? '';

  const queue = JSON.parse(sessionStorage.getItem('sf.radQueue') || '[]');
  const nextId = () => {
    const i = queue.indexOf(id);
    const rest = (i >= 0 ? queue.slice(i + 1) : queue).filter(x => !groupIds.includes(x));
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
      const body = { fields: changes(), row_version: rowVersion };
      if (combined) body.combined_with = groupIds.filter(x => x !== saveId);
      const r = await put(`/exams/${saveId}/report`, body);
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
    post(`/exams/${saveId}/copied`, { field: c.field.id }).catch(() => {});
    if (editable && cards.every(x => x.card.classList.contains('copied'))) dictateBtn.classList.add('primary');
  }

  async function copyAll() {
    const fields = cards.map(c => ({ id: c.field.id, label: c.field.label, text: c.textarea.value })).filter(f => f.text.trim());
    if (await copyText(clipboardText(reportText(fields)))) {
      toast('Whole report copied as one block', 'success', 2000);
      post(`/exams/${saveId}/copied`, { field: 'all' }).catch(() => {});
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
      if (combined) {
        // The lead's version may have moved on while edits were saved.
        const versions = Object.fromEntries(group.map(e => [e.id, e.id === saveId ? rowVersion : e.row_version]));
        await post(`/exams/${id}/dictated-group`, { versions, fields: changes() });
        toast(`Marked ${group.length} exams dictated`, 'success', 2000);
      } else {
        await post(`/exams/${id}/dictated`, { row_version: rowVersion, fields: changes() });
        toast('Marked dictated', 'success', 2000);
      }
      const next = goNext ? nextId() : null;
      navigate(next ? `/rad/exam/${next}` : '/rad');
    } catch (e) { toast(e.message, 'error'); }
  }

  async function returnToTech() {
    // In a combined report, say which exam needs fixing.
    let target = self;
    if (combined) {
      const sel = h('select.input', group.map(e => h('option', { value: e.id }, `${e.form_title || 'Exam'}${e.study?.accession ? ` (Acc ${e.study.accession})` : ''}`)));
      const pickedId = await modal({
        title: 'Which exam needs fixing?',
        body: [h('p', 'The other exams stay on your worklist.'), sel],
        actions: [{ label: 'Cancel', value: null }, { label: 'Next', primary: true, onClick: close => close(Number(sel.value)), keepOpen: true }],
      });
      if (!pickedId) return;
      target = group.find(e => e.id === pickedId);
    }
    const reason = await promptDialog('Return to technologist', 'What needs to be fixed or added?', { multiline: true, confirmLabel: 'Return' });
    if (!reason) return;
    try {
      const version = target.id === saveId ? rowVersion : (target.id === id ? exam.row_version : target.row_version);
      await post(`/exams/${target.id}/return`, { row_version: version, reason });
      toast('Returned to the technologist', 'success');
      // Returning another exam of the group leaves this one open, now reported alone.
      if (target.id === id) navigate('/rad'); else location.reload();
    } catch (e) { toast(e.message, 'error'); }
  }

  async function undictate() {
    const msg = dictatedGroup ? `All ${dictatedGroup.length} exams reported together move back, and stay together.` : 'This marks the exam as not yet dictated.';
    if (!(await confirmDialog('Move back to the worklist?', msg, { confirmLabel: 'Move back' }))) return;
    try {
      await post(`/exams/${id}/undictate`, { row_version: exam.row_version });
      location.reload();
    } catch (e) { toast(e.message, 'error'); }
  }

  function setSeparate(separate) {
    try { sessionStorage.setItem(visitKey, separate ? '1' : '0'); } catch { /* ignore */ }
    location.reload();
  }

  const p = exam.patient;
  const examLines = (combined ? group : [self.id ? self : exam]).map(e => {
    const st = e.study || exam.study;
    return h('div.banner-sub', [e.form_title && combined ? e.form_title : null, studyLine(st)].filter(Boolean).join(' · '),
      (e.linked_studies || []).length ? h('span', ' + ', e.linked_studies.map(studyLine).join('; ')) : null);
  });
  const banner = h('div.exam-banner',
    h('div.banner-left',
      h('a.back', { href: '#/rad' }, '← Worklist'),
      h('div.banner-name', patientName(p), ' ', statusBadge(exam.status), combined ? h('span.badge.accent', `${group.length} exams, one report`) : null),
      h('div.banner-sub', patientLine(p)),
      h('div.banner-sub', exam.institution_name),
      examLines),
    h('div.banner-right',
      h('div.banner-form', h('span.muted.small', combined ? 'Forms' : 'Form'), h('strong', combined ? group.map(e => e.form_title || '—').join(' + ') : (data.form?.definition?.title || exam.form_title || '—'))),
      h('div.muted.small', `Tech: ${exam.tech_name || '—'} · submitted ${fmtDateTime(exam.submitted_at)}`),
      exam.status === 'dictated' ? h('div.muted.small', `Dictated by ${exam.rad_name || '—'} ${fmtDateTime(exam.dictated_at)}`) : null));

  // Accession numbers to link in the dictation software.
  const accessions = [...new Set((combined ? group : [self]).flatMap(e => [e.study || exam.study, ...(e.linked_studies || [])]).map(st => st?.accession).filter(Boolean))];

  const notices = [];
  if (combined) {
    notices.push(h('div.alert.info', h('strong', 'Reported together: '), `${group.map(e => e.form_title || 'exam').join(' and ')} for this patient today. `,
      h('button.link', { type: 'button', onclick: () => setSeparate(true) }, 'Report separately')));
  } else if (canCombine) {
    notices.push(h('div.alert.info', `This patient has ${readyOthers.length === 1 ? 'another exam' : 'other exams'} ready today: ${readyOthers.map(e => e.form_title || 'exam').join(', ')}. `,
      h('button.link', { type: 'button', onclick: () => setSeparate(false) }, 'Report together')));
  }
  if (pending.length && editable) {
    notices.push(h('div.alert.warn', `Still with the tech: ${pending.map(e => `${e.form_title || 'exam'} (${e.status === 'returned' ? 'returned' : 'in progress'})`).join(', ')}. `,
      'To report it in the same report, wait until it is submitted.'));
  }
  if (dictatedGroup) notices.push(h('div.alert.info', `Dictated as one report with ${dictatedGroup.length - 1} other exam${dictatedGroup.length > 2 ? 's' : ''} from this visit.`));

  const dictateBtn = h('button.btn.big', { type: 'button', onclick: () => markDictated() }, combined ? `✓ Mark ${group.length} exams dictated` : '✓ Mark dictated');
  const actions = editable
    ? h('div.rad-actions', dictateBtn, h('button.btn.ghost', { type: 'button', onclick: returnToTech }, '↩ Return to tech'), h('span.spacer'), h('button.btn.small.ghost', { type: 'button', onclick: copyAll }, 'Copy all as one block'))
    : h('div.rad-actions', exam.status === 'dictated' ? h('button.btn.ghost', { type: 'button', onclick: undictate }, 'Move back to worklist') : null, h('span.spacer'), h('button.btn.small.ghost', { type: 'button', onclick: copyAll }, 'Copy all as one block'));

  // What each tech entered; other exams in the group are loaded alongside.
  const side = h('aside.rad-side');
  const sideFor = (d, withTitle) => [
    withTitle ? h('h2.side-exam-title', d.form?.definition?.title || d.exam.form_title || 'Exam') : null,
    d.exam.tech_note ? h('div.tech-note', h('h3', 'Note from tech'), h('p', d.exam.tech_note)) : null,
    h('h3', 'What the tech entered'),
    d.form ? answersSummary(d.form.definition, d.exam.answers, d.env) : h('p.muted', 'No form.'),
  ];
  mount(side, sideFor(data, combined));
  if (combined) {
    Promise.all(group.filter(e => e.id !== id).map(e => get(`/exams/${e.id}`))).then((others) => {
      const all = [data, ...others].sort((a, b) => a.exam.id - b.exam.id);
      mount(side, all.map(d => h('div.side-exam', sideFor(d, true))));
    }).catch(() => {});
  }

  mount(root, h('div.exam-page.rad',
    banner,
    h('div.rad-grid',
      h('section.rad-main',
        h('div.panel-head', h('h3', 'Report'), saveState),
        notices,
        exam.status === 'returned' ? h('div.alert.warn', `Returned to tech: ${exam.return_reason || ''}`) : null,
        !cards.length && exam.status !== 'returned' ? h('div.alert.info', 'No report text has been generated yet.') : null,
        accessions.length > 1 ? h('p.small', h('strong', 'Accession numbers: '), accessions.join(', '), h('span.muted', ' (link these in your dictation software)')) : null,
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

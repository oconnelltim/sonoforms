// SPDX-License-Identifier: GPL-3.0-or-later
//
// Technologist worklist: today's US studies from PACS plus forms already
// started in this app. Picking a study keeps the PACS demographics.

import { h, mount, toast, modal, fmtDate, fmtTime, fmtDateTime, patientName, statusBadge, timeAgo } from '../dom.js';
import { get, post } from '../api.js';

export async function chooseForm(description, { title = 'Choose a form', current = null } = {}) {
  const forms = await get(`/forms/available?description=${encodeURIComponent(description || '')}`);
  if (!forms.length) {
    toast('No forms are published for this institution yet. Ask a tech manager.', 'error');
    return null;
  }
  const filter = h('input.input', { placeholder: 'Search forms…', type: 'search' });
  const list = h('div.form-pick-list');
  let closeFn;
  const draw = () => {
    const q = filter.value.trim().toLowerCase();
    mount(list, forms.filter(f => !q || f.title.toLowerCase().includes(q)).map((f, i) => h(`button.form-pick${f.score > 0 && i === 0 && !q ? '.suggested' : ''}${f.id === current ? '.current' : ''}`, {
      type: 'button', onclick: () => closeFn(f),
    }, h('span.form-pick-title', f.title), f.score > 0 && i === 0 && !q ? h('span.badge.accent', 'Suggested') : null,
    f.id === current ? h('span.badge', 'Current') : null,
    f.description ? h('span.form-pick-desc', f.description) : null)));
  };
  filter.addEventListener('input', draw);
  draw();
  return modal({
    title,
    body: [description ? h('p.muted', `Study: ${description}`) : null, filter, list],
    onOpen: (dlg, close) => { closeFn = close; list.querySelector('button')?.focus(); },
  });
}

export async function startFromStudy(study, navigate) {
  if (study.exam) return navigate(`/exam/${study.exam.id}`);
  const form = await chooseForm(study.description);
  if (!form) return;
  try {
    const r = await post('/exams', { study_uid: study.study_uid, form_id: form.id });
    navigate(`/exam/${r.id}`);
  } catch (e) {
    toast(e.message, 'error');
  }
}

export async function render({ root, session, navigate }) {
  const institution = session.institutions.find(i => i.id === session.institution_id);
  const filter = h('input.input.search', { type: 'search', placeholder: 'Filter by name, MRN, accession, or study…', 'aria-label': 'Filter worklist' });
  const pacsBox = h('div');
  const openBox = h('div');
  const updated = h('span.muted.small');
  let data = null;
  let loading = false;

  async function load(force = false, background = false) {
    if (loading) return;
    loading = true;
    try {
      data = await get(`/worklist/tech${force ? '?refresh=1' : ''}`, { background });
      updated.textContent = `Updated ${fmtTime(new Date())}`;
      draw();
    } catch (e) {
      if (!background) mount(pacsBox, h('div.alert.error', e.message));
    } finally {
      loading = false;
    }
  }

  const matches = (q, ...vals) => !q || vals.some(v => String(v || '').toLowerCase().includes(q));

  function draw() {
    if (!data) return;
    const q = filter.value.trim().toLowerCase();

    // Forms in progress or returned by a radiologist.
    const open = data.exams.filter(e => ['draft', 'returned'].includes(e.status))
      .filter(e => matches(q, patientName(e.patient), e.patient.mrn, e.study.accession, e.study.description, e.form_title));
    mount(openBox, open.length ? [
      h('h2.list-title', 'Your open forms', h('span.count', open.length)),
      h('div.cards', open.map(e => h(`a.card.exam-card${e.status === 'returned' ? '.returned' : ''}`, { href: `#/exam/${e.id}` },
        h('div.card-top', statusBadge(e.status), h('span.muted.small', timeAgo(e.updated_at))),
        h('div.card-name', patientName(e.patient)),
        h('div.muted.small', [e.patient.mrn && `MRN ${e.patient.mrn}`, e.study.description].filter(Boolean).join(' · ')),
        h('div.card-form', e.form_title || 'No form chosen'),
        e.status === 'returned' && e.return_reason ? h('div.return-reason', `↩ ${e.return_reason}`) : null,
        e.tech_name ? h('div.muted.small', e.tech_name) : null,
      ))),
    ] : null);

    // PACS studies.
    const p = data.pacs;
    const parts = [h('div.list-head', h('h2.list-title', 'Today’s studies', p.studies?.length ? h('span.count', p.studies.length) : null), updated)];
    if (p.error) parts.push(h('div.alert.warn', h('strong', 'PACS query failed. '), p.error, h('div.small', 'You can still add a patient by hand with "New patient".')));
    else if (p.truncated) parts.push(h('div.alert.warn', `PACS returned more studies than the worklist shows (only the first ${p.studies.length} are listed). Ask an administrator to narrow the PACS filter in Admin › Institutions.`));
    if (!p.error && !p.configured) parts.push(h('div.alert.info', 'The PACS worklist is not set up for this institution. Use "New patient" to start a form, or ask an administrator to configure PACS in Admin › Institutions.'));
    const rows = (p.studies || []).filter(s => matches(q, patientName(s.patient), s.patient.mrn, s.accession, s.description));
    if (p.configured && !p.error) {
      parts.push(rows.length ? h('div.table-wrap', h('table.table.worklist',
        h('thead', h('tr', h('th', 'Time'), h('th', 'Patient'), h('th', 'Study'), h('th', 'Status'), h('th', ''))),
        h('tbody', rows.map(s => h(`tr.clickable${s.exam ? '.has-exam' : ''}`, {
          tabindex: 0,
          onclick: () => startFromStudy(s, navigate),
          onkeydown: (e) => { if (e.key === 'Enter') startFromStudy(s, navigate); },
        },
        h('td.nowrap', h('div', fmtTime(s.datetime)), h('div.muted.small', fmtDate(s.datetime?.slice(0, 10)) !== fmtDate(new Date().toISOString().slice(0, 10)) ? fmtDate(s.datetime?.slice(0, 10)) : '')),
        h('td', h('div.strong', patientName(s.patient)), h('div.muted.small', [s.patient.mrn && `MRN ${s.patient.mrn}`, s.patient.dob && fmtDate(s.patient.dob), s.patient.sex].filter(Boolean).join(' · '))),
        h('td', h('div', s.description || '—'), h('div.muted.small', s.accession ? `Acc ${s.accession}` : '')),
        h('td', s.exam ? [statusBadge(s.exam.status), h('div.muted.small', s.exam.tech_name || '')] : (s.suggested_form ? h('span.muted.small', s.suggested_form.title) : h('span.muted.small', 'No form match'))),
        h('td.right', h(`button.btn.small${s.exam ? '' : '.primary'}`, { type: 'button', tabindex: -1 }, s.exam ? 'Open' : 'Start')),
        ))))) : h('div.empty', q ? 'No studies match the filter.' : `No ultrasound studies found in the last ${session.settings.worklist_show_hours || 24} hours.`));
    }

    // Recently submitted, for reference.
    const done = data.exams.filter(e => ['submitted', 'dictated'].includes(e.status))
      .filter(e => matches(q, patientName(e.patient), e.patient.mrn, e.study.accession, e.study.description, e.form_title));
    if (done.length) {
      parts.push(h('h2.list-title', 'Submitted today', h('span.count', done.length)));
      parts.push(h('div.table-wrap', h('table.table',
        h('thead', h('tr', h('th', 'Submitted'), h('th', 'Patient'), h('th', 'Form'), h('th', 'Tech'), h('th', 'Status'))),
        h('tbody', done.map(e => h('tr.clickable', { onclick: () => navigate(`/exam/${e.id}`) },
          h('td.nowrap', fmtDateTime(e.submitted_at)),
          h('td', h('div.strong', patientName(e.patient)), h('div.muted.small', e.patient.mrn ? `MRN ${e.patient.mrn}` : '')),
          h('td', e.form_title || '—'),
          h('td', e.tech_name || ''),
          h('td', statusBadge(e.status))))))));
    }
    mount(pacsBox, parts);
  }

  filter.addEventListener('input', draw);

  mount(root, h('div.page',
    h('div.page-head',
      h('div', h('h1', 'Worklist'), h('div.muted', institution?.name || '')),
      h('div.page-actions',
        h('button.btn', { type: 'button', onclick: () => load(true) }, '↻ Refresh'),
        h('a.btn', { href: '#/tech/history' }, 'History'),
        h('a.btn.primary', { href: '#/tech/new' }, '+ New patient'))),
    filter,
    openBox,
    pacsBox,
  ));
  mount(pacsBox, h('div.loading', 'Loading worklist…'));
  filter.focus();
  await load();
  const timer = setInterval(() => load(false, true), 60000);
  return () => clearInterval(timer);
}

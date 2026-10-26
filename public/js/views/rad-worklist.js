// SPDX-License-Identifier: GPL-3.0-or-later

import { h, mount, fmtDateTime, patientName, statusBadge, timeAgo } from '../dom.js';
import { get, put } from '../api.js';

export async function render({ root, session, navigate }) {
  const prefs = session.user.preferences || {};
  const institutions = session.institutions;
  const instSel = h('select.input.auto', { 'aria-label': 'Institution' },
    institutions.length > 1 ? h('option', { value: 'all' }, 'All my institutions') : null,
    institutions.map(i => h('option', { value: i.id }, i.name)));
  instSel.value = prefs.rad_institutions && [...instSel.options].some(o => o.value === prefs.rad_institutions) ? prefs.rad_institutions : instSel.options[0]?.value;
  let status = sessionStorage.getItem('sf.radStatus') || 'submitted';
  const tabs = h('div.seg');
  const filter = h('input.input.search', { type: 'search', placeholder: 'Filter by name, MRN, accession, form…' });
  const box = h('div', h('div.loading', 'Loading…'));
  const updated = h('span.muted.small');
  let rows = [];

  const STATUSES = [['submitted', 'Ready to dictate'], ['returned', 'Returned'], ['dictated', 'Dictated']];
  function drawTabs() {
    mount(tabs, STATUSES.map(([v, l]) => h(`button.seg-btn${status === v ? '.on' : ''}`, { type: 'button', onclick: () => { status = v; sessionStorage.setItem('sf.radStatus', v); drawTabs(); load(); } }, l)));
  }

  async function load(background = false) {
    try {
      rows = await get(`/worklist/rad?status=${status}&institution=${instSel.value}`, { background });
      updated.textContent = `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      draw();
    } catch (e) {
      if (!background) mount(box, h('div.alert.error', e.message));
    }
  }

  // Exams for one patient on the same day are one row in the "ready" queue:
  // the radiologist reports them together.
  function visits(list) {
    if (status !== 'submitted') return list.map(e => [e]);
    const byKey = new Map();
    for (const e of list) {
      const key = `${e.patient.id}|${e.institution_id}|${e.exam_date}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(e);
    }
    return [...byKey.values()];
  }
  const accessions = e => [e.study.accession, ...(e.linked_studies || []).map(st => st.accession)].filter(Boolean);

  function draw() {
    const q = filter.value.trim().toLowerCase();
    const list = rows.filter(e => !q || [patientName(e.patient), e.patient.mrn, ...accessions(e), e.form_title, e.study.description, e.tech_name].some(v => String(v || '').toLowerCase().includes(q)));
    const groups = visits(list);
    const leadOf = g => g.reduce((a, b) => (b.id < a.id ? b : a));
    // The queue order is remembered so "Next case" works on the exam screen.
    sessionStorage.setItem('sf.radQueue', JSON.stringify(status === 'submitted' ? groups.map(g => leadOf(g).id) : []));
    const multi = instSel.value === 'all';
    mount(box, list.length ? h('div.table-wrap', h('table.table.worklist',
      h('thead', h('tr',
        h('th', status === 'dictated' ? 'Dictated' : 'Submitted'),
        h('th', 'Patient'), h('th', 'Study'), multi ? h('th', 'Site') : null, h('th', 'Tech'), h('th', 'Status'))),
      h('tbody', groups.map((g) => {
        const e = leadOf(g);
        const when = status === 'dictated' ? e.dictated_at : g.map(x => x.submitted_at).sort()[0];
        return h('tr.clickable', {
          tabindex: 0,
          onclick: () => navigate(`/rad/exam/${e.id}`),
          onkeydown: (ev) => { if (ev.key === 'Enter') navigate(`/rad/exam/${e.id}`); },
        },
        h('td.nowrap', h('div', fmtDateTime(when)), h('div.muted.small', timeAgo(when))),
        h('td', h('div.strong', patientName(e.patient)), h('div.muted.small', [e.patient.mrn && `MRN ${e.patient.mrn}`, e.patient.age !== null && `${e.patient.age} y`, e.patient.sex].filter(Boolean).join(' · '))),
        h('td',
          g.length > 1 ? h('span.badge.accent', `${g.length} exams, one report`) : null,
          g.map(x => h('div', h('div', x.form_title || x.study.description || '—'),
            h('div.muted.small', [x.study.description !== x.form_title && x.study.description, accessions(x).length && `Acc ${accessions(x).join(', ')}`].filter(Boolean).join(' · '))))),
        multi ? h('td', h('span.badge', e.institution_code)) : null,
        h('td', [...new Set(g.map(x => x.tech_name).filter(Boolean))].join(', ')),
        h('td', statusBadge(e.status), e.status === 'returned' && e.return_reason ? h('div.muted.small', e.return_reason) : null),
        );
      })))) : h('div.empty', status === 'submitted' ? 'All caught up: nothing waiting to be dictated.' : 'Nothing here.'));
  }

  instSel.addEventListener('change', () => { put('/session/preferences', { rad_institutions: instSel.value }).catch(() => {}); session.user.preferences = { ...prefs, rad_institutions: instSel.value }; load(); });
  filter.addEventListener('input', draw);
  drawTabs();
  mount(root, h('div.page',
    h('div.page-head', h('div', h('h1', 'Reading worklist'), updated), h('div.page-actions', instSel, h('button.btn', { type: 'button', onclick: () => load() }, '↻ Refresh'))),
    h('div.toolbar', tabs, filter),
    box));
  await load();
  const timer = setInterval(() => load(true), 30000);
  return () => clearInterval(timer);
}

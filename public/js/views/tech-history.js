// SPDX-License-Identifier: GPL-3.0-or-later

import { h, mount, fmtDateTime, patientName, statusBadge } from '../dom.js';
import { get } from '../api.js';

export async function render({ root, navigate }) {
  const days = h('select.input.auto', h('option', { value: 7 }, 'Last 7 days'), h('option', { value: 30 }, 'Last 30 days'), h('option', { value: 90 }, 'Last 90 days'));
  const mine = h('input', { type: 'checkbox', checked: true });
  const filter = h('input.input.search', { type: 'search', placeholder: 'Filter…' });
  const box = h('div', h('div.loading', 'Loading…'));
  let rows = [];

  async function load() {
    rows = await get(`/exams?days=${days.value}${mine.checked ? '&mine=1' : ''}`);
    draw();
  }
  function draw() {
    const q = filter.value.trim().toLowerCase();
    const list = rows.filter(e => !q || [patientName(e.patient), e.patient.mrn, e.form_title, e.study.description, e.study.accession].some(v => String(v || '').toLowerCase().includes(q)));
    mount(box, list.length ? h('div.table-wrap', h('table.table',
      h('thead', h('tr', h('th', 'Updated'), h('th', 'Patient'), h('th', 'Form'), h('th', 'Tech'), h('th', 'Status'))),
      h('tbody', list.map(e => h('tr.clickable', { onclick: () => navigate(`/exam/${e.id}`) },
        h('td.nowrap', fmtDateTime(e.updated_at)),
        h('td', h('div.strong', patientName(e.patient)), h('div.muted.small', [e.patient.mrn && `MRN ${e.patient.mrn}`, e.study.accession && `Acc ${e.study.accession}`].filter(Boolean).join(' · '))),
        h('td', e.form_title || '—'), h('td', e.tech_name || ''), h('td', statusBadge(e.status))))))) : h('div.empty', 'Nothing found.'));
  }
  days.addEventListener('change', load);
  mine.addEventListener('change', load);
  filter.addEventListener('input', draw);
  mount(root, h('div.page',
    h('div.page-head', h('div', h('a.back', { href: '#/tech' }, '← Worklist'), h('h1', 'History'))),
    h('div.toolbar', filter, days, h('label.check', mine, ' Only mine')),
    box));
  await load();
}

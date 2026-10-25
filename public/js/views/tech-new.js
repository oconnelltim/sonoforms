// SPDX-License-Identifier: GPL-3.0-or-later
//
// Start a form without a PACS study: find an existing patient by MRN or
// last name, or enter a new one.

import { h, mount, toast, fmtDate, patientName } from '../dom.js';
import { post } from '../api.js';
import { chooseForm } from './tech-worklist.js';

export async function render({ root, navigate }) {
  const mrn = h('input.input', { placeholder: 'MRN', autocomplete: 'off', id: 's-mrn' });
  const last = h('input.input', { placeholder: 'Last name', autocomplete: 'off', id: 's-last' });
  const results = h('div');

  const f = {
    mrn: h('input.input', { required: true, autocomplete: 'off', id: 'n-mrn' }),
    last_name: h('input.input', { required: true, autocomplete: 'off', id: 'n-last' }),
    first_name: h('input.input', { autocomplete: 'off', id: 'n-first' }),
    dob: h('input.input', { type: 'date', id: 'n-dob' }),
    sex: h('select.input', { id: 'n-sex' }, h('option', { value: '' }, '—'), h('option', { value: 'F' }, 'Female'), h('option', { value: 'M' }, 'Male'), h('option', { value: 'O' }, 'Other')),
    description: h('input.input', { placeholder: 'e.g. US PELVIS', autocomplete: 'off', id: 'n-desc' }),
    accession: h('input.input', { autocomplete: 'off', id: 'n-acc' }),
  };
  const error = h('div.alert.error', { hidden: true });

  async function start(patient, description = '', accession = '') {
    const form = await chooseForm(description);
    if (!form) return;
    try {
      const r = await post('/exams', { patient_id: patient.id, form_id: form.id, description: description || form.title, accession });
      navigate(`/exam/${r.id}`);
    } catch (e) { toast(e.message, 'error'); }
  }

  async function search(e) {
    e?.preventDefault();
    if (!mrn.value.trim() && !last.value.trim()) return;
    try {
      const list = await post('/patients/search', { mrn: mrn.value.trim(), last_name: last.value.trim() });
      mount(results, list.length ? h('div.table-wrap', h('table.table',
        h('thead', h('tr', h('th', 'Patient'), h('th', 'MRN'), h('th', 'DOB'), h('th', 'Sex'), h('th', ''))),
        h('tbody', list.map(p => h('tr',
          h('td.strong', patientName(p)), h('td', p.mrn), h('td', fmtDate(p.dob)), h('td', p.sex || ''),
          h('td.right', h('button.btn.small.primary', { type: 'button', onclick: () => start(p) }, 'Start form'))))))) :
        h('div.empty', 'No matching patient. Search is exact (full MRN or full last name). Enter the patient below.'));
      if (!list.length) { f.mrn.value = mrn.value.trim(); f.last_name.value = last.value.trim(); }
    } catch (err) { mount(results, h('div.alert.error', err.message)); }
  }

  async function create(e) {
    e.preventDefault();
    error.hidden = true;
    try {
      const patient = await post('/patients', {
        mrn: f.mrn.value.trim(), last_name: f.last_name.value.trim(), first_name: f.first_name.value.trim(), dob: f.dob.value, sex: f.sex.value,
      });
      if (!patient.created) toast('A patient with this MRN already exists; using the existing record.', 'info');
      await start(patient, f.description.value.trim(), f.accession.value.trim());
    } catch (err) { error.hidden = false; error.textContent = err.message; }
  }

  const lbl = (id, text) => h('label.label', { for: id }, text);
  mount(root, h('div.page.narrow',
    h('div.page-head', h('div', h('a.back', { href: '#/tech' }, '← Worklist'), h('h1', 'New patient'))),
    h('section.panel',
      h('h2', 'Find an existing patient'),
      h('form.inline-form', { onsubmit: search },
        h('div', lbl('s-mrn', 'MRN'), mrn), h('div', lbl('s-last', 'Last name'), last),
        h('button.btn.primary', { type: 'submit' }, 'Search')),
      results),
    h('section.panel',
      h('h2', 'Or enter a new patient'),
      error,
      h('form', { onsubmit: create },
        h('div.grid-2',
          h('div', lbl('n-mrn', 'MRN *'), f.mrn),
          h('div', lbl('n-acc', 'Accession'), f.accession),
          h('div', lbl('n-last', 'Last name *'), f.last_name),
          h('div', lbl('n-first', 'First name'), f.first_name),
          h('div', lbl('n-dob', 'Date of birth'), f.dob),
          h('div', lbl('n-sex', 'Sex'), f.sex),
          h('div.span-2', lbl('n-desc', 'Study description'), f.description)),
        h('div.row-actions', h('button.btn.primary', { type: 'submit' }, 'Continue to form'))))));
  mrn.focus();
}

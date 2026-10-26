// SPDX-License-Identifier: GPL-3.0-or-later

import { h, mount, toast, modal, fmtDateTime } from '../dom.js';
import { get, post, put } from '../api.js';

export const NEW_FORM_TEMPLATE = `# New form. See the "Help" button for the full syntax.
id: my-new-form
title: My new form
description: Short description shown to technologists
study_match:
  - WORDS FROM STUDY DESCRIPTION

sections:
  - id: organ
    title: Organ
    fields:
      - id: organ_size
        type: dims
        label: Size
        required: true
      - id: organ_echo
        type: choice
        label: Echotexture
        required: true
        normal: normal
        options:
          - { value: normal, label: Normal, text: normal in echotexture }
          - { value: abnormal, label: Abnormal, text: abnormal in echotexture }
        other: true
    report: |
      ORGAN: Measures {{organ_size}} and is {{organ_echo}}.
`;

export async function render({ root, session, navigate }) {
  const box = h('div', h('div.loading', 'Loading…'));
  let data;

  async function load() {
    data = await get('/forms');
    draw();
  }

  const activeInst = session.institution_id;

  function row(f) {
    const isGeneral = f.institution_id === null;
    const disabledHere = isGeneral && data.disabled.some(d => d.form_id === f.id && d.institution_id === activeInst);
    return h('tr.clickable', { onclick: (e) => { if (!e.target.closest('button, input, label')) navigate(`/forms/${f.id}`); } },
      h('td', h('div.strong', f.title), h('div.muted.small.mono', f.slug)),
      h('td', f.current_version ? `v${f.current_version}` : h('span.muted', 'never published'), f.draft_version ? h('span.badge.accent', `draft v${f.draft_version}`) : null),
      h('td.muted.small', fmtDateTime(f.updated_at)),
      h('td', f.active ? (disabledHere ? h('span.badge', 'Off here') : h('span.badge.status-submitted', 'Active')) : h('span.badge', 'Inactive')),
      h('td.right.nowrap', h('div.cell-actions',
        isGeneral && activeInst ? h('label.check.small', { title: 'Show this form to technologists at your current institution' },
          h('input', { type: 'checkbox', checked: !disabledHere, onchange: async (e) => {
            try { await put(`/forms/${f.id}/institution-setting`, { institution_id: activeInst, enabled: e.target.checked }); await load(); } catch (err) { toast(err.message, 'error'); e.target.checked = !e.target.checked; }
          } }), ' Use here') : null,
        isGeneral && f.current_version_id ? h('button.btn.small', { type: 'button', onclick: () => copyForm(f) }, 'Copy to institution') : null,
        h('button.btn.small', { type: 'button', onclick: () => navigate(`/forms/${f.id}`) }, isGeneral && !data.can_edit_general ? 'View' : 'Edit'))));
  }

  function table(list) {
    return list.length ? h('div.table-wrap', h('table.table',
      h('thead', h('tr', h('th', 'Form'), h('th', 'Version'), h('th', 'Updated'), h('th', 'Status'), h('th', ''))),
      h('tbody', list.map(row)))) : h('div.empty.small', 'No forms yet.');
  }

  function draw() {
    const general = data.forms.filter(f => f.institution_id === null);
    const parts = [];
    for (const inst of data.institutions) {
      const list = data.forms.filter(f => f.institution_id === inst.id);
      parts.push(h('section.panel',
        h('div.panel-head', h('h2', inst.name), h('button.btn.small', { type: 'button', onclick: () => newForm(inst.id) }, '+ New form')),
        table(list)));
    }
    parts.push(h('section.panel',
      h('div.panel-head', h('div', h('h2', 'General library'), h('p.muted.small', 'Shared starter forms available to every institution. Copy one to your institution to customize it.')),
        data.can_edit_general ? h('button.btn.small', { type: 'button', onclick: () => newForm(null) }, '+ New general form') : null),
      table(general)));
    mount(box, parts);
  }

  async function newForm(institutionId) {
    const file = h('input', { type: 'file', accept: '.yaml,.yml,.json,text/yaml' });
    const choice = await modal({
      title: 'New form',
      body: [h('p', 'Start from a blank template, or upload a form file (YAML) exported from another installation.'), file],
      actions: [{ label: 'Cancel', value: null }, { label: 'Upload file', value: 'upload' }, { label: 'Blank template', value: 'blank', primary: true }],
    });
    if (!choice) return;
    let source = NEW_FORM_TEMPLATE;
    if (choice === 'upload') {
      if (!file.files[0]) return toast('Choose a file first', 'error');
      source = await file.files[0].text();
    } else {
      source = source.replace('my-new-form', `my-new-form-${Date.now().toString(36).slice(-4)}`);
    }
    try {
      const r = await post('/forms', { institution_id: institutionId, source });
      navigate(`/forms/${r.id}`);
    } catch (e) {
      toast(e.message, 'error', 8000);
    }
  }

  async function copyForm(f) {
    const insts = data.institutions;
    if (!insts.length) return toast('You are not assigned to any institution.', 'error');
    const sel = h('select.input', insts.map(i => h('option', { value: i.id, selected: i.id === activeInst }, i.name)));
    const ok = await modal({
      title: `Copy "${f.title}"`,
      body: [h('p', 'The copy starts as a draft you can edit. When you publish it, it replaces the general version for that institution.'), h('label.label', 'Institution'), sel],
      actions: [{ label: 'Cancel', value: false }, { label: 'Copy', value: true, primary: true }],
    });
    if (!ok) return;
    try {
      const r = await post(`/forms/${f.id}/copy`, { institution_id: Number(sel.value) });
      toast('Copied. Edit and publish when ready.', 'success');
      navigate(`/forms/${r.id}`);
    } catch (e) { toast(e.message, 'error', 8000); }
  }

  mount(root, h('div.page',
    h('div.page-head', h('div', h('h1', 'Forms'), h('p.muted', 'What technologists fill in, and the findings text it produces.')),
      h('div.page-actions', h('a.btn', { href: '/help.html?doc=FORMS', target: '_blank', rel: 'noopener' }, 'Form writing guide'))),
    box));
  await load();
}

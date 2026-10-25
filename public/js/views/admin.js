// SPDX-License-Identifier: GPL-3.0-or-later
//
// Administration: status, users, institutions (PACS), audit log, settings, backups.

import { h, mount, toast, modal, confirmDialog, fmtDateTime, downloadUrl, copyText } from '../dom.js';
import { get, post, put } from '../api.js';

const TABS = [
  ['status', 'Status'], ['users', 'Users'], ['institutions', 'Institutions'], ['audit', 'Audit log'], ['settings', 'Settings'], ['backups', 'Backups'],
];

export async function render({ root, params, session, navigate, refreshSession }) {
  const tab = TABS.some(t => t[0] === params[0]) ? params[0] : 'status';
  const body = h('div.admin-body', h('div.loading', 'Loading…'));
  mount(root, h('div.page.wide',
    h('div.page-head', h('h1', 'Administration')),
    h('nav.subtabs', TABS.map(([id, label]) => h(`a.subtab${id === tab ? '.active' : ''}`, { href: `#/admin/${id}` }, label))),
    body));
  const views = { status, users, institutions, audit, settings, backups };
  try {
    await views[tab](body, { session, navigate, refreshSession });
  } catch (e) {
    mount(body, h('div.alert.error', e.message));
  }
}

const bytes = n => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} kB`);

// ---- Status ---------------------------------------------------------------

async function status(box) {
  const s = await get('/admin/status');
  const c = s.counts;
  const tile = (label, value, extra) => h('div.tile', h('div.tile-value', String(value)), h('div.tile-label', label), extra ? h('div.muted.small', extra) : null);
  const backupWarn = !s.backups.configured
    ? h('div.alert.warn', 'Automatic backups are not configured. Use Backups › Download backup regularly, or set BACKUP_DIR (the Docker setup does this for you).')
    : !s.backups.latest || (Date.now() - new Date(s.backups.latest.mtime)) > 2 * 86400000
      ? h('div.alert.warn', 'No backup has been made in the last 2 days. Check the Backups tab.')
      : null;
  mount(box,
    s.dicom_mock ? h('div.alert.warn', 'DICOM_MOCK is on: worklists show fake demo studies. Turn it off for real use.') : null,
    backupWarn,
    h('div.tiles',
      tile('Ready to dictate', c.exams_submitted), tile('Forms in progress', c.exams_draft), tile('Dictated', c.exams_dictated),
      tile('Active users', c.users), tile('Signed in now', c.sessions), tile('Institutions', c.institutions), tile('Active forms', c.forms),
      tile('Audit entries', c.audit_entries), tile('Database size', bytes(c.db_bytes))),
    h('section.panel', h('h2', 'System'), h('table.kv', h('tbody',
      h('tr', h('th', 'Version'), h('td', s.version)),
      h('tr', h('th', 'Node.js'), h('td', s.node)),
      h('tr', h('th', 'Database'), h('td', String(c.pg_version).split(' on ')[0])),
      h('tr', h('th', 'Uptime'), h('td', `${Math.floor(s.uptime_seconds / 3600)} h ${Math.floor(s.uptime_seconds / 60) % 60} min`)),
      h('tr', h('th', 'Last backup'), h('td', s.backups.latest ? `${fmtDateTime(s.backups.latest.mtime)} (${bytes(s.backups.latest.size)})` : 'none')),
      h('tr', h('th', 'Database migrations'), h('td', s.migrations.map(m => m.name).join(', ')))))));
}

// ---- Users ----------------------------------------------------------------

function showPassword(username, password) {
  return modal({
    title: 'Temporary password',
    body: [
      h('p', `Give this temporary password to ${username}. They must choose a new one when they sign in.`),
      h('div.password-show', password),
      h('p.muted.small', 'It will not be shown again.'),
    ],
    actions: [{ label: 'Copy', onClick: async () => { await copyText(password); toast('Copied', 'success'); return false; }, keepOpen: true }, { label: 'Done', primary: true }],
  });
}

async function users(box, { session }) {
  const [{ users: list, roles }, { institutions: insts }] = await Promise.all([get('/admin/users'), get('/admin/institutions')]);
  const filter = h('input.input.search', { type: 'search', placeholder: 'Filter users…' });
  const tableBox = h('div');
  const instName = id => insts.find(i => i.id === id)?.code || id;
  const roleLabel = r => roles.find(x => x.id === r)?.label || r;

  const draw = () => {
    const q = filter.value.trim().toLowerCase();
    const rows = list.filter(u => !q || u.username.toLowerCase().includes(q) || u.display_name.toLowerCase().includes(q));
    mount(tableBox, h('div.table-wrap', h('table.table',
      h('thead', h('tr', h('th', 'Name'), h('th', 'Roles'), h('th', 'Institutions'), h('th', 'Last sign-in'), h('th', 'Status'), h('th', ''))),
      h('tbody', rows.map(u => h('tr',
        h('td', h('div.strong', u.display_name), h('div.muted.small.mono', u.username)),
        h('td', u.roles.map(r => h('span.badge', roleLabel(r)))),
        h('td.small', u.roles.includes('superuser') ? h('span.muted', 'all') : u.institution_ids.map(instName).join(', ') || h('span.muted', 'none')),
        h('td.small', u.last_login_at ? fmtDateTime(u.last_login_at) : h('span.muted', 'never')),
        h('td', !u.active ? h('span.badge', 'Inactive')
          : u.locked ? h('span.badge.status-returned', 'Locked out')
            : u.must_change_password ? (u.temp_password_expires_at && new Date(u.temp_password_expires_at) < new Date() ? h('span.badge.status-returned', 'Temp password expired') : h('span.badge.accent', 'Temp password'))
              : h('span.badge.status-submitted', 'Active')),
        h('td.right', h('button.btn.small', { type: 'button', onclick: () => edit(u) }, 'Edit'))))))));
  };

  function userForm(u) {
    const f = {
      username: h('input.input', { value: u?.username || '', disabled: !!u, autocomplete: 'off', id: 'uf-u' }),
      display_name: h('input.input', { value: u?.display_name || '', autocomplete: 'off', id: 'uf-n' }),
      roles: roles.map(r => h('input', { type: 'checkbox', value: r.id, checked: u ? u.roles.includes(r.id) : r.id === 'tech', disabled: r.id === 'superuser' && !session.can.superuser })),
      insts: insts.map(i => h('input', { type: 'checkbox', value: i.id, checked: u ? u.institution_ids.includes(i.id) : insts.length === 1 })),
      active: h('input', { type: 'checkbox', checked: u ? u.active : true }),
    };
    const el = h('div.form-stack',
      h('label.label', { for: 'uf-u' }, 'Username'), f.username,
      h('label.label', { for: 'uf-n' }, 'Full name'), f.display_name,
      h('div.label', 'Roles'),
      h('div.check-list', roles.map((r, i) => h('label.check', f.roles[i], ` ${r.label}`))),
      h('p.hint', 'Technologist: fill in forms. Tech manager: also edit forms. Radiologist: reading worklist. Administrator: this admin area. Superuser: everything, at every institution. Clinical access is limited to the institutions ticked below.'),
      h('div.label', 'Institutions'),
      h('div.check-list', insts.map((i, idx) => h('label.check', f.insts[idx], ` ${i.name}`))),
      u ? h('label.check', f.active, ' Account active') : null);
    const values = () => ({
      ...(u ? {} : { username: f.username.value.trim() }),
      display_name: f.display_name.value.trim(),
      roles: f.roles.filter(x => x.checked).map(x => x.value),
      institution_ids: f.insts.filter(x => x.checked).map(x => Number(x.value)),
      ...(u ? { active: f.active.checked } : {}),
    });
    return { el, values };
  }

  async function add() {
    const form = userForm(null);
    await modal({
      title: 'New user', body: form.el,
      actions: [{ label: 'Cancel' }, {
        label: 'Create user', primary: true,
        onClick: async (close) => {
          try {
            const v = form.values();
            const r = await post('/admin/users', v);
            close();
            await showPassword(v.username, r.temporary_password);
            await users(box, { session });
          } catch (e) { toast(e.message, 'error'); }
          return false;
        },
      }],
    });
  }

  async function edit(u) {
    const form = userForm(u);
    await modal({
      title: `Edit ${u.display_name}`, body: form.el,
      actions: [
        { label: 'Reset password', onClick: async (close) => {
          if (!(await confirmDialog('Reset password?', `${u.display_name} will be signed out and must use a new temporary password.`, { confirmLabel: 'Reset' }))) return false;
          try { const r = await post(`/admin/users/${u.id}/reset-password`); close(); await showPassword(u.username, r.temporary_password); await users(box, { session }); } catch (e) { toast(e.message, 'error'); }
          return false;
        } },
        u.locked ? { label: 'Unlock', onClick: async (close) => { await post(`/admin/users/${u.id}/unlock`); close(); toast('Unlocked', 'success'); await users(box, { session }); return false; } } : null,
        { label: 'Sign out everywhere', onClick: async () => { const r = await post(`/admin/users/${u.id}/sign-out`); toast(`Ended ${r.sessions} session(s)`, 'success'); return false; } },
        { label: 'Save', primary: true, onClick: async (close) => {
          try { await put(`/admin/users/${u.id}`, form.values()); close(); toast('Saved', 'success'); await users(box, { session }); } catch (e) { toast(e.message, 'error'); }
          return false;
        } },
      ].filter(Boolean),
    });
  }

  filter.addEventListener('input', draw);
  mount(box, h('div.toolbar', filter, h('button.btn.primary', { type: 'button', onclick: add }, '+ New user')), tableBox);
  draw();
}

// ---- Institutions -----------------------------------------------------------

async function institutions(box, { refreshSession }) {
  const { institutions: list, dicom_keys: keys, dicom_mock: mock } = await get('/admin/institutions');

  function dicomEditor(d = {}) {
    const f = {
      enabled: h('input', { type: 'checkbox', checked: !!d.enabled }),
      host: h('input.input', { value: d.host || '', placeholder: 'pacs.hospital.local or 10.0.0.5', id: 'd-host' }),
      port: h('input.input', { value: d.port || 104, inputmode: 'numeric', id: 'd-port' }),
      called_ae: h('input.input', { value: d.called_ae || '', placeholder: 'PACS AE title', id: 'd-cae', maxlength: 16 }),
      calling_ae: h('input.input', { value: d.calling_ae || 'SONOFORMS', id: 'd-sae', maxlength: 16 }),
      modality: h('input.input', { value: d.modality ?? 'US', id: 'd-mod' }),
      modality_key: h('select.input', { id: 'd-modkey' },
        h('option', { value: 'ModalitiesInStudy', selected: (d.modality_key || 'ModalitiesInStudy') === 'ModalitiesInStudy' }, 'Modalities in Study (most PACS)'),
        h('option', { value: 'Modality', selected: d.modality_key === 'Modality' }, 'Modality')),
      date_mode: h('select.input', { id: 'd-date' },
        h('option', { value: 'range', selected: d.date_mode !== 'single' }, 'Date range (most PACS)'),
        h('option', { value: 'single', selected: d.date_mode === 'single' }, 'One day at a time')),
      max_results: h('input.input', { value: d.max_results || 500, inputmode: 'numeric', id: 'd-max' }),
    };
    const filters = (d.filters || []).map(x => ({ ...x }));
    const filterBox = h('div');
    const drawFilters = () => mount(filterBox,
      filters.map((flt, i) => h('div.filter-row',
        h('select.input', { onchange: (e) => { flt.tag = e.target.value; } }, keys.map(k => h('option', { value: k, selected: k === flt.tag }, k))),
        h('input.input', { value: flt.value || '', placeholder: 'e.g. GENERAL HOSP*', oninput: (e) => { flt.value = e.target.value; } }),
        h('select.input', { onchange: (e) => { flt.mode = e.target.value; } },
          h('option', { value: 'query', selected: flt.mode !== 'local' }, 'Ask PACS to filter'),
          h('option', { value: 'local', selected: flt.mode === 'local' }, 'Filter results here')),
        h('button.btn.small.ghost', { type: 'button', onclick: () => { filters.splice(i, 1); drawFilters(); } }, 'Remove'))),
      h('button.btn.small', { type: 'button', onclick: () => { filters.push({ tag: 'InstitutionName', value: '', mode: 'query' }); drawFilters(); } }, '+ Add filter'));
    drawFilters();
    const result = h('div');
    const values = () => ({
      enabled: f.enabled.checked, host: f.host.value.trim(), port: Number(f.port.value) || 104,
      called_ae: f.called_ae.value.trim(), calling_ae: f.calling_ae.value.trim(), modality: f.modality.value.trim(), filters,
      modality_key: f.modality_key.value, date_mode: f.date_mode.value, max_results: Number(f.max_results.value) || 500,
    });
    const el = h('div.form-stack',
      mock ? h('div.alert.warn.small', 'DICOM_MOCK is on, so worklists show demo data whatever is set here. The Test buttons still contact the real PACS.') : null,
      h('label.check', f.enabled, ' Show today’s studies from PACS on the tech worklist'),
      h('div.grid-2',
        h('div', h('label.label', { for: 'd-host' }, 'PACS host'), f.host),
        h('div', h('label.label', { for: 'd-port' }, 'Port'), f.port),
        h('div', h('label.label', { for: 'd-cae' }, 'PACS AE title (called)'), f.called_ae),
        h('div', h('label.label', { for: 'd-sae' }, 'Our AE title (calling)'), f.calling_ae),
        h('div', h('label.label', { for: 'd-mod' }, 'Modality'), f.modality, h('p.hint', 'Usually US. May be left blank only if an institution filter below is applied by PACS.')),
        h('div', h('label.label', { for: 'd-modkey' }, 'Send modality as'), f.modality_key),
        h('div', h('label.label', { for: 'd-date' }, 'Date matching'), f.date_mode, h('p.hint', 'Choose "one day at a time" if your PACS rejects date ranges.')),
        h('div', h('label.label', { for: 'd-max' }, 'Most studies to fetch'), f.max_results, h('p.hint', '50–2000. Larger queries are stopped at this number.'))),
      h('div.label', 'Limit to this institution'),
      h('p.hint', 'Many PACS hold studies for several sites. Add a filter, e.g. InstitutionName = GENERAL HOSP*. If your PACS ignores a filter, switch it to "Filter results here". * matches anything.'),
      filterBox,
      h('p.hint', 'Your PACS administrator must add our AE title, and this server’s IP address, to the PACS as a query (C-FIND) client.'),
      result);
    return { el, values, result };
  }

  async function edit(inst) {
    const name = h('input.input', { value: inst?.name || '', id: 'i-name' });
    const code = h('input.input', { value: inst?.code || '', disabled: !!inst, id: 'i-code', placeholder: 'e.g. GH' });
    const active = h('input', { type: 'checkbox', checked: inst ? inst.active : true });
    const dicom = dicomEditor(inst?.dicom);
    const test = async (kind) => {
      mount(dicom.result, h('div.loading.small', 'Contacting PACS…'));
      try {
        const r = await post(`/admin/institutions/${inst.id}/${kind}`, { dicom: dicom.values() });
        if (kind === 'echo') mount(dicom.result, h(`div.alert.${r.ok ? 'success' : 'error'}`, r.message));
        else mount(dicom.result, r.ok
          ? h(`div.alert.${r.truncated ? 'warn' : 'success'}`, r.truncated ? `Stopped at ${r.count} studies (the limit). Narrow the filter or raise the limit.` : `Found ${r.count} studies.`, h('ul.small', Object.entries(r.descriptions).slice(0, 15).map(([d, n]) => h('li', `${d}: ${n}`))))
          : h('div.alert.error', r.message));
      } catch (e) { mount(dicom.result, h('div.alert.error', e.message)); }
    };
    await modal({
      title: inst ? inst.name : 'New institution', wide: true,
      body: h('div.form-stack',
        h('div.grid-2', h('div', h('label.label', { for: 'i-name' }, 'Name'), name), h('div', h('label.label', { for: 'i-code' }, 'Short code'), code)),
        inst ? h('label.check', active, ' Active') : null,
        h('h3', 'PACS worklist'), dicom.el),
      actions: [
        inst ? { label: 'Test connection', keepOpen: true, onClick: () => { test('echo'); return false; } } : null,
        inst ? { label: 'Test query', keepOpen: true, onClick: () => { test('test-query'); return false; } } : null,
        { label: 'Cancel' },
        { label: 'Save', primary: true, onClick: async (close) => {
          try {
            if (inst) await put(`/admin/institutions/${inst.id}`, { name: name.value.trim(), active: active.checked, dicom: dicom.values() });
            else await post('/admin/institutions', { name: name.value.trim(), code: code.value.trim(), dicom: dicom.values() });
            close();
            toast('Saved', 'success');
            await refreshSession();
            await institutions(box, { refreshSession });
          } catch (e) { toast(e.message, 'error'); }
          return false;
        } },
      ].filter(Boolean),
    });
  }

  mount(box,
    h('div.toolbar', h('p.muted', 'Each institution has its own worklist, patients and forms. Users only see the institutions they are assigned to.'),
      h('button.btn.primary', { type: 'button', onclick: () => edit(null) }, '+ New institution')),
    h('div.table-wrap', h('table.table',
      h('thead', h('tr', h('th', 'Institution'), h('th', 'Code'), h('th', 'PACS'), h('th', 'Users'), h('th', 'Status'), h('th', ''))),
      h('tbody', list.map(i => h('tr',
        h('td.strong', i.name), h('td.mono', i.code),
        h('td.small', i.dicom?.enabled ? `${i.dicom.called_ae}@${i.dicom.host}:${i.dicom.port}` : h('span.muted', 'not configured')),
        h('td', String(i.user_count)),
        h('td', i.active ? h('span.badge.status-submitted', 'Active') : h('span.badge', 'Inactive')),
        h('td.right', h('button.btn.small', { type: 'button', onclick: () => edit(i) }, 'Edit'))))))));
}

// ---- Audit log --------------------------------------------------------------

async function audit(box) {
  const q = { from: '', to: '', user: '', action: '', entity_type: '', entity_id: '' };
  let offset = 0;
  const limit = 100;
  const from = h('input.input', { type: 'date' });
  const to = h('input.input', { type: 'date' });
  const user = h('input.input', { placeholder: 'Username' });
  const action = h('select.input');
  const entity = h('input.input', { placeholder: 'e.g. exam 42' });
  const tableBox = h('div');
  const verifyBox = h('div');
  let actionsLoaded = false;

  const params = () => {
    const [et, eid] = entity.value.trim().split(/\s+/);
    Object.assign(q, { from: from.value, to: to.value, user: user.value.trim(), action: action.value, entity_type: et || '', entity_id: eid || '' });
    return new URLSearchParams(Object.fromEntries(Object.entries(q).filter(([, v]) => v))).toString();
  };

  async function load() {
    const r = await get(`/admin/audit?${params()}&limit=${limit}&offset=${offset}`);
    if (!actionsLoaded) {
      mount(action, h('option', { value: '' }, 'All actions'), r.actions.map(a => h('option', { value: a }, a)));
      actionsLoaded = true;
    }
    mount(tableBox,
      h('div.table-wrap', h('table.table.audit',
        h('thead', h('tr', h('th', 'Time'), h('th', 'User'), h('th', 'Site'), h('th', 'Action'), h('th', 'Record'), h('th', 'Details'), h('th', 'IP'))),
        h('tbody', r.rows.map(a => h('tr',
          h('td.nowrap.small', new Date(a.at).toLocaleString()),
          h('td', a.username || h('span.muted', 'system')),
          h('td.small', a.institution_code || ''),
          h('td', h('code', a.action)),
          h('td.small', a.entity_type ? `${a.entity_type} ${a.entity_id ?? ''}` : ''),
          h('td.small.details', a.details ? JSON.stringify(a.details) : ''),
          h('td.small.mono', a.ip || '')))))),
      h('div.pager',
        h('button.btn.small', { type: 'button', disabled: offset === 0, onclick: () => { offset = Math.max(0, offset - limit); load(); } }, '← Newer'),
        h('span.muted.small', `${r.total ? offset + 1 : 0}–${Math.min(offset + limit, r.total)} of ${r.total}`),
        h('button.btn.small', { type: 'button', disabled: offset + limit >= r.total, onclick: () => { offset += limit; load(); } }, 'Older →')));
  }

  async function verify() {
    mount(verifyBox, h('div.loading.small', 'Checking every entry…'));
    const r = await get('/admin/audit/verify');
    mount(verifyBox, r.ok
      ? h('div.alert.success',
        h('div', `✓ The audit log is intact (${r.checked} entries checked). No entries have been altered or removed.`),
        r.head ? h('div.small', 'For an independent record, note the newest entry: ', h('code', `#${r.head.id} ${r.head.hash.slice(0, 16)}…`)) : null)
      : h('div.alert.error', `✖ The audit log failed its integrity check at entry ${r.brokenAt}. ${r.reason || ''} Contact your security officer.`));
  }

  mount(box,
    h('p.muted', 'Every sign-in, record view, change and export is recorded here. The application can only add entries, never edit or delete them, and each entry is sealed to the previous one with a key derived from the master key, so tampering is detectable. The check also runs every night.'),
    h('div.audit-filters',
      h('label.small', 'From ', from), h('label.small', 'To ', to), user, action, entity,
      h('button.btn', { type: 'button', onclick: () => { offset = 0; load(); } }, 'Search'),
      h('button.btn', { type: 'button', onclick: () => downloadUrl(`/api/admin/audit/export?${params()}`) }, 'Export CSV'),
      h('button.btn', { type: 'button', onclick: verify }, 'Verify integrity')),
    verifyBox, tableBox);
  await load();
}

// ---- Settings ---------------------------------------------------------------

async function settings(box, { refreshSession }) {
  const { settings: s } = await get('/admin/settings');
  const fields = [
    ['app_name', 'Application name', 'text', 'Shown in the header and browser tab.'],
    ['login_banner', 'Sign-in notice', 'text', 'Shown under the sign-in form.'],
    ['session_idle_minutes', 'Sign out after inactivity (minutes)', 'number', 'Shared scanner workstations: keep this short.'],
    ['session_max_hours', 'Maximum session length (hours)', 'number', ''],
    ['password_min_length', 'Minimum password length', 'number', ''],
    ['max_failed_logins', 'Failed sign-ins before a pause', 'number', 'Counted per user and per computer.'],
    ['lockout_minutes', 'Longest pause after failed sign-ins (minutes)', 'number', 'Pauses start at 1 minute and double with each further failure, up to this.'],
    ['worklist_show_hours', 'PACS worklist look-back (hours)', 'number', 'How far back the tech worklist looks for studies.'],
    ['retention_days', 'Delete dictated exams after (days)', 'number', '0 keeps everything. Deleted exams cannot be recovered except from backups.'],
    ['report_line_ending', 'Copied text line endings', 'select:crlf=Windows (CRLF, most dictation systems)|lf=Unix (LF)', ''],
  ];
  const inputs = {};
  const el = h('form.settings-form', {
    onsubmit: async (e) => {
      e.preventDefault();
      const body = {};
      for (const [key, , type] of fields) body[key] = type === 'number' ? Number(inputs[key].value) : inputs[key].value;
      try { await put('/admin/settings', body); toast('Settings saved', 'success'); await refreshSession(); } catch (err) { toast(err.message, 'error', 6000); }
    },
  }, fields.map(([key, label, type, hint]) => {
    let input;
    if (type.startsWith('select:')) {
      input = h('select.input', type.slice(7).split('|').map(o => { const [v, l] = o.split('='); return h('option', { value: v, selected: s[key] === v }, l); }));
    } else {
      input = h('input.input', { type, value: s[key] ?? '', id: `s-${key}` });
    }
    inputs[key] = input;
    return h('div.setting', h('label.label', { for: `s-${key}` }, label), input, hint ? h('p.hint', hint) : null);
  }), h('div.row-actions', h('button.btn.primary', { type: 'submit' }, 'Save settings')));
  mount(box, h('section.panel', el));
}

// ---- Backups ----------------------------------------------------------------

async function backups(box) {
  const r = await get('/admin/backups');
  mount(box,
    h('section.panel',
      h('h2', 'Download a backup now'),
      h('p', 'The backup file is encrypted with this installation’s master key. To restore it you need both the file and the master key (in the secrets/ folder of the installation). Keep a copy of the master key somewhere safe and separate, such as a locked password manager: without it, backups cannot be read.'),
      h('button.btn.primary', { type: 'button', onclick: () => downloadUrl('/api/admin/backup') }, 'Download backup')),
    h('section.panel',
      h('div.panel-head', h('h2', 'Automatic backups'),
        r.dir ? h('button.btn', { type: 'button', onclick: async () => { try { const x = await post('/admin/backups'); toast(`Backup ${x.file} created`, 'success'); backups(box); } catch (e) { toast(e.message, 'error'); } } }, 'Back up now') : null),
      r.dir
        ? h('p.muted', 'A backup is written every night and the most recent ones are kept. Copy them off this server regularly (e.g. to a network share), because a backup on the same disk won’t survive a disk failure.')
        : h('div.alert.warn', 'Automatic backups are not configured (BACKUP_DIR is not set).'),
      r.files.length ? h('div.table-wrap', h('table.table',
        h('thead', h('tr', h('th', 'File'), h('th', 'Created'), h('th', 'Size'), h('th', ''))),
        h('tbody', r.files.map(f => h('tr', h('td.mono.small', f.name), h('td', fmtDateTime(f.mtime)), h('td', bytes(f.size)),
          h('td.right', h('button.btn.small', { type: 'button', onclick: () => downloadUrl(`/api/admin/backups/${encodeURIComponent(f.name)}`) }, 'Download'))))))) : null),
    h('section.panel',
      h('h2', 'Restoring'),
      h('p', 'For safety, restoring is done on the server, not in the browser. See docs/ADMIN.md, or run:'),
      h('pre.code-view', './manage.sh restore backups/sonoforms-YYYY-MM-DD.sfbak')));
}

// SPDX-License-Identifier: GPL-3.0-or-later
//
// App shell: session, routing, header/navigation, theme and idle timeout.
// Each view module exports render(ctx) and may return a cleanup function.

import { h, mount, toast, modal } from './dom.js';
import { get, post, put, setCsrf, setUnauthorizedHandler } from './api.js';
import { renderLogin, renderPasswordChange } from './views/login.js';

const app = document.getElementById('app');
let session = null;
let cleanup = null;

// Route table: pattern -> { view (lazy import), workflow, allowed(capabilities) }
const ROUTES = [
  { re: /^\/tech$/, load: () => import('./views/tech-worklist.js'), workflow: 'tech', need: 'tech' },
  { re: /^\/tech\/new$/, load: () => import('./views/tech-new.js'), workflow: 'tech', need: 'tech' },
  { re: /^\/tech\/history$/, load: () => import('./views/tech-history.js'), workflow: 'tech', need: 'tech' },
  { re: /^\/exam\/(\d+)$/, load: () => import('./views/tech-exam.js'), workflow: 'tech', need: 'tech' },
  { re: /^\/rad$/, load: () => import('./views/rad-worklist.js'), workflow: 'rad', need: 'rad' },
  { re: /^\/rad\/exam\/(\d+)$/, load: () => import('./views/rad-exam.js'), workflow: 'rad', need: 'rad' },
  { re: /^\/forms$/, load: () => import('./views/forms-list.js'), workflow: 'forms', need: 'forms' },
  { re: /^\/forms\/(\d+)$/, load: () => import('./views/forms-editor.js'), workflow: 'forms', need: 'forms' },
  { re: /^\/admin(?:\/(\w+))?$/, load: () => import('./views/admin.js'), workflow: 'admin', need: 'admin' },
];

const WORKFLOWS = [
  { id: 'tech', label: 'Tech worklist', href: '#/tech', need: 'tech' },
  { id: 'rad', label: 'Radiologist', href: '#/rad', need: 'rad' },
  { id: 'forms', label: 'Forms', href: '#/forms', need: 'forms' },
  { id: 'admin', label: 'Admin', href: '#/admin', need: 'admin' },
];

// Bright scan rooms get a light theme; dark reading rooms get a dark one.
const DEFAULT_THEME = { tech: 'light', rad: 'dark', forms: 'light', admin: 'light' };

function applyTheme(workflow) {
  const pref = session?.user?.preferences?.theme || 'auto';
  const theme = pref === 'auto' ? (DEFAULT_THEME[workflow] || 'light') : pref;
  document.documentElement.dataset.theme = theme;
}

export function navigate(path) {
  if (location.hash === `#${path}`) route();
  else location.hash = path;
}

async function loadSession() {
  session = await get('/session');
  setCsrf(session.csrf || null);
  if (session.settings?.app_name || session.app_name) document.title = session.settings?.app_name || session.app_name;
  return session;
}

function defaultPath() {
  const c = session.can || {};
  if (c.tech && !c.rad) return '/tech';
  if (c.rad) return '/rad';
  if (c.tech) return '/tech';
  if (c.forms) return '/forms';
  if (c.admin) return '/admin';
  return '/none';
}

async function route() {
  if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
  const path = location.hash.replace(/^#/, '') || '/';

  if (!session?.user) {
    document.documentElement.dataset.theme = 'light';
    return renderLogin(app, { onLogin: async () => { await loadSession(); startIdleTimer(); route(); } });
  }
  if (session.user.must_change_password) {
    applyTheme('tech');
    return renderPasswordChange(app, { session, forced: true, onDone: async () => { await loadSession(); route(); } });
  }
  if (path === '/' || path === '') return navigate(defaultPath());

  const match = ROUTES.map(r => ({ r, m: r.re.exec(path) })).find(x => x.m);
  if (!match) return renderShell('none', h('div.page', h('div.empty', h('h2', 'Nothing here'), h('p', 'You may not have any roles assigned yet. Ask an administrator.'))));
  if (!session.can[match.r.need]) return navigate(defaultPath());

  applyTheme(match.r.workflow);
  const content = h('main.content', { id: 'content', tabindex: '-1' });
  renderShell(match.r.workflow, content);
  try {
    const mod = await match.r.load();
    const result = await mod.render({ root: content, session, params: match.m.slice(1), navigate, refreshSession, setTheme: applyTheme });
    if (typeof result === 'function') cleanup = result;
  } catch (e) {
    mount(content, h('div.page', h('div.alert.error', e.message || String(e))));
    console.error(e);
  }
}

async function refreshSession() {
  await loadSession();
}

function renderShell(workflow, content) {
  const c = session.can;
  const tabs = WORKFLOWS.filter(w => c[w.need]);
  const instSelect = session.institutions.length > 1
    ? h('select.inst-select', {
      'aria-label': 'Institution',
      onchange: async (e) => {
        try {
          await post('/session/institution', { institution_id: Number(e.target.value) });
          await loadSession();
          route();
        } catch (err) { toast(err.message, 'error'); }
      },
    }, session.institutions.map(i => h('option', { value: i.id, selected: i.id === session.institution_id }, i.name)))
    : h('span.inst-name', session.institutions[0]?.name || 'No institution');

  const header = h('header.topbar',
    h('a.brand', { href: '#/' }, h('span.brand-mark', { 'aria-hidden': 'true' }), session.settings.app_name),
    tabs.length > 1 ? h('nav.tabs', tabs.map(t => h(`a.tab${t.id === workflow ? '.active' : ''}`, { href: t.href }, t.label))) : h('div.spacer'),
    h('div.topbar-right',
      instSelect,
      h('button.user-btn', { type: 'button', onclick: openUserMenu, 'aria-haspopup': 'dialog' },
        h('span.avatar', initials(session.user.display_name)), h('span.user-name', session.user.display_name)),
    ),
  );
  mount(app, header, content);
}

function initials(name) {
  return String(name || '?').split(/\s+/).map(s => s[0]).slice(0, 2).join('').toUpperCase();
}

function openUserMenu() {
  const pref = session.user.preferences?.theme || 'auto';
  const themeSel = h('select.input', {
    onchange: async (e) => {
      await put('/session/preferences', { theme: e.target.value });
      session.user.preferences = { ...session.user.preferences, theme: e.target.value };
      const r = ROUTES.find(x => x.re.test(location.hash.slice(1)));
      applyTheme(r?.workflow || 'tech');
    },
  }, [['auto', 'Automatic (light for techs, dark for reading)'], ['light', 'Always light'], ['dark', 'Always dark']]
    .map(([v, l]) => h('option', { value: v, selected: v === pref }, l)));
  modal({
    title: session.user.display_name,
    body: [
      h('p.muted', `Signed in as ${session.user.username} · ${session.user.role_labels.join(', ')}`),
      h('label.label', 'Color scheme'), themeSel,
      h('p.muted.small', `${session.settings.app_name} ${session.version} · GPL-3.0`),
    ],
    actions: [
      { label: 'Change password', onClick: async (close) => { close(); const content = document.getElementById('content'); if (content) renderPasswordChange(content, { session, forced: false, onDone: () => { toast('Password changed', 'success'); route(); } }); return false; } },
      { label: 'Sign out', danger: true, onClick: async (close) => { close(); await logout(); return false; } },
    ],
  });
}

async function logout(message) {
  try { await post('/auth/logout'); } catch { /* ignore */ }
  session = { user: null };
  setCsrf(null);
  location.hash = '';
  stopIdleTimer();
  if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
  renderLogin(app, { message, onLogin: async () => { await loadSession(); startIdleTimer(); route(); } });
}

// ---- Idle timeout ---------------------------------------------------------
// The server enforces the timeout; this just warns the user and keeps the
// session alive while they're actively working.

let lastActivity = Date.now();
let lastPing = Date.now();
let idleTimer = null;
let warning = null;

function onActivity() {
  lastActivity = Date.now();
  if (warning) { warning.remove(); warning = null; }
  if (Date.now() - lastPing > 120000 && session?.user) {
    lastPing = Date.now();
    get('/session').catch(() => {});
  }
}

function startIdleTimer() {
  stopIdleTimer();
  lastActivity = Date.now();
  ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(ev => window.addEventListener(ev, onActivity, { passive: true }));
  idleTimer = setInterval(() => {
    if (!session?.user) return;
    const limit = (session.settings?.session_idle_minutes || 60) * 60000;
    const idle = Date.now() - lastActivity;
    if (idle > limit) {
      logout('You were signed out after a period of inactivity.');
    } else if (idle > limit - 120000 && !warning) {
      warning = document.body.appendChild(h('div.idle-warning', { role: 'alert' }, 'You will be signed out soon due to inactivity. Move the mouse or press a key to stay signed in.'));
    }
  }, 10000);
}

function stopIdleTimer() {
  if (idleTimer) clearInterval(idleTimer);
  idleTimer = null;
  ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(ev => window.removeEventListener(ev, onActivity));
  if (warning) { warning.remove(); warning = null; }
}

setUnauthorizedHandler(() => {
  if (session?.user) logout('Your session has ended. Please sign in again.');
});

window.addEventListener('hashchange', route);

(async () => {
  try {
    await loadSession();
    if (session.user) startIdleTimer();
  } catch (e) {
    mount(app, h('div.page', h('div.alert.error', `Cannot reach the server: ${e.message}`)));
    return;
  }
  if (!session.user && session.expired) {
    return renderLogin(app, { message: 'Your session expired. Please sign in again.', onLogin: async () => { await loadSession(); startIdleTimer(); route(); } });
  }
  route();
})();

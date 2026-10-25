// SPDX-License-Identifier: GPL-3.0-or-later

import { h, mount } from '../dom.js';
import { get, post } from '../api.js';

export async function renderLogin(root, { onLogin, message } = {}) {
  let info = { app_name: 'SonoForms', login_banner: '' };
  try { info = await get('/public-info'); } catch { /* server unreachable; form still renders */ }
  document.title = info.app_name;
  const error = h('div.alert.error', { hidden: !message, role: 'alert' }, message || '');
  if (message) error.className = 'alert info';
  const username = h('input.input', { name: 'username', autocomplete: 'username', required: true, autofocus: true, autocapitalize: 'off', spellcheck: 'false' });
  const password = h('input.input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true });
  const button = h('button.btn.primary.block', { type: 'submit' }, 'Sign in');

  const form = h('form.login-card', {
    onsubmit: async (e) => {
      e.preventDefault();
      button.disabled = true;
      button.textContent = 'Signing in…';
      try {
        await post('/auth/login', { username: username.value, password: password.value });
        await onLogin();
      } catch (err) {
        error.hidden = false;
        error.className = 'alert error';
        error.textContent = err.message;
        password.value = '';
        password.focus();
      } finally {
        button.disabled = false;
        button.textContent = 'Sign in';
      }
    },
  },
  h('div.login-brand', h('span.brand-mark.big', { 'aria-hidden': 'true' }), h('h1', info.app_name)),
  h('p.muted', 'Ultrasound worksheets'),
  error,
  h('label.label', { for: 'u' }, 'Username'), Object.assign(username, { id: 'u' }),
  h('label.label', { for: 'p' }, 'Password'), Object.assign(password, { id: 'p' }),
  button,
  info.login_banner ? h('p.login-banner', info.login_banner) : null,
  );
  mount(root, h('div.login-wrap', form));
  username.focus();
}

export function renderPasswordChange(root, { session, forced, onDone }) {
  const min = session.settings?.password_min_length || 10;
  const current = h('input.input', { type: 'password', autocomplete: 'current-password', required: true, id: 'pc' });
  const next = h('input.input', { type: 'password', autocomplete: 'new-password', required: true, minlength: min, id: 'pn' });
  const confirm = h('input.input', { type: 'password', autocomplete: 'new-password', required: true, id: 'pr' });
  const error = h('div.alert.error', { hidden: true, role: 'alert' });
  const form = h('form.login-card', {
    onsubmit: async (e) => {
      e.preventDefault();
      error.hidden = true;
      if (next.value !== confirm.value) { error.hidden = false; error.textContent = 'The new passwords do not match.'; return; }
      try {
        await post('/auth/password', { current: current.value, next: next.value });
        await onDone();
      } catch (err) {
        error.hidden = false;
        error.textContent = err.message;
      }
    },
  },
  h('h1', forced ? 'Choose a new password' : 'Change password'),
  forced ? h('p.muted', 'For security, you need to replace the temporary password before continuing.') : null,
  error,
  h('label.label', { for: 'pc' }, forced ? 'Temporary password' : 'Current password'), current,
  h('label.label', { for: 'pn' }, 'New password'), next,
  h('p.hint', `At least ${min} characters. A few unrelated words make a strong, memorable password.`),
  h('label.label', { for: 'pr' }, 'Repeat new password'), confirm,
  h('div.row-actions',
    forced ? null : h('button.btn', { type: 'button', onclick: () => history.back() }, 'Cancel'),
    h('button.btn.primary', { type: 'submit' }, 'Save password')),
  );
  mount(root, h('div.login-wrap', form));
  current.focus();
}

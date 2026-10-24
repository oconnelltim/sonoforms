// SPDX-License-Identifier: GPL-3.0-or-later
//
// Tiny DOM helpers. All text is inserted as text nodes (never innerHTML),
// so patient data can't inject markup.

export function h(tag, attrs, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = [el.className, v].filter(Boolean).join(' ');
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (['value', 'checked', 'disabled', 'selected', 'hidden', 'readOnly', 'indeterminate'].includes(k)) el[k] = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function mount(el, ...children) {
  return append(clear(el), children);
}

export const $ = (sel, root = document) => root.querySelector(sel);

// ---- Formatting ---------------------------------------------------------

export function fmtDate(d) {
  if (!d) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d));
  return m ? `${m[2]}/${m[3]}/${m[1]}` : String(d);
}

export function fmtTime(d) {
  if (!d) return '';
  const date = new Date(d);
  if (isNaN(date)) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function fmtDateTime(d) {
  if (!d) return '';
  const date = new Date(d);
  if (isNaN(date)) return '';
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay ? fmtTime(d) : `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${fmtTime(d)}`;
}

export function timeAgo(d) {
  const mins = Math.round((Date.now() - new Date(d).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  return `${Math.round(hrs / 24)} d ago`;
}

export function patientName(p) {
  if (!p) return '';
  return [p.last_name, p.first_name].filter(Boolean).join(', ') || '(no name)';
}

export function patientLine(p) {
  if (!p) return '';
  return [p.mrn && `MRN ${p.mrn}`, p.dob && `DOB ${fmtDate(p.dob)}`, p.age !== null && p.age !== undefined && `${p.age} y`, p.sex].filter(Boolean).join(' · ');
}

export const STATUS_LABELS = {
  draft: 'In progress', submitted: 'Ready to dictate', returned: 'Returned to tech', dictated: 'Dictated', cancelled: 'Cancelled',
};

export function statusBadge(status) {
  return h(`span.badge.status-${status}`, STATUS_LABELS[status] || status);
}

// ---- Feedback -----------------------------------------------------------

let toastHost;
export function toast(message, kind = 'info', ms = 3500) {
  if (!toastHost) toastHost = document.body.appendChild(h('div.toasts', { role: 'status', 'aria-live': 'polite' }));
  const t = h(`div.toast.toast-${kind}`, message);
  toastHost.appendChild(t);
  setTimeout(() => t.classList.add('leaving'), ms);
  setTimeout(() => t.remove(), ms + 400);
}

// Modal dialog. Returns a promise resolving to the value passed to close().
export function modal({ title, body, actions = [], wide = false, onOpen }) {
  return new Promise((resolve) => {
    const dialog = h(`dialog.modal${wide ? '.wide' : ''}`);
    const close = (value) => { dialog.close(); dialog.remove(); resolve(value); };
    const buttons = actions.map(a => h(`button.btn${a.primary ? '.primary' : ''}${a.danger ? '.danger' : ''}`, {
      type: 'button',
      onclick: async () => {
        if (a.onClick) {
          const r = await a.onClick(close);
          if (r === false) return;
        }
        if (!a.keepOpen) close(a.value);
      },
    }, a.label));
    append(dialog, [
      h('div.modal-head', h('h2', title), h('button.icon-btn', { type: 'button', 'aria-label': 'Close', onclick: () => close(undefined) }, '×')),
      h('div.modal-body', body),
      buttons.length ? h('div.modal-actions', buttons) : null,
    ]);
    dialog.addEventListener('cancel', (e) => { e.preventDefault(); close(undefined); });
    document.body.appendChild(dialog);
    dialog.showModal();
    if (onOpen) onOpen(dialog, close);
  });
}

export function confirmDialog(title, message, { confirmLabel = 'OK', danger = false } = {}) {
  return modal({
    title,
    body: h('p', message),
    actions: [{ label: 'Cancel', value: false }, { label: confirmLabel, value: true, primary: !danger, danger }],
  }).then(Boolean);
}

export function promptDialog(title, label, { multiline = false, required = true, initial = '', confirmLabel = 'OK' } = {}) {
  const input = multiline ? h('textarea.input', { rows: 4, value: initial }) : h('input.input', { value: initial });
  const error = h('div.field-error');
  return modal({
    title,
    body: [h('label.label', label), input, error],
    onOpen: () => input.focus(),
    actions: [
      { label: 'Cancel', value: null },
      {
        label: confirmLabel, primary: true,
        onClick: (close) => {
          if (required && !input.value.trim()) { error.textContent = 'Required'; return false; }
          close(input.value.trim());
          return false;
        },
      },
    ],
  });
}

// Debounce helper for autosave and live previews.
// flush() runs a pending call immediately; it does nothing if none is pending.
export function debounce(fn, ms) {
  let t;
  let pending = null;
  const d = (...args) => { clearTimeout(t); pending = args; t = setTimeout(() => { pending = null; fn(...args); }, ms); };
  d.flush = () => { clearTimeout(t); if (!pending) return undefined; const args = pending; pending = null; return fn(...args); };
  d.cancel = () => { clearTimeout(t); pending = null; };
  return d;
}

export function downloadUrl(url) {
  const a = h('a', { href: url, download: '' });
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for browsers that block the async clipboard API.
    const ta = h('textarea', { value: text, style: { position: 'fixed', top: '-1000px' } });
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

// SPDX-License-Identifier: GPL-3.0-or-later

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `Request failed (${status})`);
    this.status = status;
    this.body = body || {};
  }
}

let csrf = null;
let onUnauthorized = () => {};

export function setCsrf(token) { csrf = token; }
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

export async function api(method, url, body, { background = false } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && csrf) headers['X-CSRF-Token'] = csrf;
  if (background) headers['X-Background'] = '1';
  let res;
  try {
    res = await fetch(`/api${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, { error: 'Cannot reach the server. Check your network connection.' });
  }
  const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    const err = new ApiError(res.status, typeof data === 'object' ? data : { error: data });
    if (res.status === 401 && !url.startsWith('/auth/')) onUnauthorized(err);
    throw err;
  }
  return data;
}

export const get = (url, opts) => api('GET', url, undefined, opts);
export const post = (url, body = {}) => api('POST', url, body);
export const put = (url, body = {}) => api('PUT', url, body);
export const del = (url) => api('DELETE', url);

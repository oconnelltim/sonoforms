// SPDX-License-Identifier: GPL-3.0-or-later
//
// Shape and size limits for form answers sent by the browser. Answers are
// free-form JSON (their fields depend on the form), so they are checked
// generically: sensible key names, shallow nesting and bounded sizes. This
// keeps a single request from being able to tie up the server.

import { HttpError } from './auth.js';

export const ANSWER_LIMITS = {
  maxBytes: 256 * 1024,   // whole answers object as JSON
  maxKeys: 3000,          // keys across all nesting levels
  maxString: 10000,       // characters in any one text value
  maxArray: 100,          // items in a list (repeat groups, multi-selects, measurements)
  maxDepth: 4,            // answers -> repeat list -> item -> value
};

const KEY = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function assertAnswersOk(answers) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new HttpError(400, 'Answers must be an object.');
  if (JSON.stringify(answers).length > ANSWER_LIMITS.maxBytes) throw new HttpError(413, 'This form is too large to save. Shorten the free-text entries.');
  let keys = 0;
  const walk = (v, depth, path) => {
    if (depth > ANSWER_LIMITS.maxDepth) throw new HttpError(400, `Answers are nested too deeply (at ${path}).`);
    if (v === null || typeof v === 'boolean') return;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new HttpError(400, `Invalid number at ${path}.`);
      return;
    }
    if (typeof v === 'string') {
      if (v.length > ANSWER_LIMITS.maxString) throw new HttpError(400, `The text in "${path}" is too long (${ANSWER_LIMITS.maxString} characters at most).`);
      return;
    }
    if (Array.isArray(v)) {
      if (v.length > ANSWER_LIMITS.maxArray) throw new HttpError(400, `Too many items in "${path}".`);
      v.forEach((x, i) => walk(x, depth + 1, `${path}[${i}]`));
      return;
    }
    if (typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (++keys > ANSWER_LIMITS.maxKeys) throw new HttpError(400, 'Too many answers.');
        if (!KEY.test(k) || FORBIDDEN_KEYS.has(k)) throw new HttpError(400, `Invalid answer name "${String(k).slice(0, 40)}".`);
        walk(x, depth + 1, path ? `${path}.${k}` : k);
      }
      return;
    }
    throw new HttpError(400, `Unsupported value at ${path}.`);
  };
  walk(answers, 0, '');
}

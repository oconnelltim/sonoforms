// SPDX-License-Identifier: GPL-3.0-or-later
//
// A small, safe expression language used by form definitions for
// visibility rules (show_if), required rules, calculated fields and
// report templates. It never uses eval(); only whitelisted functions run.
//
// Examples:
//   uterus == 'present'
//   has(indication, 'pain') and age >= 50
//   round(ellipsoid(r_ovary), 1)
//   lmp in ['postmenopausal', 'unknown']

import { FUNCTIONS, META_FUNCTIONS } from './functions.js';

export class ExprError extends Error {}

const OPERATORS = ['==', '!=', '<=', '>=', '&&', '||', '<', '>', '+', '-', '*', '/', '%', '!', '(', ')', ',', '[', ']'];

export function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1]))) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      tokens.push({ t: 'num', v: parseFloat(src.slice(i, j)) });
      i = j; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1, s = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) { s += src[j + 1]; j += 2; } else { s += src[j++]; }
      }
      if (j >= src.length) throw new ExprError(`Unterminated string in: ${src}`);
      tokens.push({ t: 'str', v: s });
      i = j + 1; continue;
    }
    if (/[A-Za-z_@]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_.]/.test(src[j])) j++;
      const word = src.slice(i, j);
      if (word === 'and') tokens.push({ t: 'op', v: '&&' });
      else if (word === 'or') tokens.push({ t: 'op', v: '||' });
      else if (word === 'not') tokens.push({ t: 'op', v: '!' });
      else if (word === 'in') tokens.push({ t: 'op', v: 'in' });
      else if (word === 'true' || word === 'false') tokens.push({ t: 'lit', v: word === 'true' });
      else if (word === 'null') tokens.push({ t: 'lit', v: null });
      else tokens.push({ t: 'id', v: word });
      i = j; continue;
    }
    const op = OPERATORS.find(o => src.startsWith(o, i));
    if (op) { tokens.push({ t: 'op', v: op }); i += op.length; continue; }
    if (c === '=') throw new ExprError(`Use '==' for comparison, not '=' (in: ${src})`);
    throw new ExprError(`Unexpected character '${c}' in: ${src}`);
  }
  return tokens;
}

// Recursive-descent parser producing a small AST.
export function parse(src) {
  const tokens = tokenize(String(src));
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = v => peek() && peek().t === 'op' && peek().v === v;
  const expectOp = v => {
    if (!isOp(v)) throw new ExprError(`Expected '${v}' in: ${src}`);
    pos++;
  };

  function parseOr() {
    let left = parseAnd();
    while (isOp('||')) { pos++; left = { k: 'or', a: left, b: parseAnd() }; }
    return left;
  }
  function parseAnd() {
    let left = parseNot();
    while (isOp('&&')) { pos++; left = { k: 'and', a: left, b: parseNot() }; }
    return left;
  }
  function parseNot() {
    if (isOp('!')) { pos++; return { k: 'not', a: parseNot() }; }
    return parseCompare();
  }
  function parseCompare() {
    let left = parseAdd();
    for (;;) {
      const tk = peek();
      if (tk && tk.t === 'op' && ['==', '!=', '<', '>', '<=', '>=', 'in'].includes(tk.v)) {
        pos++;
        left = { k: 'bin', op: tk.v, a: left, b: parseAdd() };
      } else return left;
    }
  }
  function parseAdd() {
    let left = parseMul();
    while (isOp('+') || isOp('-')) { const op = tokens[pos++].v; left = { k: 'bin', op, a: left, b: parseMul() }; }
    return left;
  }
  function parseMul() {
    let left = parseUnary();
    while (isOp('*') || isOp('/') || isOp('%')) { const op = tokens[pos++].v; left = { k: 'bin', op, a: left, b: parseUnary() }; }
    return left;
  }
  function parseUnary() {
    if (isOp('-')) { pos++; return { k: 'neg', a: parseUnary() }; }
    return parsePrimary();
  }
  function parsePrimary() {
    const tk = peek();
    if (!tk) throw new ExprError(`Unexpected end of expression: ${src}`);
    if (tk.t === 'num' || tk.t === 'str' || tk.t === 'lit') { pos++; return { k: 'lit', v: tk.v }; }
    if (tk.t === 'id') {
      pos++;
      if (isOp('(')) {
        pos++;
        const args = [];
        if (!isOp(')')) {
          args.push(parseOr());
          while (isOp(',')) { pos++; args.push(parseOr()); }
        }
        expectOp(')');
        const name = tk.v.toLowerCase();
        if (!Object.hasOwn(FUNCTIONS, name) && !Object.hasOwn(META_FUNCTIONS, name)) throw new ExprError(`Unknown function '${tk.v}' in: ${src}`);
        return { k: 'call', name, args };
      }
      return { k: 'id', name: tk.v };
    }
    if (isOp('(')) { pos++; const e = parseOr(); expectOp(')'); return e; }
    if (isOp('[')) {
      pos++;
      const items = [];
      if (!isOp(']')) {
        items.push(parseOr());
        while (isOp(',')) { pos++; items.push(parseOr()); }
      }
      expectOp(']');
      return { k: 'list', items };
    }
    throw new ExprError(`Unexpected '${tk.v}' in: ${src}`);
  }

  const ast = parseOr();
  if (pos < tokens.length) throw new ExprError(`Unexpected '${tokens[pos].v}' in: ${src}`);
  return ast;
}

const cache = new Map();
export function compile(src) {
  let ast = cache.get(src);
  if (!ast) {
    ast = parse(src);
    if (cache.size > 2000) cache.clear();
    cache.set(src, ast);
  }
  return ast;
}

export const isEmpty = v =>
  v === null || v === undefined || v === '' || (Array.isArray(v) && v.every(isEmpty)) || (typeof v === 'number' && isNaN(v));

const num = v => (isEmpty(v) || Array.isArray(v) ? null : (typeof v === 'number' ? v : (isNaN(Number(v)) ? null : Number(v))));

function looseEqual(a, b) {
  if (isEmpty(a) && isEmpty(b)) return true;
  if (typeof a === 'boolean' || typeof b === 'boolean') return Boolean(a) === Boolean(b);
  if (typeof a === 'number' || typeof b === 'number') {
    const na = num(a), nb = num(b);
    if (na !== null && nb !== null) return na === nb;
  }
  return String(a ?? '') === String(b ?? '');
}

export function truthy(v) {
  if (Array.isArray(v)) return v.some(x => !isEmpty(x));
  return !isEmpty(v) && v !== false && v !== 0;
}

// ctx: { lookup(name) -> value, field(name) -> field definition or undefined }
export function evaluate(ast, ctx) {
  switch (ast.k) {
    case 'lit': return ast.v;
    case 'id': return ctx.lookup(ast.name);
    case 'list': return ast.items.map(x => evaluate(x, ctx));
    case 'not': return !truthy(evaluate(ast.a, ctx));
    case 'and': return truthy(evaluate(ast.a, ctx)) && truthy(evaluate(ast.b, ctx));
    case 'or': {
      const a = evaluate(ast.a, ctx);
      return truthy(a) ? a : evaluate(ast.b, ctx);
    }
    case 'neg': { const a = num(evaluate(ast.a, ctx)); return a === null ? null : -a; }
    case 'call': {
      if (Object.hasOwn(META_FUNCTIONS, ast.name)) {
        // Meta functions receive field names, not values (e.g. points(composition)).
        const names = ast.args.map(a => (a.k === 'id' ? a.name : evaluate(a, ctx)));
        return META_FUNCTIONS[ast.name](ctx, ...names);
      }
      return FUNCTIONS[ast.name](...ast.args.map(a => evaluate(a, ctx)));
    }
    case 'bin': {
      const a = evaluate(ast.a, ctx), b = evaluate(ast.b, ctx);
      switch (ast.op) {
        case '==': return looseEqual(a, b);
        case '!=': return !looseEqual(a, b);
        case 'in': return Array.isArray(b) ? b.some(x => looseEqual(a, x)) : String(b ?? '').includes(String(a ?? ''));
        case '+':
          if (typeof a === 'string' || typeof b === 'string') return `${a ?? ''}${b ?? ''}`;
          // fall through to numeric
        // eslint-disable-next-line no-fallthrough
        case '-': case '*': case '/': case '%': {
          const x = num(a), y = num(b);
          if (x === null || y === null) return null;
          if (ast.op === '+') return x + y;
          if (ast.op === '-') return x - y;
          if (ast.op === '*') return x * y;
          if (ast.op === '/') return y === 0 ? null : x / y;
          return y === 0 ? null : x % y;
        }
        case '<': case '>': case '<=': case '>=': {
          const x = num(a), y = num(b);
          if (x === null || y === null) return false;
          if (ast.op === '<') return x < y;
          if (ast.op === '>') return x > y;
          if (ast.op === '<=') return x <= y;
          return x >= y;
        }
      }
    }
  }
  throw new ExprError(`Bad expression node ${ast.k}`);
}

// Collect identifiers referenced by an expression (used by the form linter).
export function identifiers(ast, out = new Set()) {
  if (!ast) return out;
  if (ast.k === 'id') out.add(ast.name);
  if (ast.k === 'call' && Object.hasOwn(META_FUNCTIONS, ast.name)) {
    ast.args.forEach(a => (a.k === 'id' ? out.add(a.name) : identifiers(a, out)));
    return out;
  }
  for (const key of ['a', 'b']) if (ast[key]) identifiers(ast[key], out);
  (ast.args || []).forEach(a => identifiers(a, out));
  (ast.items || []).forEach(a => identifiers(a, out));
  return out;
}

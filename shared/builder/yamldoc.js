// SPDX-License-Identifier: GPL-3.0-or-later
//
// Edits a form's YAML through the `yaml` library's Document API, so the
// visual builder changes only what the user changed: comments, key order,
// block-style report text and { flow } option maps all survive.
//
// The yaml module is passed in (browser and Node load it differently).
// Paths: a section is [s]; a field is [s, f]; a repeat sub-field is [s, f, k].

const KEY_ORDER = {
  form: ['id', 'title', 'description', 'study_match', 'report', 'sections'],
  section: ['id', 'title', 'help', 'show_if', 'fields', 'report'],
  field: ['id', 'type', 'label', 'help', 'placeholder', 'layout', 'width', 'required', 'show_if', 'default', 'normal',
    'unit', 'axes', 'decimals', 'min', 'max', 'step', 'formula', 'true_text', 'false_text', 'conjunction', 'rows',
    'item_label', 'min_items', 'max_items', 'options', 'other', 'fields'],
};

export function createDocTools(YAML) {
  const toYamlPath = (path) => {
    const p = [];
    if (path.length >= 1) p.push('sections', path[0]);
    if (path.length >= 2) p.push('fields', path[1]);
    if (path.length >= 3) p.push('fields', path[2]);
    return p;
  };
  const kindOf = path => (path.length === 0 ? 'form' : path.length === 1 ? 'section' : 'field');

  function parse(src) {
    const doc = YAML.parseDocument(String(src ?? ''), { prettyErrors: true });
    if (doc.errors.length) throw new Error(doc.errors[0].message.split('\n')[0]);
    if (!YAML.isMap(doc.contents)) throw new Error('The form must start with id:, title: and sections:');
    return doc;
  }

  const stringify = doc => doc.toString({ lineWidth: 0 });

  function node(doc, path) {
    const n = path.length ? doc.getIn(toYamlPath(path), true) : doc.contents;
    if (!YAML.isMap(n)) throw new Error('That item no longer exists. Reload the form.');
    return n;
  }

  function seq(doc, yamlPath) {
    let s = doc.getIn(yamlPath, true);
    if (!YAML.isSeq(s)) {
      doc.setIn(yamlPath, doc.createNode([]));
      s = doc.getIn(yamlPath, true);
    }
    return s;
  }

  const isBlank = v => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

  function makeNode(doc, value, { flow = false } = {}) {
    const n = doc.createNode(value);
    if (typeof value === 'string' && value.includes('\n')) n.type = 'BLOCK_LITERAL';
    if (flow && (YAML.isMap(n) || YAML.isSeq(n))) {
      n.flow = true;
      for (const item of n.items || []) if (YAML.isMap(item)) item.flow = true;
    }
    return n;
  }

  // Sets (or with a blank value, removes) one key, keeping a tidy key order.
  function setProp(doc, path, key, value, opts = {}) {
    const map = node(doc, path);
    if (isBlank(value) && !opts.keepBlank) {
      map.delete(key);
      return;
    }
    const existing = map.get(key, true);
    if (YAML.isScalar(existing) && (typeof value !== 'object' || value === null)) {
      existing.value = value;
      if (typeof value === 'string' && value.includes('\n')) existing.type = 'BLOCK_LITERAL';
      else if (existing.type === 'BLOCK_LITERAL' || existing.type === 'BLOCK_FOLDED') existing.type = undefined;
      return;
    }
    const n = makeNode(doc, value, opts);
    if (map.has(key)) {
      map.set(key, n);
      return;
    }
    // Insert before the first existing key that should come after this one.
    const order = KEY_ORDER[kindOf(path)];
    const rank = k => (order.includes(k) ? order.indexOf(k) : order.length);
    const pair = doc.createPair(key, n);
    const at = map.items.findIndex(p => rank(String(p.key?.value ?? p.key)) > rank(key));
    if (at === -1) map.items.push(pair);
    else map.items.splice(at, 0, pair);
  }

  function getProp(doc, path, key) {
    const v = node(doc, path).get(key);
    return YAML.isNode(v) ? v.toJSON() : v;
  }

  // Replaces the options list; each option is written as a compact { map }.
  function setOptions(doc, path, options) {
    const clean = options.map((o) => {
      const out = { value: String(o.value) };
      out.label = o.label;
      if (o.text !== undefined && o.text !== '' && o.text !== o.label) out.text = o.text;
      if (o.points !== undefined && o.points !== '' && o.points !== null) out.points = Number(o.points);
      return out;
    });
    setProp(doc, path, 'options', clean, { flow: false });
    for (const item of node(doc, path).get('options', true).items) item.flow = true;
  }

  const listPath = path => (path.length === 1 ? ['sections'] : toYamlPath(path.slice(0, -1)).concat('fields'));

  function insert(doc, parentPath, index, value) {
    const s = seq(doc, parentPath.length === 0 ? ['sections'] : toYamlPath(parentPath).concat('fields'));
    const n = makeNode(doc, value);
    const at = Math.max(0, Math.min(index ?? s.items.length, s.items.length));
    s.items.splice(at, 0, n);
    return at;
  }

  function remove(doc, path) {
    const s = seq(doc, listPath(path));
    s.items.splice(path[path.length - 1], 1);
  }

  // Moves an item to a new parent/index (sections within the form, fields
  // within or across sections). toIndex is the position in the target list
  // before the item is removed.
  function move(doc, path, toParent, toIndex) {
    const from = seq(doc, listPath(path));
    const fromIndex = path[path.length - 1];
    const [item] = from.items.splice(fromIndex, 1);
    const target = toParent.length === 0 ? seq(doc, ['sections']) : seq(doc, toYamlPath(toParent).concat('fields'));
    let at = toIndex;
    if (target === from && toIndex > fromIndex) at -= 1;
    at = Math.max(0, Math.min(at, target.items.length));
    target.items.splice(at, 0, item);
    return toParent.concat(at);
  }

  // Applies fn(value) to every string at the given keys, anywhere in the form
  // (used to update references when a field is renamed).
  function rewriteStrings(doc, keys, fn) {
    YAML.visit(doc, {
      Pair(_, pair) {
        const k = String(pair.key?.value ?? pair.key);
        if (keys.includes(k) && YAML.isScalar(pair.value) && typeof pair.value.value === 'string') {
          const next = fn(pair.value.value, k);
          if (next !== pair.value.value) pair.value.value = next;
        }
      },
    });
  }

  return { parse, stringify, setProp, getProp, setOptions, insert, remove, move, rewriteStrings, node };
}

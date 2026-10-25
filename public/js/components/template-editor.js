// SPDX-License-Identifier: GPL-3.0-or-later
//
// Report-text editor. Plain text is typed normally; template tags appear as
// atomic chips ([Size], [If Right ovary is Visualized], [Otherwise]…) so a
// form author never has to read or type {{ }} syntax. Under the hood the
// exact template text is kept: serialize(render(text)) === text.

import { h, clear } from '../dom.js';
import { tokenize, chipLabel } from '/shared/builder/template-tokens.js';

// One shared listener remembers each editor's caret, so toolbar buttons
// insert where the user was typing. Editors no longer on the page drop out.
const editors = new Set();
document.addEventListener('selectionchange', () => {
  const sel = window.getSelection();
  for (const ed of editors) {
    if (!ed.area.isConnected) { if (ed.seen) editors.delete(ed); continue; }
    ed.seen = true;
    if (sel.rangeCount && ed.area.contains(sel.anchorNode)) ed.savedRange = sel.getRangeAt(0).cloneRange();
  }
});

const CHIP_KIND = { field: 'field', if: 'logic', elseif: 'logic', else: 'logic', endif: 'logic', each: 'loop', endeach: 'loop', comment: 'note', expr: 'expr' };

export function templateEditor({ value, lookup, onChange, onChipClick, readOnly = false, placeholder = '' }) {
  const area = h('div.tpl-editor', {
    contenteditable: readOnly ? 'false' : 'true', role: 'textbox', 'aria-multiline': 'true', spellcheck: 'true',
    'data-placeholder': placeholder,
  });
  const state = { area, savedRange: null };
  editors.add(state);

  function chip(token) {
    const el = h(`span.tpl-chip.chip-${CHIP_KIND[token.type] || 'expr'}`, { contenteditable: 'false', title: token.raw, dataset: { raw: token.raw, type: token.type } }, chipLabel(token, lookup));
    if (onChipClick && !readOnly) el.addEventListener('click', () => onChipClick(token, el));
    return el;
  }

  function render(text) {
    clear(area);
    for (const t of tokenize(text)) area.appendChild(t.kind === 'text' ? document.createTextNode(t.text) : chip(t));
    area.classList.toggle('empty', !text);
  }

  // Browsers may wrap typed lines in <div>/<br>; turn everything back into text.
  function serialize() {
    let out = '';
    const walk = (node, isFirst) => {
      if (node.nodeType === Node.TEXT_NODE) { out += node.nodeValue; return; }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (node.dataset?.raw !== undefined) { out += node.dataset.raw; return; }
      if (node.tagName === 'BR') { out += '\n'; return; }
      const block = node.tagName === 'DIV' || node.tagName === 'P';
      if (block && !isFirst && !out.endsWith('\n')) out += '\n';
      node.childNodes.forEach((c, i) => walk(c, i === 0));
    };
    area.childNodes.forEach((c, i) => walk(c, i === 0));
    return out.replace(/ /g, ' ');
  }

  const changed = () => {
    area.classList.toggle('empty', !area.textContent && !area.querySelector('.tpl-chip'));
    onChange(serialize());
  };

  area.addEventListener('input', changed);
  area.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); insertText('\n'); }
  });
  area.addEventListener('paste', (e) => {
    e.preventDefault();
    insertText(e.clipboardData.getData('text/plain'));
  });

  function placeCaret() {
    area.focus();
    const sel = window.getSelection();
    sel.removeAllRanges();
    if (state.savedRange && area.contains(state.savedRange.startContainer)) sel.addRange(state.savedRange);
    else {
      const r = document.createRange();
      r.selectNodeContents(area);
      r.collapse(false);
      sel.addRange(r);
    }
    return sel.getRangeAt(0);
  }

  function insertNodes(nodes) {
    if (readOnly) return;
    const range = placeCaret();
    range.deleteContents();
    const frag = document.createDocumentFragment();
    nodes.forEach(n => frag.appendChild(n));
    const last = nodes[nodes.length - 1];
    range.insertNode(frag);
    const after = document.createRange();
    after.setStartAfter(last);
    after.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(after);
    state.savedRange = after.cloneRange();
    changed();
  }

  function insertText(text) {
    insertNodes([document.createTextNode(text)]);
  }

  // Inserts template text (may contain several tags) at the caret.
  function insertTemplate(text) {
    insertNodes(tokenize(text).map(t => (t.kind === 'text' ? document.createTextNode(t.text) : chip(t))));
  }

  function replaceChip(el, raw) {
    const [t] = tokenize(raw);
    el.replaceWith(chip(t));
    changed();
  }

  render(value || '');
  return {
    el: area,
    insertTemplate,
    replaceChip,
    setValue(v) { render(v || ''); },
    getValue: serialize,
  };
}

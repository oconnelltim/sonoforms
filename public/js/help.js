// SPDX-License-Identifier: GPL-3.0-or-later
//
// Renders a Markdown file from /docs as a help page. Supports the subset
// used in our docs: headings, paragraphs, lists, tables, code, bold, links.

import { h, mount } from './dom.js';

const doc = new URLSearchParams(location.search).get('doc') || 'FORMS';
const root = document.getElementById('doc');

function inline(text) {
  const out = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('`')) out.push(h('code', t.slice(1, -1)));
    else if (t.startsWith('**')) out.push(h('strong', t.slice(2, -2)));
    else if (t.startsWith('*')) out.push(h('em', t.slice(1, -1)));
    else {
      const [, label, href] = /\[([^\]]+)\]\(([^)]+)\)/.exec(t);
      const safe = /^(https?:|#|\/|[\w.-]+\.md$)/.test(href) ? href.replace(/^([\w.-]+)\.md$/, '/help.html?doc=$1') : '#';
      out.push(h('a', { href: safe }, label));
    }
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function render(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      const code = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) code.push(lines[i++]);
      i++;
      out.push(h('pre.code-view', code.join('\n')));
      continue;
    }
    const hm = /^(#{1,4})\s+(.*)$/.exec(line);
    if (hm) { out.push(h(`h${hm[1].length}`, inline(hm[2]))); i++; continue; }
    if (/^\|/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]);
      const cells = r => r.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));
      const head = cells(rows[0]);
      const body = rows.slice(2).map(cells);
      out.push(h('div.table-wrap', h('table.table', h('thead', h('tr', head.map(c => h('th', inline(c))))), h('tbody', body.map(r => h('tr', r.map(c => h('td', inline(c)))))))));
      continue;
    }
    if (/^\s*([*-]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      while (i < lines.length && /^\s*([*-]|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([*-]|\d+\.)\s+/, ''));
      out.push(h(ordered ? 'ol' : 'ul', items.map(t => h('li', inline(t)))));
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#|```|\||\s*([*-]|\d+\.)\s)/.test(lines[i])) para.push(lines[i++]);
    out.push(h('p', inline(para.join(' '))));
  }
  return out;
}

(async () => {
  if (!/^[A-Z_]+$/.test(doc)) { mount(root, h('p', 'Unknown document')); return; }
  const res = await fetch(`/docs/${doc}.md`);
  if (!res.ok) { mount(root, h('p', 'Document not found')); return; }
  const md = await res.text();
  document.title = (/^#\s+(.*)$/m.exec(md) || [, 'Help'])[1];
  mount(root, render(md));
})();

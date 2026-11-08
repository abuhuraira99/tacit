import { h, toast } from '../dom.js';
import { api } from '../api.js';
import { icon } from '../icons.js';

export const title = 'Report';

export async function render() {
  const { markdown } = await api.get('/api/report');
  return h(
    'div',
    { class: 'page' },
    h(
      'header',
      { class: 'page-head' },
      h('div', null, h('h1', { class: 'page-title' }, 'Report'), h('p', { class: 'page-lede' }, 'A Markdown retrospective you can keep, share with your team, or paste into a pull request. Secrets are redacted.')),
      h(
        'div',
        { class: 'actions' },
        h(
          'button',
          {
            class: 'btn',
            type: 'button',
            onclick: async () => {
              await navigator.clipboard.writeText(markdown).catch(() => {});
              toast('Copied the Markdown.');
            },
          },
          icon('copy'),
          'Copy Markdown',
        ),
        h('a', { class: 'btn primary', href: '/api/report?download=1' }, icon('download'), 'Download .md'),
      ),
    ),
    h('article', { class: 'sheet panel prose' }, renderMarkdown(markdown)),
  );
}

/** A small, safe Markdown renderer for the report's own output (no raw HTML). */
export function renderMarkdown(md) {
  const out = [];
  const lines = md.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
      i++;
      out.push(h('pre', null, h('code', null, buf.join('\n'))));
      continue;
    }
    const hm = /^(#{1,3})\s+(.*)$/.exec(line);
    if (hm) {
      out.push(h(`h${hm[1].length}`, null, inline(hm[2])));
      i++;
      continue;
    }
    if (line.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]);
      const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const [head, , ...rest] = rows;
      const headCells = cells(head);
      out.push(
        h(
          'table',
          null,
          headCells.some(Boolean) ? h('thead', null, h('tr', null, headCells.map((c) => h('th', null, inline(c))))) : null,
          h('tbody', null, rest.map((r) => h('tr', null, cells(r).map((c) => h('td', null, inline(c)))))),
        ),
      );
      continue;
    }
    if (line.startsWith('> ')) {
      out.push(h('blockquote', null, inline(line.slice(2))));
      i++;
      continue;
    }
    if (line.startsWith('- ')) {
      const items = [];
      while (i < lines.length && lines[i].startsWith('- ')) items.push(lines[i++].slice(2));
      out.push(h('ul', null, items.map((x) => h('li', null, inline(x)))));
      continue;
    }
    if (line.trim() === '---') {
      out.push(h('hr'));
      i++;
      continue;
    }
    if (line.trim()) out.push(h('p', null, inline(line)));
    i++;
  }
  return out;
}

function inline(text) {
  const parts = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const tok = m[0];
    parts.push(tok.startsWith('**') ? h('strong', null, tok.slice(2, -2)) : h('code', null, tok.slice(1, -1)));
    last = m.index + tok.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

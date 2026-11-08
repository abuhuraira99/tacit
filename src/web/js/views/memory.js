import { h } from '../dom.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import { ring } from '../charts.js';
import { int, plural } from '../format.js';

export const title = 'Memory health';

export async function render() {
  const reports = await api.get('/api/health');
  const issues = reports.reduce((a, r) => a + r.issues.length, 0);
  return h(
    'div',
    { class: 'page' },
    h(
      'header',
      { class: 'page-head' },
      h(
        'div',
        null,
        h('h1', { class: 'page-title' }, 'Memory health'),
        h(
          'p',
          { class: 'page-lede' },
          'How well your CLAUDE.md files match the way you actually work: rules you still have to repeat, habits with no rule, duplicates, contradictions and soft wording.',
        ),
      ),
      h('span', { class: ['chip', issues ? 'warn' : 'good'] }, issues ? `${plural(issues, 'thing')} to fix` : 'All healthy'),
    ),
    h('div', { class: 'memory' }, reports.map(card)),
  );
}

function card(r) {
  return h(
    'section',
    { class: 'sheet mem-card', 'aria-labelledby': `mem-${r.id}` },
    h('div', null, ring(r.score)),
    h(
      'div',
      null,
      h('div', { class: 'mem-head' }, h('h2', { class: 'mem-title', id: `mem-${r.id}` }, r.label), h('span', { class: ['chip', r.score >= 85 ? 'good' : r.score >= 60 ? '' : 'warn'] }, r.grade)),
      h(
        'div',
        { class: 'mem-files' },
        r.files.length
          ? r.files.map((f) => h('div', null, `${f.file}  ${int(f.rules)} rules, ~${int(f.tokens)} tokens`))
          : h('div', null, `No CLAUDE.md in ${r.cwd}`),
      ),
      r.issues.length
        ? h(
            'ul',
            { class: 'issues' },
            r.issues.slice(0, 8).map((i) =>
              h(
                'li',
                null,
                h('span', { class: ['dot', i.severity] }),
                h('div', null, h('b', null, i.title), h('p', null, i.detail)),
                i.patternId ? h('a', { class: 'btn small', href: `#/draft/${i.patternId}/${i.type === 'ignored' ? 'hook' : 'rule'}` }, icon('draft'), i.type === 'ignored' ? 'Enforce it' : 'Add rule') : h('span'),
              ),
            ),
          )
        : h('p', { class: 'muted', style: { margin: 0 } }, 'Nothing to fix. Your rules match how you work here.'),
      r.issues.length > 8 ? h('p', { class: 'small muted' }, `And ${plural(r.issues.length - 8, 'smaller issue')}.`) : null,
    ),
  );
}

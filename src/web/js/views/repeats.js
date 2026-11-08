import { h, mount } from '../dom.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import { tally } from '../charts.js';
import { plural, ago, KIND_SHORT } from '../format.js';

export const title = 'Repeats';

const FILTERS = [
  ['all', 'All'],
  ['rule', 'Rules'],
  ['skill', 'Skills'],
  ['hook', 'Hooks'],
  ['subagent', 'Subagents'],
  ['command', 'Commands'],
  ['brief', 'Briefs'],
];

const state = { kind: 'all', scope: 'all', q: '' };

export async function render() {
  const all = await api.get('/api/patterns');
  const listEl = h('div', { class: 'habits', id: 'habit-list' });

  const counts = Object.fromEntries(FILTERS.map(([k]) => [k, k === 'all' ? all.length : all.filter((p) => (k === 'brief' ? p.kind === 'brief' : p.suggestion === k && p.kind !== 'brief')).length]));
  const seg = h(
    'div',
    { class: 'segmented', role: 'group', 'aria-label': 'Filter by what it should become' },
    FILTERS.map(([k, label]) =>
      h(
        'button',
        {
          type: 'button',
          'aria-pressed': String(state.kind === k),
          disabled: k !== 'all' && !counts[k] ? true : null,
          onclick: (e) => {
            state.kind = k;
            seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', 'false'));
            e.currentTarget.setAttribute('aria-pressed', 'true');
            draw();
          },
        },
        label,
        h('span', { class: 'n' }, String(counts[k])),
      ),
    ),
  );

  const scope = h(
    'select',
    {
      class: 'select',
      'aria-label': 'Scope',
      onchange: (e) => {
        state.scope = e.target.value;
        draw();
      },
    },
    h('option', { value: 'all' }, 'All scopes'),
    h('option', { value: 'global' }, 'Across projects'),
    h('option', { value: 'project' }, 'One project'),
  );
  scope.value = state.scope;

  const search = h('input', {
    class: 'input',
    type: 'search',
    placeholder: 'Search what you said',
    'aria-label': 'Search repeats',
    'data-search': '',
    value: state.q,
    oninput: (e) => {
      state.q = e.target.value;
      draw();
    },
  });

  function draw() {
    const q = state.q.trim().toLowerCase();
    const list = all.filter((p) => {
      if (state.kind !== 'all' && (state.kind === 'brief' ? p.kind !== 'brief' : p.suggestion !== state.kind || p.kind === 'brief')) return false;
      if (state.scope !== 'all' && p.scope !== state.scope) return false;
      if (q && !(p.title.toLowerCase().includes(q) || p.text.toLowerCase().includes(q) || p.variants.some((v) => v.toLowerCase().includes(q)))) return false;
      return true;
    });
    if (!list.length) {
      mount(listEl, h('div', { class: 'sheet empty' }, h('h2', null, all.length ? 'Nothing matches' : 'No repeats yet'), h('p', null, all.length ? 'Try another filter or search.' : 'When you give Claude the same instruction in two or more sessions, it shows up here.')));
      return;
    }
    mount(listEl, list.map(row));
  }
  draw();

  return h(
    'div',
    { class: 'page' },
    h(
      'header',
      { class: 'page-head' },
      h(
        'div',
        null,
        h('h1', { class: 'page-title' }, 'Repeats'),
        h('p', { class: 'page-lede' }, 'Instructions you have given Claude Code more than once, grouped even when you worded them differently. Each one can become something Claude remembers on its own.'),
      ),
    ),
    h('div', { class: 'toolbar' }, seg, h('span', { class: 'spacer' }), scope, h('label', { class: 'search' }, icon('search'), search)),
    listEl,
  );
}

function row(p) {
  const open = () => (location.hash = `#/repeats/${p.id}`);
  return h(
    'article',
    {
      class: 'habit',
      tabindex: 0,
      role: 'link',
      'aria-label': `${p.title}, said ${p.count} times`,
      onclick: (e) => {
        if (!e.target.closest('a')) open();
      },
      onkeydown: (e) => {
        if (e.key === 'Enter' && e.target === e.currentTarget) open();
      },
    },
    h(
      'div',
      null,
      h('div', { class: 'habit-top' }, tally(p.count), h('span', { class: 'habit-title' }, p.title)),
      h('p', { class: 'habit-quote' }, p.text),
      h(
        'div',
        { class: 'habit-meta' },
        p.kind === 'brief'
          ? `Pasted ${p.count} times in ${plural(p.sessions, 'session')}${p.words ? `, about ${p.words} words each time` : ''}. Last ${ago(p.lastTs)}.`
          : `${p.count} times in ${plural(p.sessions, 'session')}${p.projects.length > 1 ? `, ${plural(p.projects.length, 'project')}` : `, ${p.projects[0] ? p.projects[0].label : 'one project'}`}. Last ${ago(p.lastTs)}.`,
      ),
      p.covered
        ? h('div', { class: 'note', style: { marginTop: '12px' } }, icon('alert'), h('span', null, 'There is already a rule for this, and you still say it. The rule is not working; a hook or a sharper rule will.'))
        : null,
    ),
    h(
      'div',
      { class: 'habit-side' },
      h('span', { class: ['chip', p.suggestion] }, `Becomes a ${KIND_SHORT[p.suggestion].toLowerCase()}`),
      h('a', { class: 'btn small', href: `#/draft/${p.id}/${p.suggestion}` }, icon('draft'), 'Draft it'),
    ),
  );
}

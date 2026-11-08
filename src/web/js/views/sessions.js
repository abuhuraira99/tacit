import { h, mount } from '../dom.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import { tokensText, usd, int, date, hours } from '../format.js';

export const title = 'Sessions';
const state = { q: '', sort: 'recent', project: '' };

export async function render() {
  const [projects] = await Promise.all([api.get('/api/projects')]);
  const body = h('tbody');
  const countEl = h('span', { class: 'muted small' });
  let timer;

  async function load() {
    const params = new URLSearchParams({ sort: state.sort });
    if (state.q) params.set('q', state.q);
    if (state.project) params.set('project', state.project);
    const data = await api.get(`/api/sessions?${params}`);
    countEl.textContent = `${int(data.total)} session${data.total === 1 ? '' : 's'}`;
    const peakMax = Math.max(1, ...data.items.map((s) => s.contextPeak));
    if (!data.items.length) {
      mount(body, h('tr', null, h('td', { colspan: 7, class: 'muted' }, 'No sessions match.')));
      return;
    }
    mount(
      body,
      data.items.map((s) =>
        h(
          'tr',
          {
            tabindex: 0,
            onclick: () => (location.hash = `#/sessions/${s.id}`),
            onkeydown: (e) => {
              if (e.key === 'Enter') location.hash = `#/sessions/${s.id}`;
            },
          },
          h('td', null, h('div', { class: 'cell-title', title: s.title }, s.title), h('div', { class: 'cell-sub' }, `${s.projectLabel}${s.branch ? ` on ${s.branch}` : ''}`)),
          h('td', { class: 'num' }, date(s.start), h('div', { class: 'cell-sub' }, hours(s.activeMs))),
          h('td', { class: 'r' }, int(s.promptCount)),
          h('td', { class: 'r' }, tokensText(s.tokens)),
          h('td', null, h('span', { class: 'mini-bar' }, h('i', { class: s.contextPeak > 150000 ? 'hot' : '', style: { width: `${(s.contextPeak / peakMax) * 100}%` } })), h('span', { class: 'num small' }, tokensText(s.contextPeak))),
          h('td', { class: 'r' }, s.compactions ? int(s.compactions) : h('span', { class: 'muted' }, '0')),
          h('td', { class: 'r' }, usd(s.costUSD), s.costReported ? null : h('span', { class: 'muted', title: 'Estimated from list prices' }, '*')),
        ),
      ),
    );
  }

  const search = h('input', {
    class: 'input',
    type: 'search',
    placeholder: 'Search titles and prompts',
    'aria-label': 'Search sessions',
    'data-search': '',
    value: state.q,
    oninput: (e) => {
      state.q = e.target.value;
      clearTimeout(timer);
      timer = setTimeout(load, 180);
    },
  });
  const sort = h(
    'select',
    {
      class: 'select',
      'aria-label': 'Sort sessions',
      onchange: (e) => {
        state.sort = e.target.value;
        load();
      },
    },
    [
      ['recent', 'Newest first'],
      ['cost', 'Most expensive'],
      ['tokens', 'Most tokens'],
      ['context', 'Biggest context'],
      ['prompts', 'Most prompts'],
    ].map(([v, l]) => h('option', { value: v }, l)),
  );
  sort.value = state.sort;
  const proj = h(
    'select',
    {
      class: 'select',
      'aria-label': 'Filter by project',
      onchange: (e) => {
        state.project = e.target.value;
        load();
      },
    },
    h('option', { value: '' }, 'All projects'),
    projects.map((p) => h('option', { value: p.id }, `${p.label} (${p.sessions})`)),
  );
  proj.value = state.project;

  await load();
  return h(
    'div',
    { class: 'page' },
    h('header', { class: 'page-head' }, h('div', null, h('h1', { class: 'page-title' }, 'Sessions'), h('p', { class: 'page-lede' }, 'Every conversation, with what it cost and how full the context got. Open one to see where the context went.'))),
    h('div', { class: 'toolbar' }, h('label', { class: 'search' }, icon('search'), search), proj, sort, h('span', { class: 'spacer' }), countEl),
    h(
      'div',
      { class: 'sheet table-wrap' },
      h(
        'table',
        { class: 'data' },
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            h('th', null, 'Session'),
            h('th', null, 'Started'),
            h('th', { class: 'r' }, 'Prompts'),
            h('th', { class: 'r' }, 'Tokens'),
            h('th', null, 'Peak context'),
            h('th', { class: 'r' }, 'Compactions'),
            h('th', { class: 'r' }, 'Cost'),
          ),
        ),
        body,
      ),
    ),
    h('p', { class: 'small muted', style: { marginTop: '12px' } }, 'Costs are what Claude Code recorded, or estimated from API list prices where marked *. On a subscription you are not billed per token.'),
  );
}

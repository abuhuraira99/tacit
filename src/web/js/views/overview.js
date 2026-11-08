import { h } from '../dom.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import { barChart, heatmap, hbars, tally, costLabel } from '../charts.js';
import { tokens, usd, int, pct, ago, plural, date, KIND_SHORT } from '../format.js';

export const title = 'Overview';

export async function render() {
  const o = await api.get('/api/overview');
  const t = o.totals;
  const [tokNum, tokUnit] = tokens(t.tokens);

  const head = h(
    'header',
    { class: 'page-head' },
    h(
      'div',
      null,
      h('h1', { class: 'page-title' }, 'Overview'),
      h('p', { class: 'page-lede' }, o.range.first ? `Everything you and Claude Code did between ${date(o.range.first)} and ${date(o.range.last)}, read from this machine.` : 'Your Claude Code history at a glance.'),
    ),
  );

  return h(
    'div',
    { class: 'page' },
    head,
    echo(o),
    h(
      'section',
      { class: 'figures', 'aria-label': 'Totals' },
      figure(int(t.sessions), '', 'Sessions', `${plural(t.projects, 'project')}`),
      figure(int(t.prompts), '', 'Your prompts', `${int(t.interrupts)} interruptions`),
      figure(t.activeHours.toFixed(t.activeHours < 10 ? 1 : 0), 'h', 'Active time', 'Idle gaps over 10 min removed'),
      figure(tokNum, tokUnit, 'Tokens processed', `${tokens(t.outputTokens).join('')} written by Claude`),
      figure(usd(t.costUSD), '', 'API-equivalent cost', t.reportedShare > 0.5 ? 'As recorded by Claude Code' : 'Estimated from list prices'),
      figure(pct(t.cacheHitRate, t.cacheHitRate > 0.99 ? 1 : 0), '', 'Prompt cache hits', `Saved about ${usd(t.cacheSavedUSD)}`),
    ),
    h(
      'div',
      { class: 'grid cols-7-5' },
      panel('Activity', 'Tokens per day. Hover a day for details.', o.daily.length ? barChart(o.daily, { value: (d) => d.tokens, label: costLabel }) : h('p', { class: 'muted' }, 'Not enough days yet.')),
      panel('When you work', 'Your prompts by weekday and hour.', heatmap(o.heat)),
    ),
    h(
      'div',
      { class: 'grid cols-3', style: { marginTop: '18px' } },
      panel('How Claude worked', 'Tool calls across all sessions.', o.tools.length ? hbars(o.tools.slice(0, 8)) : h('p', { class: 'muted' }, 'No tool calls yet.')),
      panel('Commands Claude ran', 'Most frequent shell commands.', o.commands.length ? hbars(o.commands.slice(0, 8)) : h('p', { class: 'muted' }, 'No shell commands yet.')),
      panel(
        'Projects',
        'Sessions per project.',
        o.topProjects.length
          ? hbars(o.topProjects.slice(0, 8).map((p) => ({ name: p.label, count: p.sessions })))
          : h('p', { class: 'muted' }, 'No projects yet.'),
      ),
    ),
    o.models.length
      ? h(
          'div',
          { class: 'grid cols-2', style: { marginTop: '18px' } },
          panel('Models', 'Share of tokens by model.', hbars(o.models.map((m) => ({ name: m.name, count: m.count })), { fmt: (n) => tokens(n).join('') })),
          panel(
            'Your setup in use',
            'Subagents, skills and slash commands that ran.',
            setupList(o),
          ),
        )
      : null,
  );
}

function echo(o) {
  const p = o.topPattern;
  if (!p) {
    return h(
      'section',
      { class: 'echo' },
      h('div', { class: 'echo-kicker' }, 'No repeated instructions yet'),
      h('p', { class: 'echo-quote' }, 'Nothing you say keeps coming back. ', h('span', { class: 'hl' }, 'That is a good sign.')),
      h('p', { class: 'echo-meta' }, 'Tacit checks again every time your history changes.'),
    );
  }
  // Earlier phrasings fade in above the current one, like the same words said again and again.
  const ghosts = (p.variants || []).filter((v) => v !== p.text).slice(0, 3).reverse();
  const section = h(
    'section',
    { class: 'echo echo-in', 'aria-labelledby': 'echo-q' },
    h(
      'div',
      { class: 'echo-stage' },
      h(
        'div',
        { class: 'echo-ghosts', 'aria-hidden': 'true' },
        ghosts.map((g, i) => h('div', { class: 'echo-ghost', style: { opacity: String(0.16 + i * 0.12), paddingLeft: `${(ghosts.length - i) * 14}px` } }, `“${g}”`)),
      ),
      h('p', { class: 'echo-quote', id: 'echo-q' }, h('span', { class: 'hl' }, `“${p.text}”`)),
    ),
    h(
      'div',
      { class: 'echo-kicker', style: { marginTop: '22px', marginBottom: '0' } },
      tally(p.count),
      h('span', null, 'Your most repeated instruction, said ', h('strong', null, `${p.count} times`), ` in ${plural(p.sessions, 'session')}${p.projects.length > 1 ? ` across ${plural(p.projects.length, 'project')}` : ''}.`),
    ),
    h(
      'p',
      { class: 'echo-meta', style: { marginTop: '8px' } },
      `Last said ${ago(p.lastTs)}. `,
      `${o.habitCount > 1 ? `${int(o.habitCount - 1)} more habits` : 'No other habits'}${o.briefCount ? ` and ${plural(o.briefCount, 'reused brief')}` : ''} are waiting in Repeats.`,
    ),
    h(
      'div',
      { class: 'echo-actions' },
      h('a', { class: 'btn primary', href: `#/draft/${p.id}/${p.suggestion}` }, icon('draft'), `Write it down as a ${KIND_SHORT[p.suggestion].toLowerCase()}`),
      h('a', { class: 'btn', href: '#/repeats' }, 'See everything you repeat'),
    ),
  );
  return section;
}

function figure(value, unit, label, note) {
  return h(
    'div',
    { class: 'figure' },
    h('div', { class: 'figure-value' }, value, unit ? h('span', { class: 'figure-unit' }, unit) : null),
    h('div', { class: 'figure-label' }, label),
    note ? h('div', { class: 'figure-note' }, note) : null,
  );
}

function panel(titleText, sub, body) {
  return h('section', { class: 'sheet panel' }, h('h2', { class: 'panel-title' }, titleText), h('p', { class: 'panel-sub' }, sub), body);
}

function setupList(o) {
  const rows = [
    ...o.agents.map((a) => ({ name: `Subagent: ${a.name}`, count: a.count })),
    ...o.skills.map((a) => ({ name: `Skill: ${a.name}`, count: a.count })),
    ...o.slash.map((a) => ({ name: `/${a.name}`, count: a.count })),
  ]
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
  if (!rows.length) return h('p', { class: 'muted' }, 'No subagents, skills or slash commands ran yet. Tacit can draft them from what you repeat.');
  return hbars(rows);
}

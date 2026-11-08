import { h } from '../dom.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import { contextChart, hbars } from '../charts.js';
import { tokens, tokensText, usd, int, dateTime, time, hours, plural } from '../format.js';

let current = null;
export const title = () => (current ? current.title : 'Session');

export async function render({ params }) {
  const s = await api.get(`/api/sessions/${params[0]}`);
  current = s;
  const L = s.lens;
  return h(
    'div',
    { class: 'page' },
    h('a', { class: 'crumb', href: '#/sessions' }, icon('back'), 'Sessions'),
    h(
      'header',
      { class: 'page-head' },
      h(
        'div',
        null,
        h('h1', { class: 'page-title', style: { fontSize: 'clamp(24px, 2.6vw, 32px)' } }, s.title),
        h('p', { class: 'page-lede' }, `${s.projectLabel}${s.branch ? ` on ${s.branch}` : ''}. ${dateTime(s.start)}, ${hours(s.activeMs)} active.`),
      ),
    ),
    h(
      'section',
      { class: 'figures', 'aria-label': 'Session totals' },
      fig(int(s.promptCount), '', 'Your prompts'),
      fig(...tokens(s.tokens), 'Tokens'),
      fig(...tokens(s.contextPeak), 'Peak context'),
      fig(int(s.toolCalls), '', 'Tool calls'),
      fig(int(s.agentRuns), '', 'Subagent runs'),
      fig(usd(s.costUSD), '', s.cost.reported ? 'Cost (recorded)' : 'Cost (estimated)'),
    ),
    h(
      'div',
      { class: 'grid cols-7-5' },
      h(
        'section',
        { class: 'sheet panel' },
        h('h2', { class: 'panel-title' }, 'Context over the session'),
        h('p', { class: 'panel-sub' }, `How much Claude was holding at each turn. ${L.compactions.length ? `Compacted ${plural(L.compactions.length, 'time')}.` : 'Never compacted.'}`),
        contextChart(L.curve, L.compactions),
      ),
      h('section', null, h('h2', { class: 'panel-title', style: { margin: '4px 0 12px' } }, 'What stands out'), h('div', { class: 'findings' }, L.findings.map((f) => h('div', { class: ['finding', f.level] }, h('span', { class: 'dot' }), h('div', null, h('b', null, f.title), h('p', null, f.detail)))))),
    ),
    h(
      'div',
      { class: 'grid cols-7-5', style: { marginTop: '18px' } },
      h(
        'section',
        { class: 'sheet panel' },
        h('h2', { class: 'panel-title' }, 'What you asked'),
        h('p', { class: 'panel-sub' }, `${plural(s.prompts.length, 'prompt')}${s.interrupts ? `, ${plural(s.interrupts, 'interruption')}` : ''}. Keys and tokens are redacted.`),
        s.prompts.length
          ? h(
              'ol',
              { class: 'prompts' },
              s.prompts.map((p) => {
                const text = h('div', { class: 'text' }, p.text);
                const long = p.text.length > 420 || p.text.split('\n').length > 6;
                return h(
                  'li',
                  null,
                  h('time', { datetime: p.ts }, time(p.ts)),
                  h(
                    'div',
                    null,
                    text,
                    long
                      ? h(
                          'button',
                          {
                            class: 'more',
                            type: 'button',
                            onclick: (e) => {
                              const open = text.classList.toggle('open');
                              e.currentTarget.textContent = open ? 'Show less' : 'Show all';
                            },
                          },
                          'Show all',
                        )
                      : null,
                  ),
                );
              }),
            )
          : h('p', { class: 'muted' }, 'No typed prompts in this session.'),
      ),
      h(
        'div',
        { class: 'stack' },
        h(
          'section',
          { class: 'sheet panel' },
          h('h2', { class: 'panel-title' }, 'Biggest tool outputs'),
          h('p', { class: 'panel-sub' }, `${tokensText(L.toolResultTokens)} tokens of tool output in total.`),
          L.heavy.length ? hbars(L.heavy.slice(0, 8).map((x) => ({ name: x.target ? `${x.tool}: ${x.target.split(/[\\/]/).pop()}` : x.tool, count: x.tokens })), { fmt: tokensText }) : h('p', { class: 'muted' }, 'None.'),
        ),
        h('section', { class: 'sheet panel' }, h('h2', { class: 'panel-title' }, 'Tools used'), h('p', { class: 'panel-sub' }, `${int(s.toolCalls)} calls, ${int(s.editedFiles)} files edited.`), s.tools.length ? hbars(s.tools.slice(0, 8)) : h('p', { class: 'muted' }, 'None.')),
        h(
          'section',
          { class: 'sheet panel' },
          h('h2', { class: 'panel-title' }, 'Details'),
          h(
            'dl',
            { class: 'kv' },
            h('dt', null, 'Folder'),
            h('dd', null, s.cwd || '–'),
            h('dt', null, 'Models'),
            h('dd', null, s.models.join(', ') || '–'),
            h('dt', null, 'Lines'),
            h('dd', null, s.linesAdded || s.linesRemoved ? `+${int(s.linesAdded)} / −${int(s.linesRemoved)}` : '–'),
            h('dt', null, 'Started from'),
            h('dd', null, s.entrypoint || '–'),
            h('dt', null, 'Claude Code'),
            h('dd', null, s.version || '–'),
            h('dt', null, 'Session id'),
            h('dd', { class: 'small' }, s.id),
          ),
        ),
      ),
    ),
  );
}

function fig(value, unit, label) {
  return h('div', { class: 'figure' }, h('div', { class: 'figure-value' }, value, unit ? h('span', { class: 'figure-unit' }, unit) : null), h('div', { class: 'figure-label' }, label));
}

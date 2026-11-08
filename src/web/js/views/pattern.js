import { h } from '../dom.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import { tally } from '../charts.js';
import { plural, ago, dateTime, date, KIND_LABEL, KIND_EXPLAIN, KIND_SHORT } from '../format.js';

let current = null;
export const title = () => (current ? current.title : 'Repeat');

export async function render({ params }) {
  const p = await api.get(`/api/patterns/${params[0]}`);
  current = p;
  const kinds = ['rule', 'skill', 'hook', 'subagent', 'command'];
  return h(
    'div',
    { class: 'page' },
    h('a', { class: 'crumb', href: '#/repeats' }, icon('back'), 'Repeats'),
    h(
      'header',
      { class: 'detail-head' },
      h('div', { class: 'row' }, tally(p.count), h('span', { class: 'habit-title' }, p.title)),
      h('p', { class: 'habit-quote' }, p.text),
      h(
        'p',
        { class: 'muted' },
        p.kind === 'brief'
          ? `You pasted this brief ${p.count} times in ${plural(p.sessions, 'session')}, first on ${date(p.firstTs)} and most recently ${ago(p.lastTs)}.`
          : `You said this ${p.count} times in ${plural(p.sessions, 'session')} across ${plural(p.projects.length, 'project')}: ${p.projects.map((x) => x.label).join(', ')}. First on ${date(p.firstTs)}, most recently ${ago(p.lastTs)}.`,
      ),
      p.covered
        ? h('div', { class: 'note', style: { marginTop: '14px' } }, icon('alert'), h('span', null, `A rule already covers this in ${p.covered.file.split(/[\\/]/).slice(-2).join('/')} (line ${p.covered.line}): “${p.covered.text.replace(/[.\s]+$/, '')}”. You still repeat it, so the rule is not doing its job. Consider a hook, or a sharper rule higher in the file.`))
        : null,
    ),
    h('h2', { class: 'section-title' }, 'Turn it into'),
    h(
      'div',
      { class: 'kind-cards' },
      kinds.map((k) =>
        h(
          'a',
          { class: ['kind-card', p.suggestion === k && 'suggested'], href: `#/draft/${p.id}/${k}` },
          p.suggestion === k ? h('span', { class: 'tag' }, 'Suggested') : null,
          h('b', null, KIND_LABEL[k]),
          h('span', null, KIND_EXPLAIN[k]),
        ),
      ),
    ),
    h(
      'div',
      { class: 'grid cols-2', style: { marginTop: '28px' } },
      p.variants && p.variants.length > 1
        ? h(
            'section',
            { class: 'sheet panel' },
            h('h2', { class: 'panel-title' }, 'How you phrased it'),
            h('p', { class: 'panel-sub' }, 'Different words, same instruction. Tacit grouped these together.'),
            h('ul', { class: 'variants' }, p.variants.slice(0, 8).map((v) => h('li', null, `“${v}”`))),
          )
        : h(
            'section',
            { class: 'sheet panel' },
            h('h2', { class: 'panel-title' }, 'Why this matters'),
            h('p', { class: 'muted' }, `Every repeat costs you a message and costs Claude a turn of context. Written down once as a ${KIND_SHORT[p.suggestion].toLowerCase()}, it applies without being asked.`),
          ),
      timeline(p.occurrences),
    ),
  );
}

function timeline(occurrences) {
  const SHOW = 12;
  const item = (o) => h('li', null, h('time', { datetime: o.ts }, dateTime(o.ts)), h('div', null, h('a', { href: `#/sessions/${o.sessionId}` }, o.text), h('span', { class: 'where' }, o.projectLabel)));
  const list = h('ol', { class: 'timeline' }, occurrences.slice(0, SHOW).map(item));
  const more =
    occurrences.length > SHOW
      ? h(
          'button',
          {
            class: 'btn small ghost',
            type: 'button',
            onclick: (e) => {
              list.replaceChildren(...occurrences.map(item));
              e.currentTarget.remove();
            },
          },
          `Show all ${occurrences.length}`,
        )
      : null;
  return h('section', { class: 'sheet panel' }, h('h2', { class: 'panel-title' }, 'Every time you said it'), h('p', { class: 'panel-sub' }, 'Newest first. Open one to see the whole session.'), list, more);
}

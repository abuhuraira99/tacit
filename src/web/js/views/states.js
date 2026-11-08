import { h } from '../dom.js';
import { int } from '../format.js';

export function loadingView(status) {
  const p = (status && status.progress) || { done: 0, total: 0 };
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 4;
  return h(
    'section',
    { class: 'loading', 'aria-busy': 'true' },
    h('h2', null, 'Reading your history'),
    h('p', { class: 'muted' }, p.total ? `${int(p.done)} of ${int(p.total)} transcripts. The first read takes a few seconds; after that Tacit only reads what changed.` : 'Looking for Claude Code transcripts on this machine.'),
    h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': pct }, h('i', { style: { width: `${pct}%` } })),
    h('p', { class: 'muted small' }, 'Nothing leaves your computer. Tacit reads the files and keeps the results here.'),
  );
}

export function emptyView(status) {
  return h(
    'section',
    { class: 'sheet empty' },
    h('h2', null, 'No Claude Code history here yet'),
    h('p', null, 'Tacit looked in ', h('code', null, status.projectsDir || '~/.claude/projects'), ' and found no transcripts.'),
    h('p', null, 'If you use Claude Code with a different config folder, point Tacit at it in Settings. To see what Tacit does first, start it with sample data: ', h('code', null, 'npx tacit --demo'), '.'),
    h('div', { class: 'row' }, h('a', { class: 'btn primary', href: '#/settings' }, 'Choose a folder')),
  );
}

export function errorView(message, notFound = false) {
  return h(
    'section',
    { class: 'sheet empty' },
    h('h2', null, notFound ? 'Nothing at this address' : 'Something went wrong'),
    h('p', null, message),
    h('div', { class: 'row' }, h('a', { class: 'btn', href: '#/' }, 'Go to overview'), notFound ? null : h('button', { class: 'btn ghost', type: 'button', onclick: () => location.reload() }, 'Reload')),
  );
}

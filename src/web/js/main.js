import { h, mount, toast } from './dom.js';
import { api, events } from './api.js';
import { icon } from './icons.js';
import { int } from './format.js';
import { loadingView, emptyView, errorView } from './views/states.js';

const view = document.getElementById('view');
const nav = document.getElementById('nav');
const scanState = document.getElementById('scan-state');
const rail = document.getElementById('rail');

let status = null;
let renderToken = 0;
let lastReadyAt = null;

const ROUTES = [
  { re: /^#?\/?$/, name: 'overview', load: () => import('./views/overview.js') },
  { re: /^#\/repeats\/?$/, name: 'repeats', load: () => import('./views/repeats.js') },
  { re: /^#\/repeats\/([\w-]+)$/, name: 'repeats', load: () => import('./views/pattern.js') },
  { re: /^#\/draft\/([\w-]+)\/(rule|skill|hook|subagent|command)$/, name: 'repeats', load: () => import('./views/draft.js') },
  { re: /^#\/sessions\/?$/, name: 'sessions', load: () => import('./views/sessions.js') },
  { re: /^#\/sessions\/([\w-]+)$/, name: 'sessions', load: () => import('./views/session.js') },
  { re: /^#\/memory\/?$/, name: 'memory', load: () => import('./views/memory.js') },
  { re: /^#\/startup\/?(?:\?.*)?$/, name: 'startup', load: () => import('./views/startup.js') },
  { re: /^#\/report\/?$/, name: 'report', load: () => import('./views/report.js') },
  { re: /^#\/settings\/?$/, name: 'settings', load: () => import('./views/settings.js') },
];

const NAV = [
  { name: 'overview', href: '#/', label: 'Overview', icon: 'overview' },
  { name: 'repeats', href: '#/repeats', label: 'Repeats', icon: 'repeats', count: (s) => s.counts?.patterns },
  { name: 'sessions', href: '#/sessions', label: 'Sessions', icon: 'sessions', count: (s) => s.counts?.sessions },
  { name: 'memory', href: '#/memory', label: 'Memory health', icon: 'memory' },
  { name: 'startup', href: '#/startup', label: 'Startup memory', icon: 'startup' },
  { name: 'report', href: '#/report', label: 'Report', icon: 'report' },
];

function drawNav(active) {
  const items = NAV.map((n) =>
    h(
      'a',
      { href: n.href, 'aria-current': n.name === active ? 'page' : null },
      icon(n.icon),
      h('span', null, n.label),
      h('span', { class: 'count' }, status && n.count && n.count(status) != null ? int(n.count(status)) : ''),
    ),
  );
  mount(
    nav,
    items,
    h('div', { class: 'nav-group-label' }, 'Setup'),
    h('a', { href: '#/settings', 'aria-current': active === 'settings' ? 'page' : null }, icon('settings'), h('span', null, 'Settings'), h('span')),
  );
}

function drawScanState() {
  if (!status) return;
  let dot = 'scan-dot';
  let text;
  if (status.status === 'scanning') {
    dot += ' busy';
    const p = status.progress || {};
    text = p.total ? `Reading ${int(p.done)} of ${int(p.total)} transcripts` : 'Looking for transcripts';
  } else if (status.status === 'error') {
    dot += ' err';
    text = 'Could not read history';
  } else if (status.status === 'ready') {
    const files = status.stats?.files ?? 0;
    text = status.demo ? `Demo data, ${int(files)} transcripts` : `Up to date, ${int(files)} transcripts`;
  } else text = 'Starting';
  mount(scanState, h('span', { class: dot }), h('span', null, text));
}

async function route() {
  const hash = location.hash || '#/';
  const match = ROUTES.map((r) => ({ r, m: hash.match(r.re) })).find((x) => x.m);
  const active = match ? match.r.name : 'overview';
  drawNav(active);
  rail.classList.remove('open');
  document.getElementById('menu').setAttribute('aria-expanded', 'false');

  if (!status || status.status === 'idle' || (status.status === 'scanning' && !lastReadyAt)) {
    if (match && match.r.name === 'settings') return renderRoute(match, hash);
    mount(view, loadingView(status));
    return;
  }
  if (status.status === 'error' && !lastReadyAt && active !== 'settings') {
    mount(view, errorView(status.error));
    return;
  }
  if (status.empty && active !== 'settings') {
    mount(view, emptyView(status));
    return;
  }
  if (!match) {
    mount(view, errorView('That page does not exist.', true));
    return;
  }
  return renderRoute(match, hash);
}

async function renderRoute(match, hash) {
  const my = ++renderToken;
  try {
    const mod = await match.r.load();
    const node = await mod.render({ params: match.m.slice(1), status, hash });
    if (my !== renderToken) return;
    mount(view, node);
    document.title = `${mod.title ? (typeof mod.title === 'function' ? mod.title() : mod.title) + ' · ' : ''}Tacit`;
    if (!hash.includes('?')) window.scrollTo({ top: 0 });
    document.getElementById('main').focus({ preventScroll: true });
  } catch (err) {
    if (my !== renderToken) return;
    if (err.status === 503) {
      mount(view, loadingView(status));
      return;
    }
    mount(view, errorView(err.message || String(err)));
  }
}

// ---------- live scan status ----------
async function boot() {
  applyTheme(localStorage.getItem('tacit-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  try {
    status = await api.get('/api/status');
  } catch {
    status = { status: 'error', error: 'The Tacit server is not responding. Restart it with "npx tacit" or "node bin/tacit.js".' };
  }
  drawScanState();
  route();
  events((s) => {
    const was = status ? status.status : null;
    status = { ...status, ...s };
    drawScanState();
    if (s.status === 'ready') {
      api.get('/api/status').then((full) => {
        status = full;
        drawScanState();
        drawNav(currentRouteName());
        const firstReady = !lastReadyAt;
        const changed = lastReadyAt && full.scannedAt !== lastReadyAt;
        lastReadyAt = full.scannedAt;
        if (firstReady || changed || was !== 'ready') route();
        if (changed) toast('History refreshed.');
      });
    } else if (s.status === 'error') {
      if (!lastReadyAt) route();
      toast(`Could not read history: ${s.error}`, 'err');
    } else if (!lastReadyAt) {
      mount(view, loadingView(status));
    }
  });
}

function currentRouteName() {
  const hash = location.hash || '#/';
  const m = ROUTES.find((r) => r.re.test(hash));
  return m ? m.name : 'overview';
}

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  const btn = document.getElementById('theme');
  mount(btn, icon(t === 'dark' ? 'sun' : 'moon'), h('span', null, t === 'dark' ? 'Light' : 'Dark'));
  btn.setAttribute('aria-label', t === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
}

document.getElementById('theme').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('tacit-theme', next);
  applyTheme(next);
});

document.getElementById('rescan').addEventListener('click', async () => {
  try {
    await api.post('/api/scan');
    toast('Reading your history again.');
  } catch (e) {
    toast(e.message, 'err');
  }
});

document.getElementById('menu').addEventListener('click', (e) => {
  const open = rail.classList.toggle('open');
  e.currentTarget.setAttribute('aria-expanded', String(open));
});

document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !/input|textarea|select/i.test(document.activeElement.tagName)) {
    const s = document.querySelector('[data-search]');
    if (s) {
      e.preventDefault();
      s.focus();
    }
  }
  if (e.key === 'Escape') rail.classList.remove('open');
});

window.addEventListener('hashchange', route);
export function refreshRoute() {
  route();
}
boot();

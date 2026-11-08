import { h, tip, escapeHtml } from './dom.js';
import { tokensText, int, date, usd } from './format.js';

/** Daily bars. data: [{date, value, ...}] */
export function barChart(data, { value = (d) => d.value, label = (d) => '', height = 180 } = {}) {
  const W = 720;
  const H = height;
  const padL = 34;
  const padB = 24;
  const max = Math.max(1, ...data.map(value));
  const n = data.length || 1;
  const bw = (W - padL) / n;
  const ticks = niceTicks(max, 3);
  const svg = h('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Activity per day' });
  for (const t of ticks) {
    const y = H - padB - (t / ticks[ticks.length - 1]) * (H - padB - 8);
    svg.appendChild(h('line', { class: 'grid-line', x1: padL, x2: W, y1: y, y2: y }));
    svg.appendChild(h('text', { x: padL - 6, y: y + 4, 'text-anchor': 'end' }, short(t)));
  }
  const top = ticks[ticks.length - 1];
  data.forEach((d, i) => {
    const v = value(d);
    const bh = (v / top) * (H - padB - 8);
    const x = padL + i * bw + bw * 0.16;
    const rect = h('rect', {
      class: ['bar', v === 0 && 'dim'],
      x,
      y: H - padB - Math.max(bh, v > 0 ? 2 : 1),
      width: Math.max(1, bw * 0.68),
      height: Math.max(bh, v > 0 ? 2 : 1),
      rx: Math.min(3, bw * 0.3),
      tabindex: v ? 0 : -1,
    });
    rect.addEventListener('mousemove', (e) => tip(e, label(d)));
    rect.addEventListener('mouseleave', (e) => tip(e, null));
    svg.appendChild(rect);
  });
  // Month/day labels: first, middle, last.
  const idx = [...new Set([0, Math.floor(n / 2), n - 1])];
  for (const i of idx) {
    if (!data[i]) continue;
    svg.appendChild(h('text', { x: padL + i * bw + bw / 2, y: H - 6, 'text-anchor': i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle' }, date(data[i].date + 'T12:00:00')));
  }
  return svg;
}

/** Context size across a session, with compaction markers. points: [[ts, ctx, out]] */
export function contextChart(points, compactions = [], { height = 220 } = {}) {
  const W = 720;
  const H = height;
  const padL = 40;
  const padB = 22;
  if (!points.length) return h('p', { class: 'muted small' }, 'No assistant turns were recorded for this session.');
  const max = Math.max(1, ...points.map((p) => p[1]));
  const ticks = niceTicks(max, 3);
  const top = ticks[ticks.length - 1];
  const x = (i) => padL + (i / Math.max(1, points.length - 1)) * (W - padL - 4);
  const y = (v) => H - padB - (v / top) * (H - padB - 10);
  const svg = h('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Context window size over the session' });
  for (const t of ticks) {
    svg.appendChild(h('line', { class: 'grid-line', x1: padL, x2: W, y1: y(t), y2: y(t) }));
    svg.appendChild(h('text', { x: padL - 6, y: y(t) + 4, 'text-anchor': 'end' }, short(t)));
  }
  let line = '';
  points.forEach((p, i) => (line += `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[1]).toFixed(1)}`));
  const area = `${line}L${x(points.length - 1).toFixed(1)},${H - padB}L${x(0).toFixed(1)},${H - padB}Z`;
  svg.appendChild(h('path', { class: 'area', d: area }));
  svg.appendChild(h('path', { class: 'line', d: line }));
  // Compaction markers placed by timestamp.
  for (const c of compactions) {
    if (!c.ts) continue;
    let idx = points.findIndex((p) => p[0] && p[0] >= c.ts);
    if (idx < 0) idx = points.length - 1;
    const cx = x(idx);
    svg.appendChild(h('line', { class: 'marker-line', x1: cx, x2: cx, y1: 6, y2: H - padB }));
    svg.appendChild(h('text', { x: cx + 5, y: 16 }, 'compacted'));
  }
  const hit = h('rect', { x: padL, y: 0, width: W - padL, height: H - padB, fill: 'transparent' });
  hit.addEventListener('mousemove', (e) => {
    const box = svg.getBoundingClientRect();
    const rel = ((e.clientX - box.left) / box.width) * W;
    const i = Math.max(0, Math.min(points.length - 1, Math.round(((rel - padL) / (W - padL - 4)) * (points.length - 1))));
    const p = points[i];
    tip(e, `<b>${tokensText(p[1])} tokens</b> in context<br>${p[2] ? `${int(p[2])} written this turn<br>` : ''}${p[0] ? escapeHtml(new Date(p[0]).toLocaleTimeString()) : ''}`);
  });
  hit.addEventListener('mouseleave', (e) => tip(e, null));
  svg.appendChild(hit);
  return svg;
}

/** Weekday x hour heat grid. */
export function heatmap(heat) {
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const max = Math.max(1, ...heat.flat());
  const grid = h('div', { class: 'heat', role: 'img', 'aria-label': 'Prompts by weekday and hour' });
  heat.forEach((row, d) => {
    grid.appendChild(h('span', { class: 'heat-label' }, days[d]));
    row.forEach((v, hr) => {
      const cell = h('span', { class: 'heat-cell', style: { opacity: v ? 0.12 + 0.88 * Math.sqrt(v / max) : 0.05 } });
      cell.addEventListener('mousemove', (e) => tip(e, `<b>${int(v)} prompt${v === 1 ? '' : 's'}</b><br>${days[d]} ${String(hr).padStart(2, '0')}:00`));
      cell.addEventListener('mouseleave', (e) => tip(e, null));
      grid.appendChild(cell);
    });
  });
  const hours = h('div', { class: 'heat-hours', 'aria-hidden': 'true' }, h('span'));
  for (let i = 0; i < 24; i++) hours.appendChild(h('span', null, i % 6 === 0 ? String(i).padStart(2, '0') : ''));
  return h('div', null, grid, hours);
}

/** Horizontal bars for ranked lists. */
export function hbars(items, { fmt = int, max } = {}) {
  const top = max || Math.max(1, ...items.map((x) => x.count));
  return h(
    'div',
    { class: 'hbars' },
    items.map((it) =>
      h(
        'div',
        { class: 'hbar' },
        h('span', { class: 'hbar-name', title: it.name }, it.name),
        h('span', { class: 'hbar-track' }, h('span', { class: 'hbar-fill', style: { width: `${Math.max(2, (it.count / top) * 100)}%`, display: 'block' } })),
        h('span', { class: 'hbar-value' }, fmt(it.count)),
      ),
    ),
  );
}

/**
 * Tally marks: groups of five, slightly hand-set. Caps at 25 strokes, then "+n".
 */
export function tally(n, { cap = 25, label } = {}) {
  const strokes = Math.min(n, cap);
  const groups = Math.ceil(strokes / 5);
  const gw = 30;
  const svg = h('svg', { viewBox: `0 0 ${groups * gw} 24`, 'aria-hidden': 'true' });
  let drawn = 0;
  for (let g = 0; g < groups; g++) {
    const inGroup = Math.min(5, strokes - drawn);
    const ox = g * gw + 2;
    for (let i = 0; i < Math.min(4, inGroup); i++) {
      const jitter = ((g * 7 + i * 3) % 5) * 0.25 - 0.5;
      svg.appendChild(h('path', { d: `M${ox + i * 5.5 + jitter},${3 + (i % 2) * 0.6} L${ox + i * 5.5 - jitter * 0.6},${21 - (i % 3) * 0.5}` }));
    }
    if (inGroup === 5) svg.appendChild(h('path', { d: `M${ox - 2.5},18 L${ox + 20.5},5.5` }));
    drawn += inGroup;
  }
  return h('span', { class: 'tally', title: label || `${n} times` }, svg, n > cap ? h('span', { class: 'more' }, `+${n - cap}`) : null, h('span', { class: 'sr-only' }, `${n} times`));
}

/** Score ring 0..100. */
export function ring(score) {
  const r = 44;
  const c = 2 * Math.PI * r;
  const color = score >= 85 ? 'var(--moss)' : score >= 60 ? 'var(--amber)' : 'var(--brick)';
  return h(
    'div',
    { class: 'ring', role: 'img', 'aria-label': `Score ${score} out of 100` },
    h('svg', { viewBox: '0 0 104 104' }, h('circle', { class: 'bg', cx: 52, cy: 52, r }), h('circle', { class: 'fg', cx: 52, cy: 52, r, stroke: color, 'stroke-dasharray': `${(score / 100) * c} ${c}` })),
    h('span', { class: 'ring-value' }, String(score)),
  );
}

export function costLabel(d) {
  return `<b>${escapeHtml(date(d.date + 'T12:00:00', { weekday: 'short', month: 'short', day: 'numeric' }))}</b><br>${int(d.prompts)} prompts in ${int(d.sessions)} sessions<br>${tokensText(d.tokens)} tokens, ${usd(d.costUSD)}`;
}

function niceTicks(max, count) {
  const raw = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const ticks = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(v);
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

function short(n) {
  return tokensText(n);
}

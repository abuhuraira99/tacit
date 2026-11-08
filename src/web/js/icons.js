import { h } from './dom.js';

// 24px stroke icons drawn for Tacit. Stroke colour comes from CSS (currentColor).
const P = {
  overview: 'M4 13h4v7H4zM10 4h4v16h-4zM16 9h4v11h-4z',
  repeats: 'M4 7c5-3 11-3 16 0M4 12c5-3 11-3 16 0M4 17c5-3 11-3 16 0',
  draft: 'M5 19h4L19.5 8.5a2.1 2.1 0 0 0-3-3L6 16v3zM14.5 7.5l3 3',
  sessions: 'M4 6h16M4 12h16M4 18h10',
  memory: 'M6 4h9l3 3v13H6zM9 10h6M9 14h6M9 18h3',
  report: 'M7 4h10v16H7zM10 8h4M10 12h4M10 16h2',
  settings: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  copy: 'M9 9h10v11H9zM5 15V4h10',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  save: 'M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6',
  spark: 'M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6',
  back: 'M15 5l-7 7 7 7',
  alert: 'M12 4 3 20h18zM12 10v4M12 17v.5',
  check: 'M5 12.5 10 17l9-10',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  folder: 'M3 7h6l2 2h10v10H3z',
  refresh: 'M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6 19 19M5 19l1.4-1.4M17.6 6.4 19 5',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
};

export function icon(name, cls) {
  return h(
    'svg',
    { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true', class: ['icon', cls], fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
    h('path', { d: P[name] || P.spark }),
  );
}

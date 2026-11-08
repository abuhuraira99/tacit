/**
 * Per-million-token list prices (USD) used to estimate API-equivalent cost when a
 * transcript has no cost record of its own. Cache writes are 1.25x input for the
 * 5-minute TTL and 2x input for the 1-hour TTL.
 * Source: Anthropic model pricing as of 2026-10.
 */
const TABLE = [
  // [prefix, input, output, cacheRead]
  ['claude-fable-5-1', 10, 50, 0.25],
  ['claude-mythos-5-1', 10, 50, 0.25],
  ['claude-fable-5', 10, 50, 1.0],
  ['claude-mythos-5', 10, 50, 1.0],
  ['claude-opus-5-5', 4, 20, 0.2],
  ['claude-opus-5', 5, 25, 0.5],
  ['claude-opus-4-8', 5, 25, 0.5],
  ['claude-opus-4-7', 5, 25, 0.5],
  ['claude-opus-4-6', 5, 25, 0.5],
  ['claude-opus-4-5', 5, 25, 0.5],
  ['claude-opus-4-1', 15, 75, 1.5],
  ['claude-opus-4', 15, 75, 1.5],
  ['claude-sonnet-5-5', 2, 10, 0.2],
  ['claude-sonnet-5', 2, 10, 0.2],
  ['claude-sonnet-4', 3, 15, 0.3],
  ['claude-3-7-sonnet', 3, 15, 0.3],
  ['claude-haiku-5-5', 0.1, 0.5, 0.01],
  ['claude-haiku-4-5', 1, 5, 0.1],
  ['claude-3-5-haiku', 0.8, 4, 0.08],
];

export function priceFor(model) {
  const m = String(model || '').toLowerCase().replace(/^(?:anthropic\.|us\.anthropic\.|eu\.anthropic\.)/, '');
  for (const [prefix, input, output, cacheRead] of TABLE) {
    if (m.startsWith(prefix)) return { input, output, cacheRead, known: true };
  }
  // Unknown model: price like the current Sonnet so totals stay in a sensible range.
  return { input: 2, output: 10, cacheRead: 0.2, known: false };
}

/** Estimated USD for a usage bucket { in, out, cw5m, cw1h, cr }. */
export function estimateCost(model, u) {
  const p = priceFor(model);
  return (
    (u.in * p.input + u.out * p.output + u.cw5m * p.input * 1.25 + u.cw1h * p.input * 2 + u.cr * p.cacheRead) / 1e6
  );
}

/** What the cache saved versus paying full input price for every cache read. */
export function cacheSavings(model, u) {
  const p = priceFor(model);
  return (u.cr * (p.input - p.cacheRead)) / 1e6;
}

/** Friendly model label: claude-opus-5-5 -> Opus 5.5 */
export function modelLabel(model) {
  const m = String(model || '').toLowerCase();
  const fam = /(opus|sonnet|haiku|fable|mythos)/.exec(m);
  if (!fam) return model || 'unknown';
  const name = fam[1][0].toUpperCase() + fam[1].slice(1);
  const after = m.slice(m.indexOf(fam[1]) + fam[1].length);
  const ver = /-(\d+)(?:-(\d{1,2}))?(?:-|$)/.exec(after);
  if (ver) return `${name} ${ver[1]}${ver[2] ? '.' + ver[2] : ''}`;
  const before = /claude-(\d)-(\d)/.exec(m);
  if (before) return `${name} ${before[1]}.${before[2]}`;
  return name;
}

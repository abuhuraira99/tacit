export function tokens(n) {
  n = n || 0;
  if (n >= 1e9) return [(n / 1e9).toFixed(n >= 1e10 ? 1 : 2), 'B'];
  if (n >= 1e6) return [(n / 1e6).toFixed(n >= 1e8 ? 0 : 1), 'M'];
  if (n >= 1e3) return [Math.round(n / 1e3).toString(), 'k'];
  return [String(Math.round(n)), ''];
}
export const tokensText = (n) => tokens(n).join('');

export function usd(n) {
  n = n || 0;
  if (n >= 1000) return `$${Math.round(n).toLocaleString('en-US')}`;
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n > 0) return `$${n.toFixed(3)}`;
  return '$0';
}

export const int = (n) => Math.round(n || 0).toLocaleString('en-US');
export const pct = (x, digits = 0) => `${((x || 0) * 100).toFixed(digits)}%`;

export function hours(ms) {
  const h = (ms || 0) / 3.6e6;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  return `${h.toFixed(h < 10 ? 1 : 0)} h`;
}

export function date(iso, opts = { month: 'short', day: 'numeric' }) {
  if (!iso) return '–';
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, sameYear ? opts : { ...opts, year: 'numeric' });
}

export function dateTime(iso) {
  if (!iso) return '–';
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function time(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function ago(iso) {
  if (!iso) return 'never';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} minutes ago`;
  if (s < 86400) return `${Math.round(s / 3600)} hours ago`;
  const d = Math.round(s / 86400);
  if (d === 1) return 'yesterday';
  if (d < 30) return `${d} days ago`;
  return date(iso);
}

export const plural = (n, one, many = `${one}s`) => `${int(n)} ${n === 1 ? one : many}`;

export const KIND_LABEL = { rule: 'CLAUDE.md rule', skill: 'Skill', hook: 'Hook', subagent: 'Subagent', command: 'Slash command' };
export const KIND_SHORT = { rule: 'Rule', skill: 'Skill', hook: 'Hook', subagent: 'Subagent', command: 'Command' };
export const KIND_EXPLAIN = {
  rule: 'One line Claude reads at the start of every session.',
  skill: 'A playbook Claude loads only when the task matches.',
  hook: 'A command that runs automatically, so it can’t be forgotten.',
  subagent: 'A specialist that works in its own context and reports back.',
  command: 'A /shortcut that replaces a prompt you paste again and again.',
};

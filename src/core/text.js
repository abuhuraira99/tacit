/**
 * Turning raw user turns from a transcript into the words a person actually typed.
 */

// Wrappers Claude Code and IDE integrations inject around (or instead of) human text.
const STRIP_BLOCKS = [
  'system-reminder',
  'ide_selection',
  'ide_opened_file',
  'ide_diagnostics',
  'pasted_content',
  'command-message',
  'command-args',
  'local-command-stdout',
  'local-command-stderr',
  'local-command-caveat',
  'user-prompt-submit-hook',
  'bash-input',
  'bash-stdout',
  'bash-stderr',
];

const BLOCK_RE = new RegExp(`<(${STRIP_BLOCKS.join('|')})(?:\\s[^>]*)?>[\\s\\S]*?<\\/\\1>`, 'g');
const COMMAND_NAME_RE = /<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/;

/** Extract plain text from a message `content` (string or block array). */
export function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let s = '';
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') s += (s ? '\n' : '') + block.text;
  }
  return s;
}

/**
 * Classify a raw user text.
 * Returns { kind: 'prompt' | 'command' | 'interrupt' | 'noise', text, command }.
 */
export function classifyUserText(raw) {
  if (!raw) return { kind: 'noise', text: '' };
  const trimmed = raw.trim();
  if (trimmed.startsWith('[Request interrupted by user')) return { kind: 'interrupt', text: '' };
  const cmd = COMMAND_NAME_RE.exec(trimmed);
  if (cmd) return { kind: 'command', text: '', command: cmd[1].replace(/^\//, '') };
  if (/^Caveat: The messages below were generated/i.test(trimmed)) return { kind: 'noise', text: '' };
  if (/^This session is being continued from a previous conversation/i.test(trimmed)) return { kind: 'noise', text: '' };
  const text = cleanPrompt(trimmed);
  if (!text) return { kind: 'noise', text: '' };
  return { kind: 'prompt', text };
}

export function cleanPrompt(raw) {
  let s = raw.replace(BLOCK_RE, ' ');
  // Any leftover single wrapper tags (unterminated blocks) are dropped too.
  s = s.replace(/<\/?(?:system-reminder|ide_selection|ide_opened_file)[^>]*>/g, ' ');
  s = s.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/** Lowercase, strip punctuation and noise so near-identical phrasings line up. */
export function normalize(s) {
  return s
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' url ')
    .replace(/`[^`]*`/g, (m) => m.replace(/[^a-z0-9]+/g, ' '))
    .replace(/[“”"]/g, ' ')
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Split a prompt into clause-sized candidates for habit mining. */
export function splitClauses(text) {
  const lines = text
    .replace(/```[\s\S]*?```/g, '\n')
    .split(/\n+/)
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.):]|[a-z][.)])\s+/i, '').trim())
    .filter(Boolean);
  const out = [];
  for (const line of lines) {
    // Keep long lines that look like pasted logs/code out of the clause pool.
    if (line.length > 600 || looksLikeCode(line)) continue;
    const parts = line.split(/(?<=[.!?;])\s+(?=[A-Za-z])|\s+(?:and also|and then|also,?)\s+/i);
    for (const p of parts) {
      const clause = p.trim().replace(/^[,;:\s]+|[,;:\s]+$/g, '');
      const words = clause.split(/\s+/).length;
      if (words >= 3 && words <= 40) out.push(clause);
    }
  }
  return out;
}

function looksLikeCode(line) {
  const symbols = (line.match(/[{}();=<>$\\[\]]/g) || []).length;
  return symbols / Math.max(line.length, 1) > 0.08 || /^\s*(?:at |Traceback|Error:|\$ |PS [A-Z]:\\)/.test(line);
}

const STOP = new Set(
  'a an the and or but if then so to of in on at by for with from as is are was were be been being it its this that these those i me my you your we our they them he she his her do does did done have has had can could would should will shall may might must not no yes ok okay please just also very really thing things there here what which who whom when where why how all any some more most such own same than too only into over under again further once about'.split(
    ' ',
  ),
);

/** Content words used for keyword matching and trigger evaluation. */
export function contentWords(s) {
  return normalize(s)
    .split(' ')
    .filter((w) => w.length > 2 && !STOP.has(w))
    .map(stem);
}

/** A deliberately light stemmer: enough to line up "tests/testing/tested". */
export function stem(w) {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('es')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

/** Character trigram set, robust to typos ("wnat" ~ "want"). */
export function trigrams(s) {
  const t = ` ${normalize(s)} `;
  const set = new Set();
  for (let i = 0; i < t.length - 2; i++) set.add(t.slice(i, i + 3));
  return set;
}

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export function truncate(s, n) {
  if (!s || s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + '…';
}

export function slugify(s, max = 48) {
  return (
    normalize(s)
      .split(' ')
      .filter((w) => w && !STOP.has(w))
      .slice(0, 6)
      .join('-')
      .slice(0, max)
      .replace(/-+$/, '') || 'habit'
  );
}

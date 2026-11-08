import { splitClauses, normalize, trigrams, jaccard, contentWords, truncate, slugify } from './text.js';
import { shortHash } from './analyze.js';

/**
 * Habit mining: find instructions a person gives Claude Code again and again.
 *
 * 1. Split every human prompt into clauses and score how much each reads like a standing
 *    instruction ("always...", "don't...", "make sure...", corrections like "you forgot...").
 * 2. Group near-identical clauses with MinHash LSH over character trigrams (typo tolerant),
 *    plus a small lexicon of common developer habits so different phrasings of the same
 *    habit ("run the tests first" / "make sure tests pass") land together.
 * 3. Rank groups by how often, how widely and how recently they recur, and decide what kind
 *    of durable instruction each should become: a CLAUDE.md rule, a Skill, a hook, a
 *    subagent or a slash command.
 */

const IMPERATIVE = /^(?:please\s+)?(?:i (?:want|need|would like|wnat)|i'd like|always|never|don'?t|do not|make sure|ensure|remember|use|run|avoid|prefer|keep|stop|check|test|add|remove|write|create|commit|push|ask|explain|follow|verify|update|fix|install|build|read|review|search|look|start|put|show|tell|give|be|try|stick|only|no longer|from now on|going forward|before|after|when|whenever|every time|each time)\b/i;
const STANDING = /\b(?:always|never|every time|each time|from now on|going forward|in future|by default|whenever|must|should always|should never|need to|have to|make sure|ensure|remember to|don'?t forget|do not|don'?t|instead of|rather than|prefer|stick to|no more)\b/i;
const CORRECTION = /^(?:no[,.!\s]|nope|wrong|that'?s (?:wrong|not)|not what i|you forgot|you didn'?t|you missed|you broke|why did you|i told you|i said|as i said|again[,!]|stop\b|still (?:not|broken|failing|wrong))|\b(?:i (?:already )?told you|i said|you forgot|you keep|keeps? (?:doing|adding|using)|again\b(?!st))/i;
const SPECIFIC = /(?:\b[\w-]+\.(?:js|ts|tsx|jsx|py|php|java|kt|go|rs|rb|css|scss|html|json|md|yml|yaml|sql|sh|ps1|txt|pdf|png|jpg|csv)\b|[A-Za-z]:\\|\/[\w.-]+\/[\w.-]+|\b\d{3,}\b|line \d+)/i;
const QUESTION = /\?\s*$/;

/** Common developer habits, so different wordings of one habit group together. */
const LEXICON = [
  ['run-tests', /\b(?:run|execute|rerun|re-run)\b.{0,25}\btests?\b|\btests? (?:pass|passing|green|first|before)|\bmake sure (?:all )?(?:the )?tests\b/i],
  ['lint', /\b(?:run|fix)\b.{0,15}\b(?:lint|linter|eslint|ruff|flake8)\b|\blint (?:errors|warnings|before)/i],
  ['typecheck', /\b(?:typecheck|type check|tsc|mypy|type errors)\b/i],
  ['format', /\b(?:prettier|black|format(?:ter)?)\b.{0,20}\b(?:run|before|after|always|code)\b|\brun (?:the )?format/i],
  ['no-any', /\b(?:no|don'?t use|avoid|never use)\b.{0,10}\b`?any`?\b.{0,10}\b(?:type|types)?\b/i],
  ['package-manager', /\b(?:use|uses|using|with)\s+(?:pnpm|yarn|bun|npm|uv|poetry)\b|\b(?:pnpm|yarn|bun|npm)\s*,?\s+(?:not|instead of|rather than)\s+(?:npm|yarn|pnpm|bun)\b/i],
  ['commit-messages', /\bcommit (?:message|msg)s?\b|\bconventional commits?\b/i],
  ['dont-commit', /\b(?:don'?t|do not|never)\b.{0,15}\b(?:commit|push)\b/i],
  ['ask-first', /\b(?:ask (?:me )?(?:before|first)|check with me|confirm with me|ask (?:me )?if you need)\b/i],
  ['plan-first', /\b(?:plan (?:it )?first|make a plan|planning mode|plan mode|think (?:it )?through first|before (?:you )?(?:start|code|write))\b/i],
  ['minimal-changes', /\b(?:don'?t|do not|never)\b.{0,20}\b(?:change|touch|modify|refactor)\b.{0,20}\b(?:unrelated|other|anything else|existing)\b|\bminimal (?:changes|diff)\b|\bonly change\b/i],
  ['no-comments', /\b(?:no|don'?t add|remove|fewer|less)\b.{0,10}\bcomments?\b/i],
  ['simple-language', /\b(?:simple|plain|easy|simpler|easier) (?:words|language|english|terms)\b|\bexplain (?:it |this |that )?(?:simply|like|in plain)\b|\b(?:keep|make) (?:the |your )?(?:explanation|answer|response)s? (?:simple|easy)\b|\bno (?:technical )?jargons?\b/i],
  ['concise', /\b(?:be (?:more )?concise|shorter (?:answers|responses)|keep it short|too long|less verbose)\b/i],
  ['no-emoji', /\b(?:no|don'?t use|without|remove)\b.{0,10}\bemojis?\b/i],
  ['verify-browser', /\b(?:check|test|verify|open|see)\b.{0,25}\b(?:in the browser|in chrome|screenshot|visually)\b/i],
  ['secrets', /\b(?:don'?t|never|do not)\b.{0,20}\b(?:hardcode|commit|log|expose|print)\b.{0,20}\b(?:secrets?|keys?|tokens?|passwords?|credentials)\b/i],
  ['docs', /\b(?:update|write|add)\b.{0,15}\b(?:the )?(?:readme|docs|documentation|changelog)\b/i],
  ['one-go', /\b(?:in one go|don'?t stop|without stopping|finish (?:it|everything)|complete (?:it|everything) in one)\b/i],
  ['ask-midway', /\b(?:ask (?:me )?(?:during|mid|in the middle)|ask (?:questions )?while)\b/i],
  ['professional', /\b(?:professional(?:ly)?|top 1 ?(?:%|percent)|production[- ]ready|enterprise[- ]grade|elite)\b/i],
  ['premium-ui', /\b(?:premium|modern|elegant|beautiful|stunning)\b.{0,25}\b(?:ui|design|look|interface)\b/i],
];

export function directiveScore(clause) {
  let score = 0;
  if (IMPERATIVE.test(clause)) score += 1;
  if (STANDING.test(clause)) score += 1.5;
  if (CORRECTION.test(clause)) score += 1.5;
  if (QUESTION.test(clause) && !STANDING.test(clause)) score -= 0.75;
  if (SPECIFIC.test(clause)) score -= 1;
  const words = clause.split(/\s+/).length;
  if (words > 28) score -= 0.5;
  return score;
}

export function lexiconKey(clause) {
  for (const [key, re] of LEXICON) if (re.test(clause)) return key;
  return null;
}

/** What each known habit should become. */
const HABIT_KIND = {
  'run-tests': ['workflow', 'hook', ['command', 'rule']],
  lint: ['workflow', 'hook', ['rule']],
  typecheck: ['workflow', 'hook', ['rule']],
  format: ['workflow', 'hook', ['rule']],
  'verify-browser': ['workflow', 'skill', ['rule', 'command']],
  docs: ['workflow', 'rule', ['command']],
  'no-any': ['preference', 'rule', []],
  'package-manager': ['preference', 'rule', ['hook']],
  'commit-messages': ['preference', 'rule', ['command']],
  'dont-commit': ['preference', 'rule', ['hook']],
  'minimal-changes': ['preference', 'rule', []],
  'no-comments': ['preference', 'rule', []],
  secrets: ['preference', 'rule', ['hook']],
  professional: ['preference', 'rule', ['skill']],
  'premium-ui': ['preference', 'rule', ['skill']],
  'ask-first': ['communication', 'rule', []],
  'plan-first': ['communication', 'rule', ['command']],
  'simple-language': ['communication', 'rule', []],
  concise: ['communication', 'rule', []],
  'no-emoji': ['communication', 'rule', []],
  'one-go': ['communication', 'rule', []],
  'ask-midway': ['communication', 'rule', []],
};

/**
 * A pasted document (spec, brief, template) rather than something typed in the moment.
 * Its sentences are not mined as habits; the whole paste is checked for reuse instead.
 */
export function isDocument(text) {
  const words = text.split(/\s+/).length;
  if (words < 60) return false;
  // Typed prompts rarely carry markdown structure; pasted specs and templates almost always do.
  const headings = (text.match(/^\s*#{1,6}\s+\S/gm) || []).length;
  const bold = (text.match(/\*\*[^*\n]{2,}\*\*/g) || []).length;
  const tables = (text.match(/^\s*\|.*\|\s*$/gm) || []).length;
  const fences = (text.match(/^\s*```/gm) || []).length;
  const checkboxes = (text.match(/^\s*[-*]\s+\[[ xX]\]/gm) || []).length;
  return headings * 2 + bold + tables + fences * 2 + checkboxes >= 4;
}

// ---------- MinHash LSH ----------
const HASHES = 48;
const BANDS = 16;
const ROWS = HASHES / BANDS;
const SEEDS = Array.from({ length: HASHES }, (_, i) => (Math.imul(i + 1, 0x9e3779b1) ^ 0x5bd1e995) >>> 0);

function fnv(str, seed) {
  let h = (2166136261 ^ seed) >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function minhash(set) {
  const sig = new Uint32Array(HASHES).fill(0xffffffff);
  for (const g of set) {
    for (let i = 0; i < HASHES; i++) {
      const h = fnv(g, SEEDS[i]);
      if (h < sig[i]) sig[i] = h;
    }
  }
  return sig;
}

class UnionFind {
  constructor(n) {
    this.p = Int32Array.from({ length: n }, (_, i) => i);
  }
  find(x) {
    while (this.p[x] !== x) {
      this.p[x] = this.p[this.p[x]];
      x = this.p[x];
    }
    return x;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.p[rb] = ra;
  }
}

const SIMILAR = 0.42;

/**
 * @param {Array<{id,sessionId,projectId,projectLabel,ts,text}>} prompts
 * @param {object} [opts]
 * @returns {Array<Pattern>}
 */
export function minePatterns(prompts, opts = {}) {
  const minCount = opts.minCount ?? 2;
  const now = opts.now ?? Date.now();

  // 1. Candidate clauses (typed prompts only; pasted documents are handled by mineBriefs)
  const items = [];
  for (const p of prompts) {
    if (isDocument(p.text)) continue;
    const clauses = splitClauses(p.text)
      .map((c) => c.replace(/\*\*|__|^#+\s*|^>\s*/g, '').trim())
      .filter((c) => c.split(/\s+/).length >= 3);
    // Short prompts are clauses in their own right.
    if (!clauses.length && p.text.split(/\s+/).length <= 40 && p.text.split(/\s+/).length >= 3) clauses.push(p.text.trim());
    const seen = new Set();
    for (const c of clauses) {
      const norm = normalize(c);
      if (norm.length < 8 || seen.has(norm)) continue;
      seen.add(norm);
      const score = directiveScore(c);
      const lex = lexiconKey(c);
      if (score < 0.75 && !lex) continue;
      items.push({ text: c, norm, score, lex, grams: trigrams(c), prompt: p });
    }
  }
  if (!items.length) return opts.briefs !== false ? mineBriefs(prompts, now).sort((a, b) => b.score - a.score) : [];

  // 2. Cluster: LSH candidates verified with exact Jaccard, plus lexicon keys.
  const uf = new UnionFind(items.length);
  const buckets = new Map();
  items.forEach((it, idx) => {
    const sig = minhash(it.grams);
    for (let b = 0; b < BANDS; b++) {
      let key = `${b}:`;
      for (let r = 0; r < ROWS; r++) key += sig[b * ROWS + r].toString(36) + ',';
      const list = buckets.get(key);
      if (list) list.push(idx);
      else buckets.set(key, [idx]);
    }
  });
  const checked = new Set();
  for (const list of buckets.values()) {
    if (list.length < 2 || list.length > 400) continue;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        const key = a < b ? a * 1e6 + b : b * 1e6 + a;
        if (checked.has(key)) continue;
        checked.add(key);
        if (jaccard(items[a].grams, items[b].grams) >= SIMILAR) uf.union(a, b);
      }
    }
  }
  const byLex = new Map();
  items.forEach((it, idx) => {
    if (!it.lex) return;
    if (byLex.has(it.lex)) uf.union(byLex.get(it.lex), idx);
    else byLex.set(it.lex, idx);
  });

  const groups = new Map();
  items.forEach((it, idx) => {
    const r = uf.find(idx);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(it);
  });

  // 3. Describe and rank.
  const patterns = [];
  for (const members of groups.values()) {
    if (members.length < minCount) continue;
    const pattern = describe(members, now);
    if (pattern) patterns.push(pattern);
  }
  if (opts.briefs !== false) patterns.push(...mineBriefs(prompts, now));
  patterns.sort((a, b) => b.score - a.score);
  return patterns;
}

/**
 * Briefs: long prompts pasted again and again (a spec template, a review checklist,
 * a "how I want you to work" preamble). Each is a slash command waiting to be written.
 */
export function mineBriefs(prompts, now = Date.now()) {
  const docs = prompts
    .filter((p) => p.text.split(/\s+/).length >= 45)
    .map((p) => ({ prompt: p, grams: trigrams(p.text.slice(0, 1800)) }));
  if (docs.length < 2) return [];
  const uf = new UnionFind(docs.length);
  const buckets = new Map();
  docs.forEach((d, idx) => {
    const sig = minhash(d.grams);
    for (let b = 0; b < BANDS; b++) {
      let key = `${b}:`;
      for (let r = 0; r < ROWS; r++) key += sig[b * ROWS + r].toString(36) + ',';
      if (buckets.has(key)) buckets.get(key).push(idx);
      else buckets.set(key, [idx]);
    }
  });
  for (const list of buckets.values()) {
    if (list.length < 2 || list.length > 200) continue;
    for (let i = 1; i < list.length; i++) {
      if (uf.find(list[0]) === uf.find(list[i])) continue;
      if (jaccard(docs[list[0]].grams, docs[list[i]].grams) >= 0.55) uf.union(list[0], list[i]);
    }
  }
  const groups = new Map();
  docs.forEach((d, idx) => {
    const r = uf.find(idx);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(d);
  });
  const out = [];
  for (const members of groups.values()) {
    const sessions = new Set(members.map((m) => m.prompt.sessionId));
    if (members.length < 2 || sessions.size < 2) continue;
    const projects = new Map(members.map((m) => [m.prompt.projectId, m.prompt.projectLabel]));
    const longest = members.reduce((a, b) => (b.prompt.text.length > a.prompt.text.length ? b : a));
    const firstLine = longest.prompt.text
      .split('\n')
      .map((l) => l.replace(/^[#>*\-\s]+|\*\*/g, '').trim())
      .find((l) => l.split(/\s+/).length >= 3) || 'Reused brief';
    const stamps = members.map((m) => m.prompt.ts).filter(Boolean).sort();
    const lastTs = stamps[stamps.length - 1] || null;
    const ageDays = lastTs ? (now - Date.parse(lastTs)) / 864e5 : 365;
    const recency = Math.max(0.35, 1 - ageDays / 120);
    const words = longest.prompt.text.split(/\s+/).length;
    out.push({
      id: shortHash('brief:' + normalize(longest.prompt.text.slice(0, 400))),
      text: truncate(firstLine, 220),
      body: longest.prompt.text,
      variants: [],
      habit: null,
      count: members.length,
      sessions: sessions.size,
      projects: [...projects.entries()].map(([id, label]) => ({ id, label })),
      scope: projects.size > 1 ? 'global' : 'project',
      firstTs: stamps[0] || null,
      lastTs,
      corrections: 0,
      directive: 1,
      kind: 'brief',
      suggestion: 'command',
      alternatives: ['skill'],
      keywords: topKeywords([longest.prompt.text], 6),
      score: Math.round((members.length + 2 * (sessions.size - 1)) * (1 + Math.min(words, 900) / 900) * recency * 100) / 100,
      title: truncate(`Reused brief: ${firstLine}`, 80),
      slug: slugify(firstLine),
      words,
      occurrences: members
        .map((m) => ({ sessionId: m.prompt.sessionId, projectLabel: m.prompt.projectLabel, ts: m.prompt.ts, text: truncate(m.prompt.text.replace(/\s+/g, ' '), 300) }))
        .sort((a, b) => (b.ts || '').localeCompare(a.ts || '')),
    });
  }
  return out;
}

function describe(members, now) {
  const sessions = new Set(members.map((m) => m.prompt.sessionId));
  const projects = new Map();
  for (const m of members) projects.set(m.prompt.projectId, m.prompt.projectLabel);
  const avgDirective = members.reduce((a, m) => a + m.score, 0) / members.length;
  const lex = mostCommon(members.map((m) => m.lex).filter(Boolean));

  // A pattern seen only inside one session is a correction loop, not yet a habit;
  // keep it only if it repeated several times there.
  const correctionCount = members.filter((m) => CORRECTION.test(m.text)).length;
  if (sessions.size < 2 && correctionCount < 2) return null;
  if (avgDirective < 0.5 && !lex) return null;
  if (!lex && repeatedOnlyByPasting(members)) return null;

  const rep = representative(members);
  const stamps = members.map((m) => m.prompt.ts).filter(Boolean).sort();
  const firstTs = stamps[0] || null;
  const lastTs = stamps[stamps.length - 1] || null;
  const ageDays = lastTs ? (now - Date.parse(lastTs)) / 864e5 : 365;
  const recency = Math.max(0.35, 1 - ageDays / 120);
  const corrections = members.filter((m) => CORRECTION.test(m.text)).length;

  const allText = members.map((m) => m.text).join(' \n ');
  const kind = lex && HABIT_KIND[lex]
    ? { kind: HABIT_KIND[lex][0], suggestion: HABIT_KIND[lex][1], alternatives: HABIT_KIND[lex][2] }
    : classify(allText, members, corrections);
  const variants = uniqueBy(members.map((m) => m.text.replace(/\s+/g, ' ').trim()), (t) => normalize(t)).slice(0, 8);

  const score =
    (members.length + 2 * (sessions.size - 1) + 3 * (projects.size - 1)) *
    (0.6 + Math.min(avgDirective, 3) / 3) *
    recency *
    (corrections ? 1.15 : 1);

  const keywords = topKeywords(members.map((m) => m.text), 6);
  const id = shortHash(lex || normalize(rep.text));
  return {
    id,
    text: truncate(rep.text.replace(/\s+/g, ' ').trim(), 220),
    variants,
    habit: lex,
    count: members.length,
    sessions: sessions.size,
    projects: [...projects.entries()].map(([pid, label]) => ({ id: pid, label })),
    scope: projects.size > 1 ? 'global' : 'project',
    firstTs,
    lastTs,
    corrections,
    directive: Math.round(avgDirective * 100) / 100,
    kind: kind.kind,
    suggestion: kind.suggestion,
    alternatives: kind.alternatives,
    keywords,
    score: Math.round(score * 100) / 100,
    title: titleFor(rep.text, lex),
    slug: slugify(lex ? lex.replace(/-/g, ' ') : rep.text),
    occurrences: members
      .map((m) => ({ sessionId: m.prompt.sessionId, projectLabel: m.prompt.projectLabel, ts: m.prompt.ts, text: truncate(m.text, 300) }))
      .sort((a, b) => (b.ts || '').localeCompare(a.ts || ''))
      .slice(0, 60),
  };
}

const KIND_RULES = [
  {
    kind: 'workflow',
    re: /\b(?:tests?|lint|eslint|typecheck|tsc|format|prettier|build|compile|commit|push|deploy|migrat)/i,
    suggestion: 'hook',
    alternatives: ['command', 'rule'],
  },
  {
    kind: 'delegation',
    re: /\b(?:review|audit|investigate|research|explore|search (?:the )?(?:codebase|repo|project)|find (?:all|every)|analy[sz]e|look through|scan)\b/i,
    suggestion: 'subagent',
    alternatives: ['skill', 'rule'],
  },
  {
    kind: 'communication',
    re: /\b(?:explain|simple|plain|concise|short|verbose|ask me|tell me|summar|language|english|emoji|tone|questions?)\b/i,
    suggestion: 'rule',
    alternatives: ['command'],
  },
];

function classify(allText, members, corrections) {
  const avgWords = members.reduce((a, m) => a + m.text.split(/\s+/).length, 0) / members.length;
  const steps = /\b(?:first|then|after that|next|finally|step \d|\d[.:)] )/i.test(allText);
  if (avgWords >= 18 && steps) return { kind: 'procedure', suggestion: 'skill', alternatives: ['command', 'rule'] };
  for (const r of KIND_RULES) if (r.re.test(allText)) return { kind: r.kind, suggestion: r.suggestion, alternatives: r.alternatives };
  if (corrections >= Math.max(1, members.length / 3)) return { kind: 'correction', suggestion: 'rule', alternatives: ['hook'] };
  return { kind: 'preference', suggestion: 'rule', alternatives: ['skill'] };
}

/** True when every repeat comes from the same prompt pasted again (that's a brief, not a habit). */
function repeatedOnlyByPasting(members) {
  const texts = [...new Set(members.map((m) => m.prompt.text))];
  // Short prompts are typed, not pasted; only long near-identical prompts count as a paste.
  const avgWords = texts.reduce((a, t) => a + t.split(/\s+/).length, 0) / texts.length;
  if (avgWords < 40) return false;
  if (texts.length < 2) return true;
  const grams = texts.slice(0, 6).map((t) => trigrams(t.slice(0, 1500)));
  for (let i = 1; i < grams.length; i++) if (jaccard(grams[0], grams[i]) < 0.6) return false;
  return true;
}

/** The member that best stands for the group: similar to the rest, directive, not too long. */
function representative(members) {
  if (members.length === 1) return members[0];
  const sample = members.length > 60 ? members.filter((_, i) => i % Math.ceil(members.length / 60) === 0) : members;
  let best = members[0];
  let bestScore = -Infinity;
  for (const m of sample) {
    let sim = 0;
    for (const o of sample) if (o !== m) sim += jaccard(m.grams, o.grams);
    sim /= sample.length - 1 || 1;
    const words = m.text.split(/\s+/).length;
    const lengthPenalty = words > 20 ? (words - 20) * 0.02 : words < 4 ? 0.3 : 0;
    const s = sim + m.score * 0.12 - lengthPenalty;
    if (s > bestScore) {
      bestScore = s;
      best = m;
    }
  }
  return best;
}

const HABIT_TITLES = {
  'run-tests': 'Run the tests before calling it done',
  lint: 'Keep the linter clean',
  typecheck: 'Keep the type checker passing',
  format: 'Format code before finishing',
  'no-any': 'No `any` types',
  'package-manager': 'Use the project’s package manager',
  'commit-messages': 'Write commit messages a certain way',
  'dont-commit': 'Don’t commit or push without asking',
  'ask-first': 'Ask before acting',
  'plan-first': 'Plan before writing code',
  'minimal-changes': 'Keep changes minimal and on-task',
  'no-comments': 'Go easy on code comments',
  'simple-language': 'Explain things in simple language',
  concise: 'Keep answers short',
  'no-emoji': 'No emoji',
  'verify-browser': 'Check UI changes in the browser',
  secrets: 'Keep secrets out of code and logs',
  docs: 'Keep the docs up to date',
  'one-go': 'Finish the whole task in one go',
  'ask-midway': 'Ask questions while working, not at the end',
  professional: 'Hold the work to a professional bar',
  'premium-ui': 'Aim for a premium, polished UI',
};

function titleFor(text, lex) {
  if (lex && HABIT_TITLES[lex]) return HABIT_TITLES[lex];
  const t = text.replace(/\s+/g, ' ').replace(/^(?:please|pls|plz|okay|ok|so|and|also|now)[,\s]+/i, '').trim();
  return truncate(t.charAt(0).toUpperCase() + t.slice(1), 80);
}

function topKeywords(texts, n) {
  const counts = new Map();
  for (const t of texts) for (const w of new Set(contentWords(t))) counts.set(w, (counts.get(w) || 0) + 1);
  return [...counts.entries()]
    .filter(([, c]) => c >= Math.min(2, texts.length))
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([w]) => w);
}

function mostCommon(arr) {
  if (!arr.length) return null;
  const c = new Map();
  for (const x of arr) c.set(x, (c.get(x) || 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function uniqueBy(arr, key) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = key(x);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

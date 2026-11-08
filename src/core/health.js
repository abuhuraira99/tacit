import fs from 'node:fs';
import path from 'node:path';
import { claudeHome } from './paths.js';
import { trigrams, jaccard, contentWords, truncate } from './text.js';
import { ruleText } from './forge.js';

const FILES = ['CLAUDE.md', path.join('.claude', 'CLAUDE.md'), 'CLAUDE.local.md'];
const HEDGES = /\b(?:try to|if possible|maybe|perhaps|ideally|where appropriate|as needed|when it makes sense|etc\.?)\b/i;
const NEGATIVE = /\b(?:never|don'?t|do not|avoid|no longer|stop)\b/i;
const POSITIVE = /\b(?:always|use|prefer|must|make sure|ensure)\b/i;

/**
 * Read a memory file into rules (list items and imperative lines), with line numbers.
 */
export function readMemoryFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const st = fs.statSync(file);
  const lines = text.split(/\r?\n/);
  const rules = [];
  let inFence = false;
  lines.forEach((raw, i) => {
    if (/^\s*```/.test(raw)) inFence = !inFence;
    if (inFence) return;
    const m = /^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/.exec(raw);
    const text = m ? m[1] : /^(?:Always|Never|Do not|Don't|Use|Prefer|Run|Avoid|Keep)\b.*\S/.test(raw.trim()) ? raw.trim() : null;
    if (!text) return;
    const clean = text.replace(/\*\*|`/g, '').trim();
    if (clean.split(/\s+/).length < 2) return;
    rules.push({ line: i + 1, text: clean, grams: trigrams(clean), words: new Set(contentWords(clean)) });
  });
  return {
    file,
    bytes: Buffer.byteLength(text),
    tokens: Math.round(text.length / 4),
    lines: lines.length,
    mtime: new Date(st.mtimeMs).toISOString(),
    imports: (text.match(/^\s*@[\w./\\~-]+/gm) || []).length,
    rules,
  };
}

const DIRECTIVE = /\b(?:always|never|must|should|don'?t|do not|avoid|use|prefer|run|keep|make sure|ensure|before|only|no)\b/i;

/** How strongly a rule says the same thing as a pattern (0 = unrelated, ~1 = same words). */
export function coverScore(rule, pattern) {
  const candidates = [pattern.text, ...(pattern.variants || []), pattern.habit ? ruleText(pattern) : null].filter(Boolean);
  let best = 0;
  for (const c of candidates) {
    best = Math.max(best, jaccard(rule.grams, trigrams(c)));
    const words = new Set(contentWords(c));
    if (!words.size || !rule.words.size) continue;
    let shared = 0;
    for (const w of words) if (rule.words.has(w)) shared++;
    if (shared >= 2) best = Math.max(best, (shared / Math.min(words.size, rule.words.size)) * 0.8);
  }
  // Descriptions ("`pnpm test` runs Vitest") are not instructions.
  if (!DIRECTIVE.test(rule.text)) best *= 0.6;
  return best;
}

export const COVER_THRESHOLD = 0.38;

export function covers(rule, pattern) {
  return coverScore(rule, pattern) >= COVER_THRESHOLD;
}

/** The rule that best covers a pattern, or null. */
export function bestCover(rules, pattern) {
  let best = null;
  let bestScore = COVER_THRESHOLD;
  for (const r of rules) {
    const s = coverScore(r, pattern);
    if (s >= bestScore) {
      best = r;
      bestScore = s;
    }
  }
  return best;
}

/**
 * Health report for global memory plus every project that still exists on disk.
 * @param {object} index  buildIndex() result
 * @param {Array} patterns minePatterns() result
 */
export function memoryHealth(index, patterns) {
  const globalFile = readMemoryFile(path.join(claudeHome(), 'CLAUDE.md'));
  const globalPatterns = patterns.filter((p) => p.scope === 'global' && p.kind !== 'brief');
  const reports = [];

  reports.push(
    buildReport({
      id: 'global',
      label: 'Personal (all projects)',
      cwd: claudeHome(),
      files: globalFile ? [globalFile] : [],
      patterns: globalPatterns,
      expectedPath: path.join(claudeHome(), 'CLAUDE.md'),
    }),
  );

  for (const proj of index.projects) {
    if (!proj.cwd || !isDir(proj.cwd)) continue;
    const files = FILES.map((f) => readMemoryFile(path.join(proj.cwd, f))).filter(Boolean);
    const projPatterns = patterns.filter((p) => p.kind !== 'brief' && p.projects.some((x) => x.id === proj.id));
    if (!files.length && !projPatterns.length) continue;
    reports.push(
      buildReport({
        id: proj.id,
        label: proj.label,
        cwd: proj.cwd,
        files,
        patterns: projPatterns,
        globalRules: globalFile ? globalFile.rules : [],
        expectedPath: path.join(proj.cwd, 'CLAUDE.md'),
        sessions: proj.sessions,
      }),
    );
  }
  reports.sort((a, b) => (a.id === 'global' ? -1 : b.id === 'global' ? 1 : a.score - b.score));
  return reports;
}

function buildReport({ id, label, cwd, files, patterns, globalRules = [], expectedPath, sessions = 0 }) {
  const issues = [];
  const rules = files.flatMap((f) => f.rules.map((r) => ({ ...r, file: f.file, mtime: f.mtime })));
  const allRules = [...rules, ...globalRules.map((r) => ({ ...r, file: 'global' }))];

  if (!files.length) {
    issues.push({
      type: 'missing',
      severity: patterns.length ? 'high' : 'low',
      title: 'No CLAUDE.md yet',
      detail: patterns.length
        ? `You repeat ${patterns.length} instruction${patterns.length > 1 ? 's' : ''} here that a CLAUDE.md would remember for you.`
        : 'A short CLAUDE.md with build, test and style notes saves Claude from rediscovering them every session.',
      path: expectedPath,
    });
  }

  for (const f of files) {
    if (f.tokens > 5000) {
      issues.push({
        type: 'bloat',
        severity: f.tokens > 10000 ? 'high' : 'medium',
        title: `${path.basename(f.file)} is long (about ${Math.round(f.tokens / 100) / 10}k tokens)`,
        detail: 'It loads into every session. Move rarely needed detail into skills or imported files so the rules that matter stay prominent.',
        path: f.file,
      });
    }
  }

  // Rules that are not working: you still say it after the rule was written.
  for (const p of patterns) {
    const rule = bestCover(allRules, p);
    if (rule) {
      const after = rule.mtime ? p.occurrences.filter((o) => o.ts && o.ts > rule.mtime).length : 0;
      if (after >= 2) {
        issues.push({
          type: 'ignored',
          severity: 'high',
          title: 'Rule exists, but you still repeat it',
          detail: `“${truncate(rule.text, 110)}” is in ${rule.file === 'global' ? 'your personal CLAUDE.md' : path.basename(rule.file)}, yet you said it ${after} more time${after > 1 ? 's' : ''} since. Make it more specific, move it higher, or enforce it with a hook.`,
          path: rule.file === 'global' ? null : rule.file,
          line: rule.line,
          patternId: p.id,
        });
      }
    } else if (p.count >= 3 || p.sessions >= 2) {
      issues.push({
        type: 'uncovered',
        severity: p.count >= 6 ? 'high' : 'medium',
        title: `No rule for “${truncate(p.title, 60)}”`,
        detail: `You have said this ${p.count} times in ${p.sessions} sessions. One line in CLAUDE.md would cover it.`,
        patternId: p.id,
      });
    }
  }

  // Duplicates and contradictions within the same scope.
  for (let i = 0; i < rules.length; i++) {
    for (let j = i + 1; j < rules.length; j++) {
      const a = rules[i];
      const b = rules[j];
      const sim = jaccard(a.grams, b.grams);
      if (sim >= 0.7) {
        issues.push({
          type: 'duplicate',
          severity: 'low',
          title: 'Two rules say the same thing',
          detail: `Line ${a.line} and line ${b.line}${a.file !== b.file ? ` (${path.basename(b.file)})` : ''}: “${truncate(a.text, 80)}”. Keep one.`,
          path: a.file,
          line: a.line,
        });
      } else if (sharedWords(a.words, b.words) >= 2 && NEGATIVE.test(a.text) !== NEGATIVE.test(b.text) && (POSITIVE.test(a.text) || POSITIVE.test(b.text)) && sim >= 0.35) {
        issues.push({
          type: 'conflict',
          severity: 'medium',
          title: 'These rules may contradict each other',
          detail: `Line ${a.line}: “${truncate(a.text, 70)}” and line ${b.line}: “${truncate(b.text, 70)}”.`,
          path: a.file,
          line: a.line,
        });
      }
    }
  }

  const vague = rules.filter((r) => HEDGES.test(r.text)).slice(0, 4);
  for (const r of vague) {
    issues.push({
      type: 'vague',
      severity: 'low',
      title: 'Soft wording',
      detail: `“${truncate(r.text, 100)}” (line ${r.line}). Hedges like “try to” or “if possible” make a rule easy to skip. State exactly what to do.`,
      path: r.file,
      line: r.line,
    });
  }

  const weights = { high: 14, medium: 7, low: 3 };
  // Each kind of problem can only cost so much, so one long list doesn't zero the score.
  const caps = { missing: 30, bloat: 20, ignored: 40, uncovered: 35, duplicate: 10, conflict: 15, vague: 10 };
  const byType = {};
  for (const x of issues) byType[x.type] = (byType[x.type] || 0) + (weights[x.severity] || 0);
  const penalty = Object.entries(byType).reduce((a, [type, p]) => a + Math.min(p, caps[type] ?? 20), 0);
  const score = Math.max(0, Math.min(100, 100 - penalty));
  return {
    id,
    label,
    cwd,
    sessions,
    score,
    grade: score >= 85 ? 'Healthy' : score >= 60 ? 'Needs attention' : 'Out of date',
    files: files.map((f) => ({ file: f.file, tokens: f.tokens, lines: f.lines, rules: f.rules.length, mtime: f.mtime, imports: f.imports })),
    ruleCount: rules.length,
    issues: issues.sort((a, b) => weights[b.severity] - weights[a.severity]),
  };
}

function sharedWords(a, b) {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n;
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

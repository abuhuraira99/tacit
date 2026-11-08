import fs from 'node:fs';
import path from 'node:path';
import { claudeHome } from './paths.js';
import { contentWords, normalize, truncate } from './text.js';

/**
 * Forge: turn a recurring pattern into a durable Claude Code artifact.
 *
 *   rule      -> a bullet in CLAUDE.md (project or ~/.claude for global habits)
 *   skill     -> .claude/skills/<name>/SKILL.md
 *   hook      -> a hook entry merged into .claude/settings.json
 *   subagent  -> .claude/agents/<name>.md
 *   command   -> .claude/commands/<name>.md (a slash command)
 *
 * Drafts are deterministic templates; "Refine with Claude" (ai.js) can rewrite them.
 */

export const KINDS = ['rule', 'skill', 'hook', 'subagent', 'command'];

export function forge(pattern, kind, opts = {}) {
  if (!KINDS.includes(kind)) throw new Error(`Unknown artifact kind: ${kind}`);
  const root = targetRoot(pattern, opts);
  switch (kind) {
    case 'rule':
      return ruleArtifact(pattern, root);
    case 'skill':
      return skillArtifact(pattern, root);
    case 'hook':
      return hookArtifact(pattern, root);
    case 'subagent':
      return subagentArtifact(pattern, root);
    case 'command':
      return commandArtifact(pattern, root);
    default:
      throw new Error('unreachable');
  }
}

/** Where an artifact for this pattern should live. */
export function targetRoot(pattern, opts = {}) {
  const scope = opts.scope || pattern.scope || 'project';
  if (scope === 'global' || !opts.projectPath) {
    return { scope: 'global', dir: claudeHome(), claudeMd: path.join(claudeHome(), 'CLAUDE.md'), dotClaude: claudeHome() };
  }
  return {
    scope: 'project',
    dir: opts.projectPath,
    claudeMd: path.join(opts.projectPath, 'CLAUDE.md'),
    dotClaude: path.join(opts.projectPath, '.claude'),
  };
}

// ---------- rules ----------

const RULE_REWRITES = {
  'run-tests': 'Run the test suite before saying a task is done, and report the result.',
  lint: 'Run the linter on the files you changed and fix what it reports before finishing.',
  typecheck: 'Keep the type checker passing; run it before finishing and fix new errors.',
  format: 'Format changed files with the project formatter before finishing.',
  'no-any': 'Do not use the `any` type. Prefer precise types, `unknown`, or generics.',
  'package-manager': 'Use the package manager this project already uses (check the lockfile); never mix managers.',
  'commit-messages': 'Write commit messages in the project’s established style: a short imperative subject, then a body explaining why.',
  'dont-commit': 'Never commit, push or open pull requests unless I ask for it in this conversation.',
  'ask-first': 'Ask before destructive or hard-to-reverse actions (deleting files, migrations, force pushes, publishing).',
  'plan-first': 'For non-trivial changes, outline the plan and wait for my go-ahead before editing files.',
  'minimal-changes': 'Change only what the task needs. Leave unrelated code, formatting and files alone.',
  'no-comments': 'Keep comments rare: explain why, not what. Do not add comments that restate the code.',
  'simple-language': 'Explain things in plain, simple English. Avoid jargon; when a technical term is needed, define it in one line.',
  concise: 'Keep answers short. Lead with the result, then only the detail I need to act on it.',
  'no-emoji': 'Do not use emoji in code, comments, commit messages or answers.',
  'verify-browser': 'After UI changes, open the page in the browser, check it visually, and describe what you actually see.',
  secrets: 'Never hardcode, log, print or commit secrets, API keys, tokens or passwords. Read them from the environment.',
  docs: 'When behaviour or setup changes, update the README and relevant docs in the same change.',
  'one-go': 'Work through the whole task in one go. If you need a decision from me, ask mid-task and keep working on the parts that do not depend on it.',
  'ask-midway': 'Ask clarifying questions while you work instead of stopping at the end to ask.',
  professional: 'Hold every deliverable to a professional, production-ready standard: clean structure, no leftovers, nothing unfinished.',
  'premium-ui': 'For UI work, aim for a polished, premium result: consistent spacing, deliberate typography, and no generic template look.',
};

export function ruleText(pattern) {
  if (pattern.habit && RULE_REWRITES[pattern.habit]) return RULE_REWRITES[pattern.habit];
  return toImperative(pattern.text);
}

/** Make a spoken instruction read like a written rule. */
export function toImperative(text) {
  let t = String(text).replace(/\s+/g, ' ').trim();
  t = t.replace(/^(?:(?:ok(?:ay)?|so|and|also|now|but|please|pls|plz|hey|claude|well|right)[,\s]+)+/i, '');
  t = t.replace(/^(?:i (?:want|need|would like) you to|i want|you should|you must|you need to|can you|could you|would you|make sure (?:that )?you|make sure (?:that )?|remember to|don'?t forget to)\s+/i, (m) =>
    /make sure|remember|forget/i.test(m) ? 'Always ' : '',
  );
  t = t.replace(/\byou\b/gi, (m, i) => (i === 0 ? 'You' : 'you'));
  t = t.replace(/[\s,;:.!?]+$/, '');
  if (!t) return 'Follow this standing instruction.';
  t = t.charAt(0).toUpperCase() + t.slice(1);
  return truncate(t, 240) + '.';
}

function ruleArtifact(pattern, root) {
  const rule = ruleText(pattern);
  const content = `- ${rule}`;
  return {
    kind: 'rule',
    scope: root.scope,
    path: root.claudeMd,
    mode: 'append-rule',
    section: 'Working agreements',
    content,
    preview: `## Working agreements\n\n${content}\n`,
    language: 'markdown',
    note:
      root.scope === 'global'
        ? 'Goes in your personal ~/.claude/CLAUDE.md, so it applies in every project.'
        : 'Goes in this project’s CLAUDE.md, so everyone working here gets it.',
  };
}

// ---------- skills ----------

function skillArtifact(pattern, root) {
  const name = (pattern.slug || 'habit').slice(0, 64);
  const triggers = triggerPhrases(pattern);
  const description = skillDescription(pattern);
  const steps = stepsFrom(pattern);
  const body = [
    '---',
    `name: ${name}`,
    `description: ${yamlString(description)}`,
    '---',
    '',
    `# ${pattern.title.replace(/^Reused brief:\s*/, '')}`,
    '',
    '## When to use',
    '',
    ...triggers.map((t) => `- ${t}`),
    '',
    '## Steps',
    '',
    ...steps.map((s, i) => `${i + 1}. ${s}`),
    '',
    '## Done means',
    '',
    '- Every step above is complete, or you said which one you could not finish and why.',
    '- You reported what you checked and what you found, in plain language.',
    '',
    `<!-- Drafted by Tacit from ${pattern.count} requests across ${pattern.sessions} sessions. Edit freely. -->`,
    '',
  ].join('\n');
  return {
    kind: 'skill',
    scope: root.scope,
    path: path.join(root.dotClaude, 'skills', name, 'SKILL.md'),
    mode: 'create',
    content: body,
    preview: body,
    language: 'markdown',
    description,
    name,
    note: 'Claude loads a skill only when its description matches the task, so the description is what decides whether it triggers.',
  };
}

/**
 * The description decides whether Claude loads a skill, so it is written in the words the
 * person actually uses: the habit in one sentence, then their own phrasings as triggers.
 */
export function skillDescription(pattern) {
  const what = pattern.habit ? ruleText(pattern).replace(/\.$/, '') : `Handle requests like "${truncate(pattern.text, 90)}"`;
  const seen = new Set();
  const phrases = [];
  for (const v of pattern.variants && pattern.variants.length ? pattern.variants : [pattern.text]) {
    const clean = v.replace(/\s+/g, ' ').replace(/[.!]+$/, '').trim();
    const key = normalize(clean);
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    phrases.push(`"${truncate(clean, 80)}"`);
    if (phrases.length === 5) break;
  }
  const kw = pattern.keywords.slice(0, 6).join(', ');
  return truncate(`${what}. Use when the user says things like ${phrases.join(', ')}${kw ? `, or mentions ${kw}` : ''}.`, 1000);
}

function triggerPhrases(pattern) {
  const vs = (pattern.variants && pattern.variants.length ? pattern.variants : [pattern.text]).slice(0, 4);
  return vs.map((v) => `The request sounds like: "${truncate(v.replace(/\s+/g, ' '), 110)}"`);
}

function stepsFrom(pattern) {
  if (pattern.body) {
    const lines = pattern.body
      .split('\n')
      .map((l) => l.replace(/^\s*(?:\d+\s*[.:)]|[-*•])\s*/, '').replace(/\*\*/g, '').trim())
      .filter((l) => l.split(/\s+/).length >= 4 && !/^#/.test(l));
    if (lines.length) return lines.slice(0, 10).map((l) => truncate(l, 200));
  }
  if (pattern.habit === 'verify-browser') {
    return [
      'Start or reuse the dev server and open the changed page in the browser.',
      'Take a screenshot at desktop and mobile widths.',
      'Check the console for errors and the network tab for failed requests.',
      'Describe what you actually see, and fix anything that does not match the request before saying it is done.',
    ];
  }
  if (pattern.habit === 'run-tests') {
    return ['Find the test command (package.json, Makefile, pyproject, README).', 'Run the full suite.', 'Fix failures caused by your change.', 'Report the final result with the command you ran.'];
  }
  return [ruleText(pattern), 'Check the result against the original request before reporting back.', 'Say plainly what you did and anything you could not do.'];
}

// ---------- hooks ----------

/**
 * Hooks run deterministic commands at points in Claude Code's loop. A Stop hook that exits
 * with code 2 blocks Claude from finishing and feeds stderr back, so "run the tests before
 * you say you're done" becomes something Claude cannot forget.
 */
function hookArtifact(pattern, root) {
  const projectDir = root.scope === 'project' ? root.dir : null;
  const cmd = detectCommand(pattern, projectDir);
  const event = cmd.event;
  const matcher = cmd.matcherOverride || (event === 'PostToolUse' ? 'Edit|Write|MultiEdit' : null);
  const entry = matcher ? { matcher, hooks: [{ type: 'command', command: cmd.command }] } : { hooks: [{ type: 'command', command: cmd.command }] };
  const snippet = { hooks: { [event]: [entry] } };
  const content = JSON.stringify(snippet, null, 2);
  return {
    kind: 'hook',
    scope: root.scope,
    path: path.join(root.dotClaude, 'settings.json'),
    mode: 'merge-json',
    content,
    preview: content,
    language: 'json',
    event,
    command: cmd.command,
    note: cmd.note,
  };
}

export function detectCommand(pattern, projectDir) {
  const habit = pattern.habit;
  const scripts = readPackageScripts(projectDir);
  const pm = detectPackageManager(projectDir);
  const run = (name) => (pm === 'npm' ? `npm run ${name} --silent` : `${pm} run ${name}`);
  const block = (cmdline, message) => `${cmdline} >/dev/null 2>&1 || { echo "${message}" >&2; exit 2; }`;

  if (habit === 'lint' || /\blint/i.test(pattern.text)) {
    const c = scripts.lint ? run('lint') : 'npx --no-install eslint .';
    return { event: 'Stop', command: block(c, 'Lint errors remain. Fix them before finishing.'), note: 'Runs your linter when Claude tries to finish; if it fails, Claude is told to keep going.' };
  }
  if (habit === 'typecheck' || /\b(?:typecheck|tsc|type check)/i.test(pattern.text)) {
    const c = scripts.typecheck ? run('typecheck') : 'npx --no-install tsc --noEmit';
    return { event: 'Stop', command: block(c, 'Type errors remain. Fix them before finishing.'), note: 'Blocks finishing while the type checker reports errors.' };
  }
  if (habit === 'format' || /\b(?:format|prettier)/i.test(pattern.text)) {
    const c = scripts.format ? run('format') : 'npx --no-install prettier --write .';
    return { event: 'PostToolUse', command: `${c} >/dev/null 2>&1 || true`, note: 'Formats the project after every edit, so formatting never needs a reminder.' };
  }
  if (habit === 'dont-commit' || /\b(?:commit|push)\b/i.test(pattern.text)) {
    return {
      event: 'PreToolUse',
      command: `node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const c=(JSON.parse(d).tool_input||{}).command||'';if(/\\bgit\\s+(commit|push)\\b/.test(c)){console.error('Ask before committing or pushing.');process.exit(2)}})"`,
      note: 'Stops any git commit or push until you ask for one. Remove it when you want Claude to commit freely.',
      matcherOverride: 'Bash',
    };
  }
  // Default: tests.
  let c = 'npm test --silent';
  if (scripts.test) c = pm === 'npm' ? 'npm test --silent' : `${pm} test`;
  else if (projectDir && exists(path.join(projectDir, 'pyproject.toml'))) c = 'python -m pytest -q';
  else if (projectDir && exists(path.join(projectDir, 'Cargo.toml'))) c = 'cargo test --quiet';
  else if (projectDir && exists(path.join(projectDir, 'go.mod'))) c = 'go test ./...';
  return { event: 'Stop', command: block(c, 'Tests are failing. Fix them before you finish.'), note: 'Runs the tests whenever Claude tries to finish. A failure sends Claude back to work instead of reporting done.' };
}

function readPackageScripts(dir) {
  if (!dir) return {};
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts || {};
  } catch {
    return {};
  }
}

function detectPackageManager(dir) {
  if (!dir) return 'npm';
  if (exists(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (exists(path.join(dir, 'yarn.lock'))) return 'yarn';
  if (exists(path.join(dir, 'bun.lockb')) || exists(path.join(dir, 'bun.lock'))) return 'bun';
  return 'npm';
}

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

// ---------- subagents ----------

function subagentArtifact(pattern, root) {
  const name = (pattern.slug || 'helper').slice(0, 48);
  const readOnly = /\b(?:review|audit|investigate|research|explore|find|analy|scan|check|look)/i.test(pattern.text + ' ' + pattern.keywords.join(' '));
  const tools = readOnly ? 'Read, Grep, Glob, Bash' : 'Read, Grep, Glob, Bash, Edit, Write';
  const description = truncate(
    `Use proactively when the user asks to ${pattern.text.replace(/^(?:please\s+)?/i, '').replace(/[.?!]+$/, '').toLowerCase()}. Works in its own context and returns a short report.`,
    600,
  );
  const body = [
    '---',
    `name: ${name}`,
    `description: ${yamlString(description)}`,
    `tools: ${tools}`,
    '---',
    '',
    `You handle one recurring job: ${pattern.title.replace(/^Reused brief:\s*/, '').toLowerCase()}.`,
    '',
    'How to work:',
    '1. Restate the goal in one sentence before you start.',
    '2. Gather only the context you need. Prefer search over reading whole folders.',
    readOnly ? '3. Do not edit files. Your job is to find and report.' : '3. Make the smallest change that does the job.',
    '4. If something blocks you, stop and report the obstacle instead of guessing.',
    '',
    'Reply in this format:',
    '- Summary: two or three sentences.',
    '- Findings: a short list, each with the file and line where relevant.',
    '- Obstacles: anything you could not check, or "none".',
    '',
    `<!-- Drafted by Tacit from ${pattern.count} requests across ${pattern.sessions} sessions. -->`,
    '',
  ].join('\n');
  return {
    kind: 'subagent',
    scope: root.scope,
    path: path.join(root.dotClaude, 'agents', `${name}.md`),
    mode: 'create',
    content: body,
    preview: body,
    language: 'markdown',
    description,
    name,
    note: readOnly
      ? 'Read-only tools: this agent investigates and reports, so it cannot change your code.'
      : 'Delegated work runs in a separate context window, keeping your main conversation clean.',
  };
}

// ---------- slash commands ----------

function commandArtifact(pattern, root) {
  const name = (pattern.slug || 'brief').slice(0, 40);
  const prompt = pattern.body
    ? pattern.body.trim()
    : [ruleText(pattern), '', 'Task: $ARGUMENTS'].join('\n');
  const content = [
    '---',
    `description: ${yamlString(truncate(pattern.title.replace(/^Reused brief:\s*/, ''), 120))}`,
    '---',
    '',
    prompt.includes('$ARGUMENTS') ? prompt : `${prompt}\n\nExtra context for this run: $ARGUMENTS`,
    '',
  ].join('\n');
  return {
    kind: 'command',
    scope: root.scope,
    path: path.join(root.dotClaude, 'commands', `${name}.md`),
    mode: 'create',
    content,
    preview: content,
    language: 'markdown',
    name,
    note: `Type /${name} in Claude Code instead of pasting this again.`,
  };
}

function yamlString(s) {
  const clean = String(s).replace(/\s+/g, ' ').trim();
  if (/^[\w(][^:#\n'"]*$/.test(clean) && !/^(?:true|false|null|yes|no)$/i.test(clean)) return clean;
  // YAML single-quoted scalar: nothing is escaped except the single quote itself ('').
  return `'${clean.replace(/'/g, "''")}'`;
}

// ---------- trigger evaluation ----------

/**
 * Would this skill/subagent description have been picked for the right requests?
 * Scores every past prompt against the description's key terms, then reports how many
 * of the pattern's own requests it catches (recall) and how many unrelated requests it
 * would also grab (false positives). A cheap, offline stand-in for an LLM trigger eval.
 */
export function evaluateTrigger(description, pattern, prompts) {
  const terms = new Map();
  for (const w of contentWords(description)) terms.set(w, (terms.get(w) || 0) + 1);
  const df = new Map();
  const docs = prompts.map((p) => {
    const words = new Set(contentWords(p.text.slice(0, 2000)));
    for (const w of words) if (terms.has(w)) df.set(w, (df.get(w) || 0) + 1);
    return { p, words };
  });
  const N = docs.length || 1;
  const idf = (w) => Math.log(1 + N / (1 + (df.get(w) || 0)));
  const maxScore = [...terms.keys()].reduce((a, w) => a + idf(w), 0) || 1;
  const positive = new Set(pattern.occurrences.map((o) => o.sessionId + '|' + normalize(o.text).slice(0, 60)));
  const memberPrompt = (p) => {
    const n = normalize(p.text);
    return pattern.occurrences.some((o) => o.sessionId === p.sessionId && n.includes(normalize(o.text).replace(/…$/, '').slice(0, 40)));
  };
  const scored = docs.map(({ p, words }) => {
    let s = 0;
    for (const w of words) if (terms.has(w)) s += idf(w);
    return { p, score: s / maxScore, member: memberPrompt(p) };
  });
  const members = scored.filter((x) => x.member);
  const others = scored.filter((x) => !x.member);
  // Pick the threshold with the best F1 among sensible values.
  let best = { t: 0.3, f1: -1 };
  for (const t of [0.12, 0.16, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5]) {
    const tp = members.filter((x) => x.score >= t).length;
    const fp = others.filter((x) => x.score >= t).length;
    const fn = members.length - tp;
    const precision = tp + fp ? tp / (tp + fp) : 0;
    const recall = members.length ? tp / members.length : 0;
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    if (f1 > best.f1) best = { t, f1, tp, fp, fn, precision, recall };
  }
  const uniqueTexts = (list) => [...new Set(list.map((x) => truncate(x.p.text.replace(/\s+/g, ' '), 140)))].slice(0, 3);
  const misses = uniqueTexts(members.filter((x) => x.score < best.t));
  const falsePositives = uniqueTexts(others.filter((x) => x.score >= best.t).sort((a, b) => b.score - a.score));
  const verdict = best.recall >= 0.8 && best.precision >= 0.6 ? 'good' : best.recall >= 0.5 ? 'fair' : 'weak';
  return {
    verdict,
    threshold: best.t,
    recall: round(best.recall),
    precision: round(best.precision),
    f1: round(best.f1),
    caught: best.tp || 0,
    missed: best.fn || 0,
    falsePositives: best.fp || 0,
    positives: members.length,
    corpus: N,
    examples: { misses, falsePositives },
    advice:
      verdict === 'good'
        ? 'The description picks out these requests well.'
        : verdict === 'fair'
          ? 'Add the words you actually use for this request to the description, so it triggers more reliably.'
          : 'The description does not share enough words with how you ask for this. Rewrite it in your own phrasing.',
    _positiveIds: positive.size,
  };
}

function round(x) {
  return Math.round((x || 0) * 100) / 100;
}

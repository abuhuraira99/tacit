import fs from 'node:fs';
import path from 'node:path';

/**
 * Generates a realistic, fully synthetic Claude Code history plus small demo project
 * folders, so Tacit can be tried (and tested, and screenshotted) without real data.
 * Deterministic: the same seed always produces the same history.
 */

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PROJECTS = [
  {
    name: 'storefront-web',
    stack: 'Next.js + TypeScript',
    files: ['app/(shop)/cart/page.tsx', 'components/ProductCard.tsx', 'lib/pricing.ts', 'lib/api/client.ts', 'app/checkout/actions.ts', 'tests/pricing.test.ts'],
    scripts: { dev: 'next dev', build: 'next build', test: 'vitest run', lint: 'eslint .', typecheck: 'tsc --noEmit' },
    lock: 'pnpm-lock.yaml',
    claudeMd: `# storefront-web

Next.js 15 storefront. Payments go through \`lib/api/client.ts\`.

## Commands

- \`pnpm dev\` starts the app on port 3000
- \`pnpm test\` runs Vitest

## Working agreements

- Use pnpm, never npm or yarn.
- Try to keep components small if possible.
- Run the tests before you say a task is done.
- Use pnpm for every install.
`,
    tasks: [
      'add a quantity stepper to the cart page',
      'the discount code field accepts expired codes, fix it',
      'refactor ProductCard so the price formatting lives in lib/pricing',
      'add skeleton loading states to the product grid',
      'checkout button stays disabled after the address form is valid',
      'make the header sticky on mobile',
      'write tests for the tax calculation in lib/pricing',
      'move the API base url into an env variable',
    ],
  },
  {
    name: 'billing-api',
    stack: 'Python + FastAPI',
    files: ['app/routes/invoices.py', 'app/services/stripe_sync.py', 'app/models/invoice.py', 'tests/test_invoices.py', 'alembic/versions/0042_add_credit_notes.py'],
    pyproject: true,
    claudeMd: `# billing-api

FastAPI service for invoices and credit notes.

- Run \`python -m pytest -q\` before finishing.
- Never log customer emails or card fingerprints.
`,
    tasks: [
      'add a credit notes endpoint with pagination',
      'invoice totals are off by a cent for some currencies',
      'write a migration that backfills the currency column',
      'the stripe webhook handler retries forever on 400s',
      'add structured logging to the sync job',
      'explain how the proration logic works today',
    ],
  },
  {
    name: 'mobile-app',
    stack: 'React Native',
    files: ['src/screens/Home.tsx', 'src/screens/Settings.tsx', 'src/hooks/useAuth.ts', 'src/navigation/index.tsx', 'src/api/session.ts'],
    scripts: { start: 'expo start', test: 'jest', lint: 'eslint src' },
    lock: 'yarn.lock',
    claudeMd: null,
    tasks: [
      'the settings screen flashes white in dark mode',
      'add pull to refresh on the home feed',
      'session token is not refreshed after the app resumes',
      'add an empty state for the notifications tab',
      'deep links to /orders/:id open the wrong screen',
    ],
  },
  {
    name: 'ops-scripts',
    stack: 'Node scripts',
    files: ['scripts/rotate-logs.mjs', 'scripts/backup-db.mjs', 'scripts/report.mjs', 'README.md'],
    scripts: { test: 'node --test' },
    lock: 'package-lock.json',
    claudeMd: `# ops-scripts

Small maintenance scripts.

- Don't commit or push anything without asking me first.
- Do not commit or push without asking.
`,
    tasks: ['add a dry run flag to the backup script', 'the log rotation deletes the current file', 'write a weekly usage report script'],
  },
];

// Things the person keeps saying. Weighted so a few habits clearly dominate.
const HABITS = [
  { w: 9, texts: ['run the tests before you tell me it is done', 'make sure all the tests pass before you finish', 'did you run the tests? run them first', 'run the test suite again before saying it works'] },
  { w: 7, texts: ['use pnpm not npm', 'please use pnpm for installs, not npm', 'again, this project uses pnpm, not npm'] },
  { w: 6, texts: ["don't add comments everywhere, only where the why isn't obvious", 'too many comments, remove the ones that just repeat the code', 'no comments that restate what the code does'] },
  { w: 6, texts: ['explain it in simple words, no jargon', 'can you explain that in plain english', 'keep the explanation simple please'] },
  { w: 5, texts: ['check it in the browser and tell me what you actually see', 'open it in the browser and take a screenshot before saying it looks right', 'verify the ui in chrome, not just the code'] },
  { w: 5, texts: ["don't touch anything unrelated to this task", 'only change what is needed, leave the rest alone', 'do not refactor other files while you are at it'] },
  { w: 4, texts: ['no, you forgot the error handling again', 'you forgot to handle the empty state again', 'still not handling the loading state'] },
  { w: 3, texts: ["don't commit or push, i will do it", 'never push without asking me'] },
  { w: 3, texts: ['keep answers short, just tell me what changed', 'be more concise please'] },
  { w: 2, texts: ['plan it first and wait for my ok before editing', 'make a plan before you start coding'] },
];

const REVIEW_BRIEF = `Review this change like a senior engineer before I merge it.

## Checklist
- **Correctness**: edge cases, null handling, off-by-one errors
- **Security**: secrets, injection, auth checks on every route
- **Tests**: is the new behaviour covered? are tests meaningful?
- **Readability**: naming, function size, dead code
- **Performance**: n+1 queries, unnecessary re-renders

## Output
Give me a table of findings with severity (high / medium / low), the file and line, and a one line fix. Finish with a verdict: merge, merge after fixes, or rework.`;

const MODELS = [
  ['claude-opus-5-5', 0.62],
  ['claude-sonnet-5-5', 0.3],
  ['claude-haiku-5-5', 0.08],
];

export function generateDemo(rootDir, { seed = 7, sessions = 64, days = 42, now = Date.now() } = {}) {
  const rand = rng(seed);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const chance = (p) => rand() < p;
  const weighted = (items, key = 'w') => {
    const total = items.reduce((a, x) => a + (Array.isArray(x) ? x[1] : x[key]), 0);
    let r = rand() * total;
    for (const x of items) {
      r -= Array.isArray(x) ? x[1] : x[key];
      if (r <= 0) return x;
    }
    return items[items.length - 1];
  };
  let counter = 0;
  const uid = (prefix) => `${prefix}${(++counter).toString(36).padStart(6, '0')}${Math.floor(rand() * 1e8).toString(36)}`;

  const workspace = path.join(rootDir, 'workspace');
  const projectsDir = path.join(rootDir, 'claude', 'projects');
  fs.rmSync(rootDir, { recursive: true, force: true });
  fs.mkdirSync(projectsDir, { recursive: true });

  // Demo project folders, so memory health and hook detection have something real to read.
  for (const p of PROJECTS) {
    const dir = path.join(workspace, p.name);
    fs.mkdirSync(dir, { recursive: true });
    if (p.claudeMd) fs.writeFileSync(path.join(dir, 'CLAUDE.md'), p.claudeMd);
    if (p.scripts) fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: p.name, private: true, scripts: p.scripts }, null, 2) + '\n');
    if (p.lock) fs.writeFileSync(path.join(dir, p.lock), '');
    if (p.pyproject) fs.writeFileSync(path.join(dir, 'pyproject.toml'), `[project]\nname = "${p.name}"\nversion = "0.1.0"\n`);
  }
  fs.mkdirSync(path.join(rootDir, 'claude'), { recursive: true });
  fs.writeFileSync(
    path.join(rootDir, 'claude', 'CLAUDE.md'),
    `# Personal preferences\n\n- Explain things in plain, simple English.\n- Keep answers short.\n`,
  );

  const sessionStarts = [];
  for (let i = 0; i < sessions; i++) {
    const dayOffset = Math.floor(Math.pow(rand(), 0.8) * days);
    const hour = weighted([[9, 2], [10, 3], [11, 3], [13, 2], [14, 3], [15, 3], [16, 2], [17, 1], [21, 1], [22, 1]])[0];
    const t = now - dayOffset * 864e5;
    const d = new Date(t);
    d.setHours(hour, Math.floor(rand() * 60), Math.floor(rand() * 60), 0);
    sessionStarts.push(Math.min(d.getTime(), now - 60_000));
  }
  sessionStarts.sort((a, b) => a - b);

  let briefUses = 0;
  for (let i = 0; i < sessions; i++) {
    const proj = weighted(PROJECTS.map((p, idx) => [p, [5, 3, 3, 1][idx]]))[0];
    const cwd = path.join(workspace, proj.name);
    const sessionId = cryptoLikeId(rand);
    const key = cwd.replace(/[:\\/.]/g, '-');
    const file = path.join(projectsDir, key, `${sessionId}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const model = weighted(MODELS)[0];
    const lines = [];
    let t = sessionStarts[i];
    let parent = null;
    const branch = chance(0.6) ? 'main' : `feature/${pick(['cart', 'auth', 'billing', 'ui-polish', 'sync'])}`;
    const base = { cwd, sessionId, version: '2.1.310', gitBranch: branch, entrypoint: chance(0.7) ? 'cli' : 'claude-vscode', userType: 'external' };
    let context = 14000 + Math.floor(rand() * 6000);
    let totals = { in: 0, out: 0, cw: 0, cr: 0 };
    const promptsInSession = 2 + Math.floor(rand() * 6);
    let compacted = false;
    const task = pick(proj.tasks);

    for (let k = 0; k < promptsInSession; k++) {
      let text;
      if (k === 0) {
        if (chance(0.16) && briefUses < 7) {
          text = REVIEW_BRIEF;
          briefUses++;
        } else {
          text = task;
          if (chance(0.55)) text += `. ${pick(weighted(HABITS).texts)}`;
        }
      } else if (chance(0.62)) {
        text = pick(weighted(HABITS).texts);
      } else {
        text = pick(['looks good, now add tests for it', 'what about the error case?', 'ok continue', 'can you also update the readme', 'that broke the build, check the logs', 'nice, ship it']);
      }
      t += 20_000 + Math.floor(rand() * 240_000);
      const uuid = uid('u');
      lines.push({ parentUuid: parent, isSidechain: false, type: 'user', message: { role: 'user', content: text }, uuid, timestamp: iso(t), ...base, origin: { kind: 'human' }, permissionMode: chance(0.2) ? 'plan' : 'default' });
      parent = uuid;

      if (chance(0.06)) {
        t += 4000;
        lines.push({ parentUuid: parent, isSidechain: false, type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }, uuid: uid('u'), timestamp: iso(t), ...base, origin: { kind: 'human' } });
      }

      const steps = 2 + Math.floor(rand() * 7);
      for (let s = 0; s < steps; s++) {
        t += 3000 + Math.floor(rand() * 40_000);
        const tool = weighted([['Read', 5], ['Edit', 4], ['Bash', 4], ['Grep', 2], ['Glob', 1], ['Write', 1], ['Task', 0.6], ['WebSearch', 0.4]])[0];
        const input = toolInput(tool, proj, pick, rand);
        const out = 120 + Math.floor(rand() * 900);
        const cw = 400 + Math.floor(rand() * 3000);
        const usage = { input_tokens: 3 + Math.floor(rand() * 40), output_tokens: out, cache_read_input_tokens: context, cache_creation_input_tokens: cw, cache_creation: { ephemeral_5m_input_tokens: cw, ephemeral_1h_input_tokens: 0 } };
        totals.in += usage.input_tokens;
        totals.out += out;
        totals.cw += cw;
        totals.cr += context;
        const msgId = uid('msg_');
        const toolId = uid('toolu_');
        const aUuid = uid('a');
        lines.push({
          parentUuid: parent,
          isSidechain: false,
          type: 'assistant',
          message: { id: msgId, type: 'message', role: 'assistant', model, content: [{ type: 'tool_use', id: toolId, name: tool, input }], stop_reason: 'tool_use', usage },
          requestId: uid('req_'),
          uuid: aUuid,
          timestamp: iso(t),
          ...base,
        });
        parent = aUuid;
        const heavy = tool === 'Bash' && chance(0.08) ? 42000 + Math.floor(rand() * 40000) : tool === 'Read' ? 1500 + Math.floor(rand() * 9000) : 200 + Math.floor(rand() * 2500);
        t += 500 + Math.floor(rand() * 4000);
        const rUuid = uid('u');
        lines.push({
          parentUuid: parent,
          isSidechain: false,
          type: 'user',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: filler(heavy, rand), is_error: chance(0.04) }] },
          toolUseResult: { type: 'text' },
          sourceToolUseID: toolId,
          uuid: rUuid,
          timestamp: iso(t),
          ...base,
        });
        parent = rUuid;
        context += cw + Math.floor(heavy / 4);
        if (context > 170000 && !compacted) {
          compacted = true;
          t += 9000;
          lines.push({ parentUuid: parent, isSidechain: false, type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', compactMetadata: { trigger: 'auto', preTokens: context }, uuid: uid('s'), timestamp: iso(t), ...base });
          context = 22000;
        }
        if (tool === 'Task') writeSubagent(projectsDir, key, sessionId, base, t, rand, uid, model);
      }
      t += 2000 + Math.floor(rand() * 15000);
      const done = uid('a');
      const out = 150 + Math.floor(rand() * 600);
      lines.push({
        parentUuid: parent,
        isSidechain: false,
        type: 'assistant',
        message: { id: uid('msg_'), type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'Done. Summary of the change and what I checked.' }], stop_reason: 'end_turn', usage: { input_tokens: 4, output_tokens: out, cache_read_input_tokens: context, cache_creation_input_tokens: 600 } },
        requestId: uid('req_'),
        uuid: done,
        timestamp: iso(t),
        ...base,
      });
      totals.in += 4;
      totals.out += out;
      totals.cr += context;
      totals.cw += 600;
      parent = done;
    }
    lines.push({ type: 'ai-title', aiTitle: titleCase(text0(lines)), sessionId });
    const price = model.includes('opus') ? [4, 20, 0.2] : model.includes('sonnet') ? [2, 10, 0.2] : [0.1, 0.5, 0.01];
    const usd = (totals.in * price[0] + totals.out * price[1] + totals.cw * price[0] * 1.25 + totals.cr * price[2]) / 1e6;
    lines.push({ type: 'cost-state', sessionId, totalCostUSD: Math.round(usd * 1e4) / 1e4, totalLinesAdded: Math.floor(rand() * 400), totalLinesRemoved: Math.floor(rand() * 120), totalDuration: t - sessionStarts[i] });
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const mt = new Date(t);
    fs.utimesSync(file, mt, mt);
  }
  return { projectsDir, workspace, claudeHome: path.join(rootDir, 'claude') };
}

function writeSubagent(projectsDir, key, sessionId, base, t, rand, uid, model) {
  const dir = path.join(projectsDir, key, sessionId, 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  const agentId = uid('agent');
  const lines = [];
  let ts = t;
  lines.push({ parentUuid: null, isSidechain: true, type: 'user', message: { role: 'user', content: 'Search the codebase for every place the price is formatted and report back.' }, uuid: uid('u'), timestamp: new Date(ts).toISOString(), ...base });
  for (let i = 0; i < 3 + Math.floor(rand() * 4); i++) {
    ts += 2000 + Math.floor(rand() * 8000);
    lines.push({
      parentUuid: null,
      isSidechain: true,
      type: 'assistant',
      message: { id: uid('msg_'), role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'tool_use', id: uid('toolu_'), name: 'Grep', input: { pattern: 'formatPrice' } }], usage: { input_tokens: 5, output_tokens: 80 + Math.floor(rand() * 200), cache_read_input_tokens: 9000, cache_creation_input_tokens: 800 } },
      uuid: uid('a'),
      timestamp: new Date(ts).toISOString(),
      ...base,
    });
  }
  fs.writeFileSync(path.join(dir, `agent-${agentId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

function toolInput(tool, proj, pick, rand) {
  const f = pick(proj.files);
  switch (tool) {
    case 'Read':
      return { file_path: `/${proj.name}/${f}` };
    case 'Edit':
    case 'Write':
      return { file_path: `/${proj.name}/${f}`, old_string: 'a', new_string: 'b' };
    case 'Bash':
      return { command: pick(proj.lock === 'pnpm-lock.yaml' ? ['pnpm test', 'pnpm lint', 'pnpm build', 'git status', 'git diff --stat'] : proj.pyproject ? ['python -m pytest -q', 'git status', 'ruff check .'] : ['npm test', 'yarn lint', 'git status', 'git log --oneline -5']) };
    case 'Grep':
      return { pattern: pick(['formatPrice', 'useAuth', 'TODO', 'invoice_total', 'currency']) };
    case 'Glob':
      return { pattern: '**/*.ts' };
    case 'Task':
      return { subagent_type: pick(['Explore', 'code-reviewer']), description: 'Find every price formatter', prompt: '...' };
    case 'WebSearch':
      return { query: 'next.js server actions revalidate cache' };
    default:
      return {};
  }
}

const WORDS = 'const value return function props state render effect import export default async await promise error result data items index length format price total currency cart user session token'.split(' ');
function filler(chars, rand) {
  let s = '';
  while (s.length < chars) s += WORDS[Math.floor(rand() * WORDS.length)] + (rand() < 0.1 ? '\n' : ' ');
  return s.slice(0, chars);
}

function text0(lines) {
  const first = lines.find((l) => l.type === 'user' && typeof l.message.content === 'string');
  const t = first ? first.message.content.split(/[.\n]/)[0] : 'Demo session';
  return t.slice(0, 70);
}

function titleCase(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function iso(t) {
  return new Date(t).toISOString();
}

function cryptoLikeId(rand) {
  const hex = () => Math.floor(rand() * 16).toString(16);
  const part = (n) => Array.from({ length: n }, hex).join('');
  return `${part(8)}-${part(4)}-4${part(3)}-${'89ab'[Math.floor(rand() * 4)]}${part(3)}-${part(12)}`;
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseSessionFile, commandSignature } from '../src/core/parse-file.js';
import { scan } from '../src/core/scanner.js';
import { buildIndex, overview, activeTime, contextLens } from '../src/core/analyze.js';
import { listSessionFiles, resolveProjectsDir } from '../src/core/paths.js';
import { sandbox, writeJsonl, userPrompt, assistant } from './helpers.js';

const usage = (i, o, cr = 0, cw = 0) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cw });

function fixture(root) {
  const projects = path.join(root, 'claude', 'projects');
  const main = path.join(projects, '-work-app', 's1.jsonl');
  writeJsonl(
    main,
    [
      userPrompt('use pnpm not npm', { ts: '2026-11-01T10:00:00.000Z' }),
      userPrompt('<system-reminder>ignore me</system-reminder>', { ts: '2026-11-01T10:00:01.000Z', fields: { isMeta: true } }),
      // The same assistant message is written once per content block; usage must count once.
      assistant('msg_1', usage(10, 100, 5000, 200), [{ type: 'text', text: 'ok' }]),
      assistant('msg_1', usage(10, 100, 5000, 200), [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'pnpm test -- --watch' } }]),
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'x'.repeat(40000) }] },
        toolUseResult: {},
        sourceToolUseID: 'toolu_1',
        timestamp: '2026-11-01T10:00:09.000Z',
        sessionId: 's1',
      },
      assistant('msg_2', usage(3, 50, 15000, 100), [{ type: 'tool_use', id: 'toolu_2', name: 'Read', input: { file_path: '/work/app/a.ts' } }], { ts: '2026-11-01T10:01:00.000Z' }),
      { type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto', preTokens: 160000 }, timestamp: '2026-11-01T10:02:00.000Z', sessionId: 's1' },
      userPrompt('[Request interrupted by user]', { ts: '2026-11-01T10:03:00.000Z' }),
      userPrompt('<command-name>/compact</command-name>', { ts: '2026-11-01T10:03:30.000Z' }),
      { type: 'ai-title', aiTitle: 'Switch to pnpm', sessionId: 's1' },
      { type: 'cost-state', sessionId: 's1', totalCostUSD: 1.25, totalLinesAdded: 10, totalLinesRemoved: 2 },
    ],
    { raw: ['{not json', '{"type":"file-history-snapshot","snapshot":{}}'] },
  );
  // A subagent transcript belonging to s1.
  writeJsonl(path.join(projects, '-work-app', 's1', 'subagents', 'agent-abc.jsonl'), [
    { ...userPrompt('search for formatters'), isSidechain: true },
    assistant('msg_sub', usage(5, 20, 1000, 0), [{ type: 'tool_use', id: 't9', name: 'Grep', input: { pattern: 'x' } }], { model: 'claude-haiku-5-5' }),
  ]);
  return projects;
}

test('parseSessionFile builds an accurate summary from a messy transcript', async () => {
  const root = sandbox();
  const projects = fixture(root);
  // Prepend a BOM to make sure it is tolerated.
  const file = path.join(projects, '-work-app', 's1.jsonl');
  fs.writeFileSync(file, '﻿' + fs.readFileSync(file, 'utf8'));
  const s = await parseSessionFile({ file, projectKey: '-work-app' });
  assert.equal(s.sessionId, 's1');
  assert.equal(s.prompts.length, 1, 'meta, interrupt and command lines are not prompts');
  assert.equal(s.prompts[0].text, 'use pnpm not npm');
  assert.equal(s.interrupts, 1);
  assert.equal(s.commands.compact, 1);
  assert.equal(s.badLines, 1);
  const u = s.usage['claude-opus-5-5'];
  assert.equal(u.out, 150, 'duplicated message blocks counted once');
  assert.equal(u.cr, 20000);
  assert.equal(s.tools.Bash, 1);
  assert.equal(s.bash['pnpm test'], 1);
  assert.equal(s.reads['/work/app/a.ts'], 1);
  assert.equal(s.compactions.length, 1);
  assert.equal(s.cost.usd, 1.25);
  assert.equal(s.title, 'Switch to pnpm');
  assert.equal(s.heavyResults[0].tool, 'Bash');
  assert.equal(s.heavyResults[0].tokens, 10000);
});

test('commandSignature keeps the meaningful part of a command', () => {
  assert.equal(commandSignature('npm run test -- --watch'), 'npm run test');
  assert.equal(commandSignature('git commit -m "x" && git push'), 'git commit');
  assert.equal(commandSignature('python -m pytest -q'), 'python -m pytest');
  assert.equal(commandSignature('NODE_ENV=test node script.js'), 'node script.js');
  assert.equal(commandSignature('ls -la'), 'ls');
});

test('scan uses workers or serial parsing, caches results, and indexes subagents', async () => {
  const root = sandbox();
  const projects = fixture(root);
  assert.equal(listSessionFiles(projects).length, 2);
  assert.equal(resolveProjectsDir(path.join(root, 'claude')), projects);
  const cacheDir = path.join(root, 'cache');
  const first = await scan({ projectsDir: projects, cacheDir });
  assert.equal(first.stats.parsed, 2);
  const second = await scan({ projectsDir: projects, cacheDir });
  assert.equal(second.stats.cached, 2, 'unchanged files come from the cache');

  const index = buildIndex(second.summaries);
  assert.equal(index.sessions.length, 1);
  const s = index.sessions[0];
  assert.equal(s.agentRuns.length, 1);
  assert.equal(s.tools.Grep, 1, 'subagent tool calls roll up into the session');
  assert.equal(s.cost.reported, true);
  const o = overview(index);
  assert.equal(o.totals.sessions, 1);
  assert.equal(o.totals.prompts, 1);
  assert.ok(o.totals.cacheHitRate > 0.9);
  const lens = contextLens(s);
  assert.ok(lens.findings.some((f) => /compacted/i.test(f.title)));
  assert.ok(lens.findings.some((f) => /8k tokens/.test(f.title)));
});

test('scan of a missing folder returns nothing instead of failing', async () => {
  const root = sandbox();
  const r = await scan({ projectsDir: path.join(root, 'nope'), useCache: false });
  assert.equal(r.summaries.length, 0);
});

test('activeTime ignores idle gaps', () => {
  const t = (m) => new Date(Date.UTC(2026, 0, 1, 10, m)).toISOString();
  assert.equal(activeTime([t(0), t(5), t(60), t(62)]), 7 * 60000);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox } from './helpers.js';
import { applyArtifact, SafeWriteError } from '../src/core/apply.js';
import {
  listStartupMemory,
  readStartupFile,
  setFileEnabled,
  takeOutRule,
  restoreParkedRule,
  saveStartupFile,
  addStartupRule,
  compareBackup,
  restoreBackup,
  extractRules,
  resolveImports,
  diffLines,
} from '../src/core/memory.js';

const GLOBAL = '# Me\n\n## Working agreements\n\n- Explain things in simple language.\n- Ask questions while you work.\n\n## Tools\n\n- Use pnpm.\n';

function setup() {
  const root = sandbox('tacit-memory');
  const claude = process.env.CLAUDE_CONFIG_DIR;
  const project = path.join(root, 'proj');
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  const globalFile = path.join(claude, 'CLAUDE.md');
  fs.writeFileSync(globalFile, GLOBAL);
  fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# Project\n\n- Run the tests.\n');
  const index = { projects: [{ id: 'p1', label: 'proj', cwd: project, sessions: 3 }] };
  return { root, claude, project, globalFile, roots: [claude, project], index };
}

test('lists the personal file first, then project files that exist', () => {
  const { index, globalFile, project } = setup();
  const scopes = listStartupMemory(index);
  assert.equal(scopes[0].id, 'global');
  assert.equal(scopes[0].files[0].path, globalFile);
  assert.ok(scopes[0].files[0].exists);
  assert.ok(scopes[0].activeTokens > 0);
  assert.equal(scopes[1].id, 'p1');
  assert.deepEqual(scopes[1].files.map((f) => f.path), [path.join(project, 'CLAUDE.md')]);
});

test('reads rules with their section and line', () => {
  const rules = extractRules(GLOBAL + '\n```\n- not a rule\n```\n');
  assert.deepEqual(rules.map((r) => [r.line, r.section, r.text]), [
    [5, 'Working agreements', 'Explain things in simple language.'],
    [6, 'Working agreements', 'Ask questions while you work.'],
    [10, 'Tools', 'Use pnpm.'],
  ]);
});

test('resolves @ imports and ignores ones inside code', () => {
  const { claude } = setup();
  fs.writeFileSync(path.join(claude, 'extra.md'), 'More rules here.');
  const out = resolveImports('See @extra.md and @missing.md\n`@code.md` is not an import. mail me@site.com', claude);
  assert.deepEqual(out.map((i) => [i.ref, i.exists]), [
    ['extra.md', true],
    ['missing.md', false],
  ]);
  assert.ok(out[0].tokens > 0);
});

test('switching a file off renames it, and on brings it back', () => {
  const { globalFile, roots } = setup();
  assert.equal(setFileEnabled(globalFile, false, roots).status, 'disabled');
  assert.ok(!fs.existsSync(globalFile));
  assert.ok(fs.existsSync(globalFile + '.disabled'));
  const view = readStartupFile(globalFile, roots);
  assert.equal(view.disabled, true);
  assert.equal(view.content, GLOBAL, 'still readable while off');
  assert.throws(() => takeOutRule(globalFile, { line: 5, text: 'Explain things in simple language.' }, roots), SafeWriteError);
  assert.equal(setFileEnabled(globalFile, true, roots).status, 'enabled');
  assert.equal(fs.readFileSync(globalFile, 'utf8'), GLOBAL);
  assert.equal(setFileEnabled(globalFile, true, roots).status, 'unchanged');
});

test('pausing a rule takes it out of the file and turning it back on restores it to its section', () => {
  const { globalFile, roots } = setup();
  const r = takeOutRule(globalFile, { line: 6, text: 'Ask questions while you work.', mode: 'pause' }, roots);
  assert.equal(r.status, 'paused');
  assert.ok(fs.existsSync(r.backup));
  assert.doesNotMatch(fs.readFileSync(globalFile, 'utf8'), /Ask questions/);
  const view = readStartupFile(globalFile, roots);
  assert.equal(view.parkedRules.length, 1);
  assert.equal(view.parkedRules[0].section, 'Working agreements');

  assert.equal(restoreParkedRule(globalFile, 'Ask questions while you work.', roots).status, 'restored');
  const text = fs.readFileSync(globalFile, 'utf8');
  assert.match(text, /## Working agreements\n\n- Explain things in simple language\.\n- Ask questions while you work\.\n\n## Tools/);
  assert.equal(readStartupFile(globalFile, roots).parkedRules.length, 0);
});

test('finds the rule by text when the line number is stale', () => {
  const { globalFile, roots } = setup();
  const r = takeOutRule(globalFile, { line: 1, text: 'Use pnpm.', mode: 'remove' }, roots);
  assert.equal(r.status, 'removed');
  const text = fs.readFileSync(globalFile, 'utf8');
  assert.doesNotMatch(text, /Use pnpm/);
  assert.match(text, /# Me/, 'the heading on line 1 is untouched');
  assert.equal(readStartupFile(globalFile, roots).parkedRules.length, 0, 'removed rules are not kept');
});

test('adding a rule directly skips near-duplicates', () => {
  const { globalFile, roots } = setup();
  assert.equal(addStartupRule(globalFile, 'Never push without asking.', 'Working agreements', roots).status, 'added');
  assert.match(fs.readFileSync(globalFile, 'utf8'), /- Never push without asking\./);
  assert.equal(addStartupRule(globalFile, 'Explain things in simple language!', 'Working agreements', roots).status, 'skipped');
  assert.throws(() => addStartupRule(globalFile, '   ', null, roots), SafeWriteError);
});

test('saving keeps a backup that can be compared and restored', () => {
  const { globalFile, roots } = setup();
  const saved = saveStartupFile(globalFile, '# Me\n\n- Only this.\n', roots);
  assert.equal(saved.status, 'saved');
  assert.ok(saved.diff.some((d) => d.type === 'add' && d.text === '- Only this.'));
  assert.ok(saved.diff.some((d) => d.type === 'del' && d.text.includes('Explain things')));
  assert.equal(saveStartupFile(globalFile, '# Me\n\n- Only this.\n', roots).status, 'unchanged');

  const view = readStartupFile(globalFile, roots);
  assert.ok(view.backups.length >= 1);
  const b = view.backups[0];
  const cmp = compareBackup(globalFile, b.id, roots);
  assert.ok(cmp.diff.some((d) => d.type === 'del' && d.text === '- Only this.'));
  restoreBackup(globalFile, b.id, roots);
  assert.equal(fs.readFileSync(globalFile, 'utf8'), GLOBAL);
  assert.throws(() => restoreBackup(globalFile, 'nope/nope', roots), SafeWriteError);
});

test('rules saved from Repeats show up in the change history and are marked', () => {
  const { globalFile, roots } = setup();
  applyArtifact({ mode: 'append-rule', path: globalFile, content: '- Verify it in the browser.', kind: 'rule' }, { allowedRoots: roots });
  const view = readStartupFile(globalFile, roots);
  assert.ok(view.history.some((h) => h.text === '- Verify it in the browser.'));
  const rule = view.rules.find((r) => r.text === 'Verify it in the browser.');
  assert.equal(rule.addedByTacit, true);
  assert.equal(view.rules.find((r) => r.text === 'Use pnpm.').addedByTacit, false);
});

test('refuses files that are not CLAUDE.md or are outside allowed folders', () => {
  const { root, roots, project } = setup();
  assert.throws(() => readStartupFile(path.join(project, 'package.json'), roots), SafeWriteError);
  assert.throws(() => saveStartupFile(path.join(root, 'elsewhere', 'CLAUDE.md'), 'x', roots), SafeWriteError);
  assert.throws(() => saveStartupFile(path.join(project, '..', '..', 'CLAUDE.md'), 'x', roots), SafeWriteError);
});

test('diffLines collapses long unchanged stretches', () => {
  const a = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
  const b = a.replace('line 15', 'line fifteen');
  const d = diffLines(a, b);
  assert.deepEqual(d.filter((x) => x.type === 'del').map((x) => x.text), ['line 15']);
  assert.deepEqual(d.filter((x) => x.type === 'add').map((x) => x.text), ['line fifteen']);
  assert.ok(d.some((x) => x.type === 'skip'));
  assert.ok(d.length < 12);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { applyArtifact, assertInside, SafeWriteError } from '../src/core/apply.js';
import { sandbox } from './helpers.js';

function setup() {
  const root = sandbox();
  const project = path.join(root, 'proj');
  fs.mkdirSync(project);
  return { root, project, roots: [project] };
}

test('appends a rule under a new section, then into the existing section', () => {
  const { project, roots } = setup();
  const file = path.join(project, 'CLAUDE.md');
  fs.writeFileSync(file, '# App\n\nSome notes.\n');
  const a = applyArtifact({ mode: 'append-rule', path: file, content: '- Use pnpm.', section: 'Working agreements' }, { allowedRoots: roots });
  assert.equal(a.status, 'written');
  assert.ok(a.backup && fs.existsSync(a.backup), 'backup taken');
  const b = applyArtifact({ mode: 'append-rule', path: file, content: '- Run the tests before finishing.', section: 'Working agreements' }, { allowedRoots: roots });
  assert.equal(b.status, 'written');
  const text = fs.readFileSync(file, 'utf8');
  assert.equal((text.match(/## Working agreements/g) || []).length, 1);
  assert.match(text, /## Working agreements\n\n- Use pnpm\.\n- Run the tests before finishing\.\n$/);
});

test('inserts into a section that sits in the middle of the file and keeps CRLF', () => {
  const { project, roots } = setup();
  const file = path.join(project, 'CLAUDE.md');
  fs.writeFileSync(file, '# App\r\n\r\n## Working agreements\r\n\r\n- Keep it small.\r\n\r\n## Commands\r\n\r\n- pnpm dev\r\n');
  applyArtifact({ mode: 'append-rule', path: file, content: '- Use pnpm.' }, { allowedRoots: roots });
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /- Keep it small\.\r\n- Use pnpm\.\r\n\r\n## Commands/);
});

test('skips near-duplicate rules', () => {
  const { project, roots } = setup();
  const file = path.join(project, 'CLAUDE.md');
  fs.writeFileSync(file, '## Working agreements\n\n- Use pnpm, never npm.\n');
  const r = applyArtifact({ mode: 'append-rule', path: file, content: '- Use pnpm, never npm!' }, { allowedRoots: roots });
  assert.equal(r.status, 'skipped');
});

test('merges hooks into settings.json and refuses broken JSON', () => {
  const { project, roots } = setup();
  const file = path.join(project, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } }));
  const snippet = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'npm test' }] }] } });
  const r = applyArtifact({ mode: 'merge-json', path: file, content: snippet }, { allowedRoots: roots });
  assert.equal(r.status, 'written');
  const merged = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(merged.model, 'opus');
  assert.equal(merged.hooks.Stop.length, 2);
  assert.equal(applyArtifact({ mode: 'merge-json', path: file, content: snippet }, { allowedRoots: roots }).status, 'skipped');

  fs.writeFileSync(file, '{ broken');
  assert.throws(() => applyArtifact({ mode: 'merge-json', path: file, content: snippet }, { allowedRoots: roots }), SafeWriteError);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ broken', 'broken file left untouched');
});

test('new files are never overwritten without consent', () => {
  const { project, roots } = setup();
  const file = path.join(project, '.claude', 'skills', 'x', 'SKILL.md');
  assert.equal(applyArtifact({ mode: 'create', path: file, content: 'one' }, { allowedRoots: roots }).status, 'written');
  assert.equal(applyArtifact({ mode: 'create', path: file, content: 'two' }, { allowedRoots: roots }).status, 'exists');
  assert.equal(fs.readFileSync(file, 'utf8'), 'one\n');
  const r = applyArtifact({ mode: 'create', path: file, content: 'two' }, { allowedRoots: roots, overwrite: true });
  assert.equal(r.status, 'written');
  assert.ok(r.backup);
});

test('refuses to write outside allowed folders, including via ..', () => {
  const { root, project, roots } = setup();
  assert.throws(() => assertInside(path.join(root, 'elsewhere', 'CLAUDE.md'), roots), SafeWriteError);
  assert.throws(() => assertInside(path.join(project, '..', 'escape.md'), roots), SafeWriteError);
  assert.throws(() => assertInside(project + '-sibling/CLAUDE.md', roots), SafeWriteError);
  assert.doesNotThrow(() => assertInside(path.join(project, 'CLAUDE.md'), roots));
});

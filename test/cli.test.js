import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { generateDemo } from '../src/demo/generate.js';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'tacit.js');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tacit-cli-'));
const env = { ...process.env, TACIT_HOME: path.join(home, 'tacit'), CLAUDE_CONFIG_DIR: path.join(home, 'claude'), NO_COLOR: '1' };
const run = (...args) => spawnSync(process.execPath, [bin, ...args], { env, encoding: 'utf8', timeout: 60000 });

test('--version and --help', () => {
  const v = run('--version');
  assert.equal(v.status, 0);
  assert.match(v.stdout.trim(), /^\d+\.\d+\.\d+$/);
  assert.match(run('--help').stdout, /tacit habits/);
});

test('unknown commands and options fail with a clear message', () => {
  assert.equal(run('frobnicate').status, 2);
  assert.equal(run('--nope').status, 2);
});

test('scan --demo --json prints valid totals', () => {
  const r = run('scan', '--demo', '--json');
  assert.equal(r.status, 0, r.stderr);
  const data = JSON.parse(r.stdout);
  assert.ok(data.totals.sessions > 10);
});

test('habits and report work against a custom --dir', () => {
  const demo = generateDemo(path.join(home, 'custom'), { sessions: 20 });
  const h = run('habits', '--dir', demo.projectsDir, '--json');
  assert.equal(h.status, 0, h.stderr);
  assert.ok(JSON.parse(h.stdout).length > 0);
  const out = path.join(home, 'retro.md');
  const r = run('report', '--dir', demo.projectsDir, '-o', out);
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(out, 'utf8'), /What you keep telling Claude/);
});

test('an empty history is handled gracefully', () => {
  const r = run('scan', '--dir', path.join(home, 'nothing-here'), '--json');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).totals.sessions, 0);
});

test('doctor runs', () => {
  const r = run('doctor');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Node\.js/);
});

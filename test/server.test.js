import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { sandbox } from './helpers.js';
import { generateDemo } from '../src/demo/generate.js';
import { TacitApp } from '../src/core/app.js';
import { createServer } from '../src/server/server.js';

let srv;
let base;
let token;
let port;
let demo;

before(async () => {
  const root = sandbox('tacit-server');
  demo = generateDemo(path.join(root, 'demo'), { sessions: 30 });
  process.env.CLAUDE_CONFIG_DIR = demo.claudeHome;
  const app = new TacitApp({ dir: demo.projectsDir, cacheDir: path.join(root, 'cache') });
  srv = createServer(app, { port: 0 });
  ({ port } = await srv.listen());
  base = `http://127.0.0.1:${port}`;
  token = srv.token;
  await app.load();
});

after(async () => {
  await srv.close();
});

function raw(pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const json = async (p, opts) => {
  const r = await fetch(base + p, opts);
  return { status: r.status, data: await r.json().catch(() => null) };
};
const post = (p, body, withToken = true) =>
  json(p, { method: 'POST', headers: { 'content-type': 'application/json', ...(withToken ? { 'x-tacit-token': token } : {}) }, body: JSON.stringify(body) });

test('serves the app with the session token and strict headers', async () => {
  const r = await fetch(base + '/');
  const html = await r.text();
  assert.equal(r.status, 200);
  assert.ok(html.includes(token));
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
});

test('read endpoints return the analysis', async () => {
  const s = await json('/api/status');
  assert.equal(s.data.status, 'ready');
  assert.equal(s.data.counts.sessions, 30);
  const o = await json('/api/overview');
  assert.ok(o.data.totals.prompts > 0);
  assert.ok(o.data.topPattern);
  const p = await json('/api/patterns');
  assert.ok(p.data.length > 3);
  const one = await json(`/api/patterns/${p.data[0].id}`);
  assert.equal(one.data.id, p.data[0].id);
  const sessions = await json('/api/sessions?sort=cost');
  assert.equal(sessions.data.total, 30);
  const detail = await json(`/api/sessions/${sessions.data.items[0].id}`);
  assert.ok(detail.data.lens.findings.length >= 1);
  const health = await json('/api/health');
  assert.ok(health.data.length >= 1);
  const rep = await json('/api/report');
  assert.match(rep.data.markdown, /^# Claude Code retrospective/);
  assert.equal((await json('/api/patterns/nope')).status, 404);
});

test('state-changing requests need the token and a local origin', async () => {
  assert.equal((await post('/api/scan', {}, false)).status, 403);
  const evil = await json('/api/scan', { method: 'POST', headers: { 'x-tacit-token': token, origin: 'https://evil.example' } });
  assert.equal(evil.status, 403);
});

test('DNS rebinding: foreign Host headers are rejected', async () => {
  const r = await raw('/api/status', { headers: { host: 'evil.example:80' } });
  assert.equal(r.status, 421);
});

test('static files cannot escape the web folder', async () => {
  const r = await raw('/..%2f..%2fpackage.json');
  assert.notEqual(r.status, 200);
  const r2 = await raw('/js/../../core/app.js');
  assert.notEqual(r2.status, 200);
});

test('draft, evaluate and apply a rule into a real project folder', async () => {
  const patterns = (await json('/api/patterns')).data;
  const pkg = patterns.find((p) => p.habit === 'package-manager') || patterns[0];
  const draft = await post('/api/forge/draft', { patternId: pkg.id, kind: 'rule', scope: 'project' });
  assert.equal(draft.status, 200);
  assert.ok(draft.data.artifact.path.startsWith(demo.workspace));
  const skill = await post('/api/forge/draft', { patternId: pkg.id, kind: 'skill' });
  assert.ok(skill.data.trigger.positives >= 1);

  assert.equal((await post('/api/forge/apply', { patternId: pkg.id, kind: 'rule', scope: 'project' })).status, 400, 'needs confirm');
  const applied = await post('/api/forge/apply', { patternId: pkg.id, kind: 'rule', scope: 'project', confirm: true, content: '- A brand new rule written by the test suite.' });
  assert.equal(applied.status, 200);
  assert.equal(applied.data.status, 'written');
  assert.ok(fs.readFileSync(applied.data.path, 'utf8').includes('A brand new rule written by the test suite.'));
});

test('refine explains clearly when no engine is configured', async () => {
  await post('/api/settings', { engine: 'none' });
  const patterns = (await json('/api/patterns')).data;
  const r = await post('/api/forge/refine', { patternId: patterns[0].id, kind: 'rule' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /No Claude engine/);
});

test('bad JSON bodies are rejected cleanly', async () => {
  const r = await raw('/api/forge/draft', { method: 'POST', headers: { 'content-type': 'application/json', 'x-tacit-token': token, host: `127.0.0.1:${port}` }, body: '{oops' });
  assert.equal(r.status, 400);
});

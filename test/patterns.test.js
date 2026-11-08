import { test } from 'node:test';
import assert from 'node:assert/strict';
import { minePatterns, mineBriefs, isDocument, directiveScore, lexiconKey } from '../src/core/patterns.js';

let n = 0;
const P = (text, sessionId, projectId = 'p1', day = 1) => ({
  id: `x${n++}`,
  sessionId,
  projectId,
  projectLabel: projectId,
  ts: `2026-11-${String(day).padStart(2, '0')}T10:00:00.000Z`,
  text,
});

test('groups different wordings of the same instruction', () => {
  const prompts = [
    P('fix the login bug. run the tests before you tell me it is done', 's1', 'a', 1),
    P('make sure all the tests pass before you finish', 's2', 'a', 2),
    P('did you run the tests? run them first', 's3', 'b', 3),
    P('add a dark mode toggle', 's4', 'b', 4),
  ];
  const pats = minePatterns(prompts, { now: Date.parse('2026-11-05') });
  const tests = pats.find((p) => p.habit === 'run-tests');
  assert.ok(tests, 'test habit found');
  assert.equal(tests.count, 3);
  assert.equal(tests.sessions, 3);
  assert.equal(tests.scope, 'global');
  assert.equal(tests.suggestion, 'hook');
  assert.ok(!pats.some((p) => /dark mode/.test(p.text)), 'one-off tasks are not habits');
});

test('typo-tolerant grouping of free-form instructions', () => {
  const prompts = [
    P('i want the best results no matter the token usage, dont compromise', 's1'),
    P('i wnat the best results no matter teh token usage, dont compromis', 's2'),
    P('I want the best results no matter the token usage', 's3'),
  ];
  const pats = minePatterns(prompts);
  assert.equal(pats.length, 1);
  assert.equal(pats[0].count, 3);
});

test('a single-session repeat is ignored unless it is a correction loop', () => {
  const quiet = minePatterns([P('always use tabs', 's1'), P('always use tabs please', 's1')]);
  assert.equal(quiet.length, 0);
  const loop = minePatterns([P('no, you forgot the error handling again', 's1'), P('you forgot the error handling again', 's1'), P('you forgot the error handling', 's1')]);
  assert.equal(loop.length, 1);
  assert.equal(loop[0].kind, 'correction');
});

test('pasted documents are not mined line by line, but reused briefs are found', () => {
  const brief = `## Review checklist\n- **Correctness**: edge cases and null handling everywhere\n- **Security**: secrets, injection, auth checks on every route\n- **Tests**: is the new behaviour covered by meaningful tests\n## Output\nGive me a table of findings with severity, the file and line, and a one line fix. Finish with a verdict: merge, merge after fixes, or rework. Always be strict.`;
  assert.ok(isDocument(brief));
  const pats = minePatterns([P(brief, 's1'), P(brief + ' thanks', 's2'), P(brief, 's3')]);
  assert.equal(pats.filter((p) => p.kind !== 'brief').length, 0);
  const briefs = pats.filter((p) => p.kind === 'brief');
  assert.equal(briefs.length, 1);
  assert.equal(briefs[0].suggestion, 'command');
  assert.equal(briefs[0].count, 3);
  assert.equal(mineBriefs([P(brief, 's1')]).length, 0);
});

test('directive scoring and lexicon', () => {
  assert.ok(directiveScore('always use pnpm') > directiveScore('what is pnpm?'));
  assert.ok(directiveScore('fix line 42 in cart.tsx') < 1);
  assert.equal(lexiconKey('this project uses pnpm, not npm'), 'package-manager');
  assert.equal(lexiconKey('explain it in simple words, no jargon'), 'simple-language');
  assert.equal(lexiconKey("don't commit anything"), 'dont-commit');
});

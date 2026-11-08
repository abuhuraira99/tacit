import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { forge, toImperative, ruleText, evaluateTrigger, detectCommand, skillDescription } from '../src/core/forge.js';
import { sandbox } from './helpers.js';

const pattern = {
  id: 'p1',
  text: 'run the tests before you tell me it is done',
  variants: ['run the tests before you tell me it is done', 'make sure all the tests pass before you finish', 'did you run the tests?'],
  habit: 'run-tests',
  count: 3,
  sessions: 3,
  projects: [{ id: 'a', label: 'app' }],
  scope: 'project',
  keywords: ['test', 'run'],
  title: 'Run the tests before calling it done',
  slug: 'run-tests',
  occurrences: [
    { sessionId: 's1', text: 'run the tests before you tell me it is done' },
    { sessionId: 's2', text: 'make sure all the tests pass before you finish' },
    { sessionId: 's3', text: 'did you run the tests?' },
  ],
};

test('every artifact kind renders valid, targeted output', () => {
  const root = sandbox();
  const project = path.join(root, 'app');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run', lint: 'eslint .' } }));
  fs.writeFileSync(path.join(project, 'pnpm-lock.yaml'), '');

  const rule = forge(pattern, 'rule', { projectPath: project });
  assert.equal(rule.path, path.join(project, 'CLAUDE.md'));
  assert.match(rule.content, /^- Run the test suite/);

  const skill = forge(pattern, 'skill', { projectPath: project });
  assert.equal(skill.path, path.join(project, '.claude', 'skills', 'run-tests', 'SKILL.md'));
  assert.match(skill.content, /^---\nname: run-tests\ndescription: .+\n---\n/);
  assert.match(skill.description, /did you run the tests/);

  const hook = forge(pattern, 'hook', { projectPath: project });
  const json = JSON.parse(hook.content);
  assert.equal(hook.event, 'Stop');
  assert.match(json.hooks.Stop[0].hooks[0].command, /^pnpm test .*exit 2/);

  const agent = forge(pattern, 'subagent', { projectPath: project });
  assert.match(agent.content, /\ntools: /);
  assert.ok(agent.path.endsWith(path.join('.claude', 'agents', 'run-tests.md')));

  const cmd = forge({ ...pattern, body: 'Review this change.\n- check tests' }, 'command', { scope: 'global' });
  assert.ok(cmd.path.startsWith(process.env.CLAUDE_CONFIG_DIR));
  assert.match(cmd.content, /\$ARGUMENTS/);
});

test('global scope writes to the personal Claude folder', () => {
  sandbox();
  const r = forge({ ...pattern, scope: 'global' }, 'rule', {});
  assert.equal(r.path, path.join(process.env.CLAUDE_CONFIG_DIR, 'CLAUDE.md'));
});

test('toImperative turns speech into a rule', () => {
  assert.equal(toImperative('okay so i want you to keep the readme updated'), 'Keep the readme updated.');
  assert.equal(toImperative('make sure you add types'), 'Always add types.');
  assert.equal(ruleText(pattern), 'Run the test suite before saying a task is done, and report the result.');
});

test('hook command detection follows the project tooling', () => {
  const root = sandbox();
  fs.writeFileSync(path.join(root, 'pyproject.toml'), '[project]\nname="x"\n');
  assert.match(detectCommand({ ...pattern, habit: 'run-tests', text: 'run tests' }, root).command, /pytest/);
  assert.equal(detectCommand({ ...pattern, habit: 'dont-commit', text: "don't commit" }, root).event, 'PreToolUse');
});

test('trigger evaluation rewards descriptions in the user’s own words', () => {
  const prompts = [
    ...pattern.occurrences.map((o, i) => ({ sessionId: o.sessionId, text: o.text, id: String(i) })),
    { sessionId: 's9', text: 'add a dark mode toggle to settings' },
    { sessionId: 's10', text: 'refactor the invoice parser' },
  ];
  const good = evaluateTrigger(skillDescription(pattern), pattern, prompts);
  const bad = evaluateTrigger('Guarantee correctness of deliverables.', pattern, prompts);
  assert.ok(good.recall > bad.recall);
  assert.equal(good.falsePositives, 0);
  assert.equal(good.positives, 3);
});

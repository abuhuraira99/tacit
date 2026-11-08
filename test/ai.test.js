import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { refine, extractArtifact, RefineError } from '../src/core/ai.js';

// The SDK is an optional dependency; the API tests only run when it is installed.
const sdkInstalled = await import('@anthropic-ai/sdk').then(() => true, () => false);
const needsSdk = { skip: sdkInstalled ? false : '@anthropic-ai/sdk not installed (optional)' };

// A local stand-in for the Messages API so the refine path is tested without network or keys.
let server;
let calls = [];
before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      calls.push({ url: req.url, headers: req.headers, body: parsed });
      if (req.headers['x-api-key'] === 'bad' || req.headers.authorization === 'Bearer bad') {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: parsed.model,
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'submit_artifact', input: { content: '- Run the full test suite before you report a task as done.', rationale: 'Made it checkable.' } }],
          usage: { input_tokens: 900, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 800 },
        }),
      );
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const pattern = { text: 'run the tests first', variants: ['run the tests first'], count: 4, sessions: 3, projects: [{ id: 'a', label: 'a' }] };
const artifact = { kind: 'rule', path: '/x/CLAUDE.md', scope: 'project', content: '- Run the tests first.' };

test('refine sends a cached system prompt and a strict tool, and returns the tool input', needsSdk, async () => {
  calls = [];
  const out = await refine({ engine: 'api', apiKey: 'good', pattern, artifact });
  assert.equal(out.content, '- Run the full test suite before you report a task as done.\n');
  assert.equal(out.rationale, 'Made it checkable.');
  const sent = calls[0].body;
  assert.equal(sent.model, 'claude-opus-5-5');
  assert.equal(sent.output_config.effort, 'medium');
  assert.deepEqual(sent.system[0].cache_control, { type: 'ephemeral' });
  assert.equal(sent.tools[0].strict, true);
  assert.equal(sent.tools[0].input_schema.additionalProperties, false);
  assert.equal(sent.tool_choice.type, 'auto');
  assert.match(sent.messages[0].content, /run the tests first/);
});

test('a rejected key becomes a clear, typed error', needsSdk, async () => {
  await assert.rejects(
    () => refine({ engine: 'api', apiKey: 'bad', pattern, artifact }),
    (err) => err instanceof RefineError && err.code === 'auth' && /rejected/.test(err.message),
  );
});

test('extractArtifact handles tags, fences and plain text', () => {
  assert.equal(extractArtifact('x <artifact>\n- a rule\n</artifact> Rationale: y'), '- a rule');
  assert.equal(extractArtifact('<artifact>```md\n# hi\n```</artifact>'), '# hi');
  assert.equal(extractArtifact('```json\n{"a":1}\n```'), '{"a":1}\n');
  assert.equal(extractArtifact('  plain  '), 'plain');
});

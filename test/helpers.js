import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A fresh temp folder; Tacit and Claude homes are pointed inside it so tests never touch real data. */
export function sandbox(name = 'tacit-test') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  process.env.TACIT_HOME = path.join(root, 'tacit-home');
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude');
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  return root;
}

export function writeJsonl(file, records, { raw = [] } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r)));
  fs.writeFileSync(file, [...lines, ...raw].join('\n') + '\n');
}

export function userPrompt(text, extra = {}) {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    uuid: Math.random().toString(36).slice(2),
    timestamp: extra.ts || '2026-11-01T10:00:00.000Z',
    sessionId: extra.sessionId || 's1',
    cwd: extra.cwd || '/work/app',
    userType: 'external',
    origin: { kind: 'human' },
    ...extra.fields,
  };
}

export function assistant(id, usage, content = [], extra = {}) {
  return {
    type: 'assistant',
    message: { id, model: extra.model || 'claude-opus-5-5', role: 'assistant', content, usage },
    uuid: Math.random().toString(36).slice(2),
    timestamp: extra.ts || '2026-11-01T10:00:05.000Z',
    sessionId: extra.sessionId || 's1',
    cwd: extra.cwd || '/work/app',
  };
}

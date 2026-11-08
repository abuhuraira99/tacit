import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { contentText, classifyUserText, truncate } from './text.js';
import { redact } from './redact.js';

export const PARSER_VERSION = 4;

// Record types written by Claude Code that carry nothing Tacit needs.
// They start with `{"type":"...` so they can be skipped without JSON.parse.
const SKIP_PREFIXES = [
  'file-history-snapshot',
  'file-history-delta',
  'atis-latch',
  'api-request',
  'api-request-blob',
  'api-request-shape',
  'session-owner',
  'frame-link',
  'artifact-comment-monitor',
  'artifact-autoreact-ledger',
  'queue-operation',
  'last-prompt',
  'mode',
  'tools-used',
];
const SKIP_SET = new Set(SKIP_PREFIXES);
const TYPE_FIRST = '{"type":"';

const MAX_PROMPT_CHARS = 4000;
const MAX_CONTEXT_POINTS = 240;
const FILE_TOOLS_EDIT = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/**
 * Stream one transcript and return a compact, JSON-serialisable summary.
 * Never throws on malformed content: bad lines are counted and skipped.
 */
export async function parseSessionFile(meta) {
  const { file, projectKey = null, parentSessionId = null } = meta;
  const s = emptySummary(file, projectKey, parentSessionId);
  const seenMessages = new Set();
  const toolUses = new Map(); // tool_use id -> { name, target }
  const toolResultSizes = [];

  const stream = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20 });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (let line of rl) {
    if (!line) continue;
    if (s.lines === 0 && line.charCodeAt(0) === 0xfeff) line = line.slice(1);
    s.lines++;
    if (line.startsWith(TYPE_FIRST)) {
      const end = line.indexOf('"', TYPE_FIRST.length);
      const t = line.slice(TYPE_FIRST.length, end);
      if (SKIP_SET.has(t)) continue;
    }
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      s.badLines++;
      continue;
    }
    if (!o || typeof o !== 'object') continue;
    try {
      handleRecord(o, s, seenMessages, toolUses, toolResultSizes);
    } catch {
      s.badLines++;
    }
  }

  finalize(s, toolUses, toolResultSizes);
  return s;
}

function emptySummary(file, projectKey, parentSessionId) {
  return {
    v: PARSER_VERSION,
    file,
    projectKey,
    isSubagent: Boolean(parentSessionId),
    parentSessionId,
    agentId: parentSessionId ? path.basename(file, '.jsonl').replace(/^agent-/, '') : null,
    sessionId: parentSessionId ? null : path.basename(file, '.jsonl'),
    cwd: null,
    gitBranch: null,
    version: null,
    entrypoint: null,
    title: null,
    customTitle: null,
    firstTs: null,
    lastTs: null,
    lines: 0,
    badLines: 0,
    prompts: [],
    commands: {},
    interrupts: 0,
    images: 0,
    assistantMessages: 0,
    usage: {}, // model -> { in, out, cw5m, cw1h, cr, n }
    context: [], // [ts, contextTokens, outputTokens]
    tools: {},
    toolErrors: 0,
    bash: {},
    reads: {},
    edits: {},
    agents: {},
    skills: {},
    mcp: {},
    heavyResults: [],
    compactions: [],
    apiErrors: 0,
    hookRuns: 0,
    cost: null,
  };
}

function stamp(s, ts) {
  if (!ts || typeof ts !== 'string') return;
  if (!s.firstTs || ts < s.firstTs) s.firstTs = ts;
  if (!s.lastTs || ts > s.lastTs) s.lastTs = ts;
}

function handleRecord(o, s, seenMessages, toolUses, toolResultSizes) {
  const type = o.type;
  if (o.sessionId && !s.sessionId) s.sessionId = o.sessionId;
  if (o.cwd && !s.cwd) s.cwd = o.cwd;
  if (o.gitBranch && !s.gitBranch && o.gitBranch !== 'HEAD') s.gitBranch = o.gitBranch;
  if (o.version) s.version = o.version;
  if (o.entrypoint && !s.entrypoint) s.entrypoint = o.entrypoint;

  switch (type) {
    case 'user':
      stamp(s, o.timestamp);
      handleUser(o, s, toolResultSizes);
      return;
    case 'assistant':
      stamp(s, o.timestamp);
      handleAssistant(o, s, seenMessages, toolUses);
      return;
    case 'system':
      stamp(s, o.timestamp);
      if (o.subtype === 'compact_boundary') {
        const meta = o.compactMetadata || {};
        s.compactions.push({ ts: o.timestamp || null, preTokens: num(meta.preTokens), trigger: meta.trigger || null });
      } else if (o.subtype === 'api_error') s.apiErrors++;
      else if (o.subtype === 'stop_hook_summary') s.hookRuns += num(o.hookCount) || 1;
      return;
    case 'summary':
      if (o.summary && !s.title) s.title = truncate(String(o.summary), 140);
      return;
    case 'ai-title':
      if (o.aiTitle) s.title = truncate(String(o.aiTitle), 140);
      return;
    case 'custom-title':
      if (o.customTitle) s.customTitle = truncate(String(o.customTitle), 140);
      return;
    case 'cost-state':
      s.cost = {
        usd: num(o.totalCostUSD),
        linesAdded: num(o.totalLinesAdded),
        linesRemoved: num(o.totalLinesRemoved),
        durationMs: num(o.totalDuration),
        apiMs: num(o.totalAPIDuration),
      };
      return;
    default:
      return;
  }
}

function handleUser(o, s, toolResultSizes) {
  const content = o.message && o.message.content;
  if (Array.isArray(content)) {
    let hasToolResult = false;
    for (const block of content) {
      if (!block) continue;
      if (block.type === 'tool_result') {
        hasToolResult = true;
        const size = sizeOf(block.content);
        toolResultSizes.push({ id: block.tool_use_id, chars: size, ts: o.timestamp || null });
        if (block.is_error) s.toolErrors++;
      } else if (block.type === 'image') {
        s.images++;
      }
    }
    if (hasToolResult) return;
  }
  if (o.toolUseResult !== undefined && o.sourceToolUseID) return;
  if (o.isMeta || o.isCompactSummary || o.isVisibleInTranscriptOnly) return;
  // Subagent transcripts: the "user" is the parent agent, not a person.
  if (s.isSubagent) return;
  const origin = o.origin && o.origin.kind;
  if (origin && origin !== 'human') return;
  if (!origin && o.userType && o.userType !== 'external') return;

  const raw = contentText(content);
  const cls = classifyUserText(raw);
  if (cls.kind === 'interrupt') {
    s.interrupts++;
    return;
  }
  if (cls.kind === 'command') {
    s.commands[cls.command] = (s.commands[cls.command] || 0) + 1;
    return;
  }
  if (cls.kind !== 'prompt') return;
  s.prompts.push({
    ts: o.timestamp || null,
    text: redact(truncate(cls.text, MAX_PROMPT_CHARS)),
    mode: o.permissionMode || null,
  });
}

function handleAssistant(o, s, seenMessages, toolUses) {
  const msg = o.message || {};
  const id = msg.id || o.requestId || o.uuid;
  const first = !seenMessages.has(id);
  if (first) seenMessages.add(id);

  if (first && msg.usage && msg.model && msg.model !== '<synthetic>') {
    const u = msg.usage;
    const model = msg.model;
    const bucket = (s.usage[model] ||= { in: 0, out: 0, cw5m: 0, cw1h: 0, cr: 0, n: 0 });
    const input = num(u.input_tokens);
    const output = num(u.output_tokens);
    const cr = num(u.cache_read_input_tokens);
    const cw = num(u.cache_creation_input_tokens);
    const cw1h = u.cache_creation ? num(u.cache_creation.ephemeral_1h_input_tokens) : 0;
    const cw5m = u.cache_creation ? num(u.cache_creation.ephemeral_5m_input_tokens) : cw;
    bucket.in += input;
    bucket.out += output;
    bucket.cr += cr;
    bucket.cw1h += cw1h;
    bucket.cw5m += cw1h + cw5m > 0 ? cw5m : cw;
    bucket.n++;
    s.assistantMessages++;
    if (!s.isSubagent) s.context.push([o.timestamp || null, input + cr + cw, output]);
  }
  if (o.isApiErrorMessage) s.apiErrors++;

  const content = Array.isArray(msg.content) ? msg.content : [];
  for (const block of content) {
    if (!block || block.type !== 'tool_use') continue;
    const name = String(block.name || 'unknown');
    if (toolUses.has(block.id)) continue;
    const input = block.input || {};
    const target = toolTarget(name, input);
    toolUses.set(block.id, { name, target });
    s.tools[name] = (s.tools[name] || 0) + 1;

    if (name === 'Read' && input.file_path) bump(s.reads, String(input.file_path));
    else if (FILE_TOOLS_EDIT.has(name) && (input.file_path || input.notebook_path)) bump(s.edits, String(input.file_path || input.notebook_path));
    else if (name === 'Bash' && typeof input.command === 'string') bump(s.bash, commandSignature(input.command));
    else if ((name === 'Task' || name === 'Agent') && input.subagent_type) bump(s.agents, String(input.subagent_type));
    else if (name === 'Skill' && (input.skill || input.command)) bump(s.skills, String(input.skill || input.command));
    if (name.startsWith('mcp__')) bump(s.mcp, name.split('__')[1] || 'mcp');
  }
}

function toolTarget(name, input) {
  if (input.file_path) return String(input.file_path);
  if (input.notebook_path) return String(input.notebook_path);
  if (input.command) return truncate(String(input.command).replace(/\s+/g, ' '), 120);
  if (input.pattern) return truncate(String(input.pattern), 120);
  if (input.url) return truncate(String(input.url), 120);
  if (input.query) return truncate(String(input.query), 120);
  if (input.description) return truncate(String(input.description), 120);
  return null;
}

/** "npm run test -- --watch" -> "npm run test"; "git commit -m ..." -> "git commit". */
export function commandSignature(cmd) {
  const first = cmd.trim().split(/\s*(?:&&|\|\||;|\|)\s*/)[0] || '';
  const tokens = first.split(/\s+/).filter((t) => t && !/^[A-Z_]+=/.test(t));
  if (!tokens.length) return 'unknown';
  const head = path.basename(tokens[0].replace(/^["']|["']$/g, '')).replace(/\.(exe|cmd|bat)$/i, '');
  const two = ['npm', 'pnpm', 'yarn', 'bun', 'npx', 'git', 'docker', 'cargo', 'go', 'python', 'python3', 'py', 'pip', 'uv', 'poetry', 'dotnet', 'gh', 'make', 'kubectl', 'php', 'composer', 'node'];
  if ((head === 'python' || head === 'python3' || head === 'py') && tokens[1] === '-m' && tokens[2]) {
    return `${head} -m ${tokens[2]}`;
  }
  if (two.includes(head) && tokens[1] && !tokens[1].startsWith('-')) {
    if ((head === 'npm' || head === 'pnpm' || head === 'yarn' || head === 'bun') && tokens[1] === 'run' && tokens[2]) {
      return `${head} run ${tokens[2]}`;
    }
    return `${head} ${tokens[1].replace(/^["']|["']$/g, '')}`.slice(0, 60);
  }
  return head.slice(0, 40);
}

function finalize(s, toolUses, toolResultSizes) {
  // Heaviest tool outputs: these are what fill the context window.
  const heavy = [];
  for (const r of toolResultSizes) {
    const use = toolUses.get(r.id);
    heavy.push({ tool: use ? use.name : 'tool', target: use ? use.target : null, tokens: Math.round(r.chars / 4), ts: r.ts });
  }
  heavy.sort((a, b) => b.tokens - a.tokens);
  s.heavyResults = heavy.slice(0, 12);
  s.toolResultTokens = Math.round(toolResultSizes.reduce((a, r) => a + r.chars, 0) / 4);
  s.context = downsample(s.context, MAX_CONTEXT_POINTS);
  s.reads = topEntries(s.reads, 40);
  s.edits = topEntries(s.edits, 60);
  s.bash = topEntries(s.bash, 40);
}

function downsample(points, max) {
  if (points.length <= max) return points;
  const out = [];
  const step = points.length / max;
  for (let i = 0; i < max; i++) {
    const from = Math.floor(i * step);
    const to = Math.floor((i + 1) * step);
    let best = points[from];
    for (let j = from; j < to; j++) if (points[j][1] > best[1]) best = points[j];
    out.push(best);
  }
  out[out.length - 1] = points[points.length - 1];
  return out;
}

function topEntries(map, n) {
  const entries = Object.entries(map);
  if (entries.length <= n) return map;
  entries.sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(entries.slice(0, n));
}

function bump(map, key) {
  map[key] = (map[key] || 0) + 1;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function sizeOf(content) {
  if (content == null) return 0;
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) {
    let n = 0;
    for (const c of content) {
      if (!c) continue;
      if (typeof c.text === 'string') n += c.text.length;
      else if (c.type === 'image') n += 6000; // images cost ~1.5k tokens
      else n += JSON.stringify(c).length;
    }
    return n;
  }
  return JSON.stringify(content).length;
}

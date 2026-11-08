import { spawn, execFile } from 'node:child_process';
import { truncate } from './text.js';

/**
 * Optional "Refine with Claude". Two engines:
 *   - api: the official Anthropic SDK (@anthropic-ai/sdk, an optional dependency) with an API key
 *   - cli: Claude Code's own headless mode (`claude -p`), which works with a Claude subscription
 * Without either, Tacit still produces every draft from its built-in templates.
 */

export const DEFAULT_MODEL = 'claude-opus-5-5';
export const MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
];

const SYSTEM = `You turn a developer's repeated instructions to Claude Code into durable Claude Code configuration.

You receive: the kind of artifact, the evidence (what the developer kept saying, in their own words, and how often), and a first draft. Return an improved version of the same artifact through the submit_artifact tool.

Formats:
- rule: one Markdown list item for CLAUDE.md, starting with "- ". One or two sentences, imperative, specific and checkable. No hedges ("try to", "if possible").
- skill: a SKILL.md file. YAML frontmatter with "name" (lowercase, hyphens, max 64 chars) and "description". The description alone decides whether Claude loads the skill, so it must say what the skill does and when to use it, using the developer's own vocabulary. Body: short sections "When to use", "Steps" (numbered), "Done means".
- hook: JSON for .claude/settings.json of the form {"hooks": {"<Event>": [{"matcher": "...", "hooks": [{"type": "command", "command": "..."}]}]}}. Valid events include PreToolUse, PostToolUse and Stop. A command that exits with code 2 blocks the action and shows its stderr to Claude. Keep the command portable (POSIX shell). Omit "matcher" for Stop.
- subagent: a Markdown file with YAML frontmatter "name", "description" (when to delegate, written so Claude can decide proactively), "tools" (the smallest set that does the job; read-only tools for review or research). Body: the agent's job, how to work, a fixed reply format, and an instruction to report obstacles instead of guessing.
- command: a Markdown slash command with frontmatter "description" and a body prompt that uses $ARGUMENTS for the per-run input.

Principles:
- Preserve the developer's intent exactly. Do not add requirements they never expressed.
- Do not invent project facts (paths, scripts, frameworks) that are not in the evidence or draft.
- Shorter is better when nothing is lost.
- Plain English, no emoji, no marketing tone.`;

const TOOL = {
  name: 'submit_artifact',
  description: 'Submit the finished artifact. Call this exactly once with the complete file content.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      content: { type: 'string', description: 'The complete artifact content, ready to save.' },
      rationale: { type: 'string', description: 'One or two sentences on what you changed and why.' },
    },
    required: ['content', 'rationale'],
  },
};

let sdkPromise = null;
async function loadSdk() {
  sdkPromise ||= import('@anthropic-ai/sdk').then((m) => m.default || m.Anthropic).catch(() => null);
  return sdkPromise;
}

let cliPromise = null;
export function findClaudeCli() {
  cliPromise ||= new Promise((resolve) => {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    execFile(cmd, ['claude'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const first = String(stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const pick = process.platform === 'win32' ? first.find((p) => /\.(cmd|exe)$/i.test(p)) || first[0] : first[0];
      resolve(pick || null);
    });
  });
  return cliPromise;
}

export async function engineStatus(settings = {}) {
  const [sdk, cli] = await Promise.all([loadSdk(), findClaudeCli()]);
  const hasKey = Boolean(settings.apiKey || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  return {
    api: { sdkInstalled: Boolean(sdk), keyAvailable: hasKey, ready: Boolean(sdk) && hasKey, keySource: settings.apiKey ? 'session' : hasKey ? 'environment' : null },
    cli: { ready: Boolean(cli), path: cli },
  };
}

function buildUserMessage(pattern, artifact) {
  const quotes = (pattern.variants && pattern.variants.length ? pattern.variants : [pattern.text])
    .slice(0, 8)
    .map((v) => `- "${truncate(v.replace(/\s+/g, ' '), 240)}"`)
    .join('\n');
  const brief = pattern.body ? `\nThe reused brief (pasted ${pattern.count} times):\n<brief>\n${truncate(pattern.body, 6000)}\n</brief>\n` : '';
  return `Artifact kind: ${artifact.kind}
Target file: ${artifact.path}
Scope: ${artifact.scope === 'global' ? 'personal, applies to every project' : 'this project only'}

Evidence: the developer said this ${pattern.count} times across ${pattern.sessions} sessions and ${pattern.projects.length} project(s).
Their own words:
${quotes}
${brief}
First draft:
<draft>
${artifact.content}
</draft>

Improve the draft and submit it with the submit_artifact tool.`;
}

export class RefineError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

export async function refine({ engine, model = DEFAULT_MODEL, apiKey, pattern, artifact, timeoutMs = 180000 }) {
  if (engine === 'cli') return refineWithCli({ pattern, artifact, timeoutMs });
  return refineWithApi({ model, apiKey, pattern, artifact });
}

async function refineWithApi({ model, apiKey, pattern, artifact }) {
  const Anthropic = await loadSdk();
  if (!Anthropic) throw new RefineError('The Anthropic SDK is not installed. Run "npm install" in the Tacit folder, or use the Claude Code engine.', 'sdk-missing');
  const client = new Anthropic(apiKey ? { apiKey } : {});
  const params = {
    model,
    max_tokens: 16000,
    output_config: { effort: 'medium' },
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    tools: [TOOL],
    tool_choice: { type: 'auto' },
    messages: [{ role: 'user', content: buildUserMessage(pattern, artifact) }],
  };

  let response;
  try {
    try {
      // Server-side fallback routes a refused request to another model automatically.
      response = await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
    } catch (err) {
      if (err instanceof Anthropic.BadRequestError && /fallback|beta/i.test(String(err.message))) {
        response = await client.messages.create(params);
      } else throw err;
    }
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new RefineError('Your API key was rejected. Check it in Settings.', 'auth');
    if (err instanceof Anthropic.PermissionDeniedError) throw new RefineError('This API key cannot use the selected model.', 'permission');
    if (err instanceof Anthropic.NotFoundError) throw new RefineError(`Model "${model}" was not found for this key.`, 'model');
    if (err instanceof Anthropic.RateLimitError) throw new RefineError('Rate limited by the API. Wait a moment and try again.', 'rate');
    if (err instanceof Anthropic.BadRequestError) throw new RefineError(`The API rejected the request: ${err.message}`, 'bad-request');
    if (err instanceof Anthropic.APIConnectionError) throw new RefineError('Could not reach the Anthropic API. Check your connection.', 'network');
    if (err instanceof Anthropic.APIError) throw new RefineError(`API error ${err.status}: ${err.message}`, 'api');
    throw err;
  }

  if (response.stop_reason === 'refusal') throw new RefineError('Claude declined to rewrite this draft. The template draft is still available.', 'refusal');
  const block = (response.content || []).find((b) => b.type === 'tool_use' && b.name === TOOL.name);
  let content;
  let rationale = '';
  if (block && block.input && typeof block.input.content === 'string') {
    content = block.input.content;
    rationale = String(block.input.rationale || '');
  } else {
    const text = (response.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    content = extractArtifact(text);
  }
  if (!content || !content.trim()) throw new RefineError('Claude returned an empty draft. Try again.', 'empty');
  if (response.stop_reason === 'max_tokens') rationale = `${rationale} (The response hit the length limit; check the end of the draft.)`.trim();
  return { content: content.trim() + '\n', rationale, engine: 'api', model: response.model || model, usage: response.usage || null };
}

async function refineWithCli({ pattern, artifact, timeoutMs }) {
  const cli = await findClaudeCli();
  if (!cli) throw new RefineError('Claude Code was not found on your PATH. Install it, or use an API key instead.', 'cli-missing');
  const prompt = `${SYSTEM}\n\n${buildUserMessage(pattern, artifact).replace(
    'Improve the draft and submit it with the submit_artifact tool.',
    'Improve the draft. Reply with only the finished artifact between <artifact> and </artifact> tags, then one line starting with "Rationale:".',
  )}`;
  const out = await new Promise((resolve, reject) => {
    const child = spawn(cli, ['-p', '--output-format', 'json'], {
      shell: process.platform === 'win32',
      windowsHide: true,
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new RefineError('Claude Code took too long to answer.', 'timeout'));
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new RefineError(`Could not start Claude Code: ${e.message}`, 'cli'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !stdout) reject(new RefineError(`Claude Code exited with code ${code}. ${truncate(stderr.trim(), 300)}`, 'cli'));
      else resolve(stdout);
    });
    child.stdin.end(prompt);
  });
  let text = out;
  try {
    const parsed = JSON.parse(out);
    if (parsed.is_error) throw new RefineError(`Claude Code reported an error: ${truncate(String(parsed.result || ''), 300)}`, 'cli');
    text = String(parsed.result || '');
  } catch (e) {
    if (e instanceof RefineError) throw e;
  }
  const content = extractArtifact(text);
  if (!content) throw new RefineError('Claude Code did not return a draft. Try again.', 'empty');
  const rationale = (/Rationale:\s*(.+)/i.exec(text) || [])[1] || '';
  return { content: content.trim() + '\n', rationale: rationale.trim(), engine: 'cli', model: 'claude-code' };
}

export function extractArtifact(text) {
  if (!text) return '';
  const tagged = /<artifact>\s*([\s\S]*?)\s*<\/artifact>/i.exec(text);
  if (tagged) return stripFence(tagged[1]);
  const fenced = /```[a-z]*\n([\s\S]*?)```/i.exec(text);
  if (fenced) return fenced[1];
  return text.trim();
}

function stripFence(s) {
  const m = /^```[a-z]*\n([\s\S]*?)\n?```$/i.exec(s.trim());
  return m ? m[1] : s;
}

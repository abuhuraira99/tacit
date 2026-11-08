#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 18 || (major === 18 && minor < 17)) {
  console.error(`Tacit needs Node.js 18.17 or newer. You have ${process.versions.node}. Get it from https://nodejs.org`);
  process.exit(1);
}

const HELP = `
Tacit ${pkg.version}
Find what you keep repeating to Claude Code, and turn it into CLAUDE.md rules,
Skills, hooks and subagents. Everything runs on your machine.

Usage
  tacit                 open the app in your browser
  tacit scan            print a summary of your history
  tacit habits          list the instructions you repeat most
  tacit report [-o f]   write a Markdown retrospective (stdout or a file)
  tacit doctor          check that everything Tacit needs is in place

Options
  --dir <path>          Claude Code folder or its projects folder (default ~/.claude)
  --port <n>            port for the app (default 4317, next free one if taken)
  --demo                use generated sample data instead of your history
  --no-open             do not open the browser
  --no-cache            re-read every transcript instead of using the cache
  --json                machine-readable output for scan / habits
  -v, --version         print the version
  -h, --help            show this help
`;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') out.dir = argv[++i];
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '-o' || a === '--out') out.out = argv[++i];
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--demo') out.demo = true;
    else if (a === '--no-open') out.open = false;
    else if (a === '--no-cache') out.cache = false;
    else if (a === '--json') out.json = true;
    else if (a === '-v' || a === '--version') out.version = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else if (a.startsWith('--')) {
      console.error(`Unknown option ${a}. Run "tacit --help".`);
      process.exit(2);
    } else out._.push(a);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.version) {
  console.log(pkg.version);
  process.exit(0);
}
if (args.help) {
  console.log(HELP);
  process.exit(0);
}

const command = args._[0] || 'open';

async function prepareDemo() {
  const { generateDemo } = await import('../src/demo/generate.js');
  const { tacitHome } = await import('../src/core/paths.js');
  const root = path.join(tacitHome(), 'demo');
  const out = generateDemo(root);
  process.env.CLAUDE_CONFIG_DIR = out.claudeHome;
  return { dir: out.projectsDir, cacheDir: path.join(root, 'cache') };
}

async function makeApp() {
  const { TacitApp } = await import('../src/core/app.js');
  let dir = args.dir;
  let cacheDir;
  if (args.demo) ({ dir, cacheDir } = await prepareDemo());
  return new TacitApp({ dir, cache: args.cache, cacheDir, demo: args.demo });
}

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const dim = (s) => (color ? `\x1b[2m${s}\x1b[22m` : s);
const bold = (s) => (color ? `\x1b[1m${s}\x1b[22m` : s);
const yellow = (s) => (color ? `\x1b[33m${s}\x1b[39m` : s);
const fmt = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)));

async function run() {
  if (command === 'open' || command === 'serve' || command === 'ui') return openUi();
  if (command === 'scan') return scanCmd();
  if (command === 'habits' || command === 'patterns') return habitsCmd();
  if (command === 'report') return reportCmd();
  if (command === 'doctor') return doctorCmd();
  console.error(`Unknown command "${command}". Run "tacit --help".`);
  process.exit(2);
}

async function openUi() {
  const { createServer } = await import('../src/server/server.js');
  const app = await makeApp();
  const srv = createServer(app, { port: Number.isFinite(args.port) ? args.port : 4317 });
  const { url } = await srv.listen();
  console.log(`\n  ${bold('Tacit')} ${dim(pkg.version)}  ${url}`);
  console.log(dim(`  Reading ${app.settings.projectsDir}`));
  console.log(dim('  Your history stays on this machine. Press Ctrl+C to stop.\n'));
  app.load().then((state) => {
    if (state.status === 'ready') {
      const c = app.status().counts || {};
      console.log(dim(`  Read ${state.stats.files || 0} transcripts in ${state.stats.ms || 0} ms: ${c.sessions || 0} sessions, ${c.patterns || 0} repeated instructions.\n`));
    } else if (state.status === 'error') console.error(`  Could not read your history: ${state.error}`);
  });
  if (args.open !== false && !process.env.CI) openBrowser(url);
  const stop = async () => {
    await srv.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function scanCmd() {
  const app = await makeApp();
  const state = await app.load();
  if (state.status === 'error') throw new Error(state.error);
  const o = app.overview();
  if (args.json) return console.log(JSON.stringify({ totals: o.totals, range: o.range, stats: state.stats }, null, 2));
  const t = o.totals;
  console.log(`\n${bold('Your Claude Code history')} ${dim(app.settings.projectsDir)}\n`);
  const rows = [
    ['Sessions', `${t.sessions} in ${t.projects} projects`],
    ['Your prompts', t.prompts],
    ['Active time', `${t.activeHours.toFixed(1)} h`],
    ['Tokens', `${fmt(t.tokens)} (${fmt(t.outputTokens)} written by Claude)`],
    ['API-equivalent cost', `$${t.costUSD.toFixed(2)}`],
    ['Cache hit rate', `${(t.cacheHitRate * 100).toFixed(1)}%`],
    ['Repeated instructions', o.patternCount],
  ];
  for (const [k, v] of rows) console.log(`  ${k.padEnd(24)}${v}`);
  console.log(dim(`\n  ${state.stats.files} transcripts, ${state.stats.cached} from cache, ${state.stats.ms} ms\n`));
}

async function habitsCmd() {
  const app = await makeApp();
  const state = await app.load();
  if (state.status === 'error') throw new Error(state.error);
  const list = app.listPatterns({}).slice(0, args.limit || 15);
  if (args.json) return console.log(JSON.stringify(list, null, 2));
  if (!list.length) return console.log('\nNo repeated instructions yet. Keep using Claude Code and check back.\n');
  console.log(`\n${bold('What you keep telling Claude')}\n`);
  list.forEach((p, i) => {
    console.log(`  ${String(i + 1).padStart(2)}. ${bold(p.title)}`);
    console.log(`      ${yellow('“' + p.text + '”')}`);
    console.log(dim(`      ${p.count}x in ${p.sessions} sessions, ${p.projects.length} project(s). Suggested: ${p.suggestion}${p.covered ? ' (a rule exists but you still repeat it)' : ''}\n`));
  });
  console.log(dim('  Run "tacit" to turn any of these into a rule, skill, hook or subagent.\n'));
}

async function reportCmd() {
  const app = await makeApp();
  const state = await app.load();
  if (state.status === 'error') throw new Error(state.error);
  const md = app.report();
  if (args.out) {
    fs.writeFileSync(args.out, md);
    console.log(`Wrote ${args.out}`);
  } else process.stdout.write(md);
}

async function doctorCmd() {
  const { resolveProjectsDir, claudeHome, tacitHome, listSessionFiles, isDir } = await import('../src/core/paths.js');
  const { engineStatus } = await import('../src/core/ai.js');
  const projectsDir = resolveProjectsDir(args.dir);
  const files = isDir(projectsDir) ? listSessionFiles(projectsDir) : [];
  const engines = await engineStatus({});
  let writable = true;
  try {
    fs.mkdirSync(tacitHome(), { recursive: true });
    fs.accessSync(tacitHome(), fs.constants.W_OK);
  } catch {
    writable = false;
  }
  const ok = (b) => (b ? '  ok  ' : '  --  ');
  console.log(`\n${bold('Tacit doctor')}\n`);
  console.log(`${ok(true)}Node.js ${process.versions.node} on ${os.platform()} ${os.arch()}`);
  console.log(`${ok(isDir(claudeHome()))}Claude Code folder: ${claudeHome()}`);
  console.log(`${ok(files.length > 0)}Transcripts found: ${files.length} in ${projectsDir}`);
  console.log(`${ok(writable)}Cache folder writable: ${tacitHome()}`);
  console.log(`${ok(engines.api.ready)}Refine with the Claude API: ${engines.api.sdkInstalled ? (engines.api.keyAvailable ? 'ready' : 'SDK installed, no API key (optional)') : 'SDK not installed (optional)'}`);
  console.log(`${ok(engines.cli.ready)}Refine with Claude Code: ${engines.cli.ready ? engines.cli.path : 'claude not on PATH (optional)'}`);
  if (!files.length) console.log(dim('\n  No history found. Use Claude Code for a while, pass --dir, or try "tacit --demo".'));
  console.log('');
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const argv = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url];
  try {
    const child = spawn(cmd, argv, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* no browser available: the URL is printed above */
  }
}

run().catch((err) => {
  console.error(`\nTacit: ${err.message || err}\n`);
  process.exit(1);
});

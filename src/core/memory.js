import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { claudeHome, tacitHome, ensureDir, pathKey, isDir } from './paths.js';
import { assertInside, backupFile, atomicWrite, appendRule, recordChange, readHistory, SafeWriteError } from './apply.js';

/**
 * Startup memory: the CLAUDE.md files Claude Code loads at the start of every new chat,
 * before the first message. Read them, switch them off for new chats, pause single rules,
 * edit them, and review or undo the changes Tacit made.
 */

const DISABLED_SUFFIX = '.disabled';
const MEMORY_NAMES = ['CLAUDE.md', 'CLAUDE.local.md'];

/** Every memory file that can be loaded at startup, grouped by scope. */
export function listStartupMemory(index) {
  const scopes = [];
  scopes.push(scopeFor('global', 'Personal (every project)', claudeHome(), [path.join(claudeHome(), 'CLAUDE.md')], null));
  for (const proj of index.projects) {
    if (!proj.cwd || !isDir(proj.cwd)) continue;
    const candidates = [path.join(proj.cwd, 'CLAUDE.md'), path.join(proj.cwd, '.claude', 'CLAUDE.md'), path.join(proj.cwd, 'CLAUDE.local.md')];
    const scope = scopeFor(proj.id, proj.label, proj.cwd, candidates, proj.sessions);
    if (scope.files.some((f) => f.exists || f.disabled)) scopes.push(scope);
  }
  return scopes;
}

function scopeFor(id, label, dir, candidates, sessions) {
  const files = candidates.map(fileStatus).filter((f, i) => i === 0 || f.exists || f.disabled);
  const loaded = files.filter((f) => f.exists);
  return {
    id,
    label,
    dir,
    sessions,
    files,
    activeTokens: loaded.reduce((a, f) => a + f.tokens + f.importTokens, 0),
  };
}

export function fileStatus(file) {
  const disabledPath = file + DISABLED_SUFFIX;
  const exists = isFile(file);
  const disabled = !exists && isFile(disabledPath);
  const real = exists ? file : disabled ? disabledPath : null;
  let tokens = 0;
  let lines = 0;
  let mtime = null;
  let importTokens = 0;
  if (real) {
    const text = fs.readFileSync(real, 'utf8');
    tokens = estimateTokens(text);
    lines = text.split(/\r?\n/).length;
    mtime = new Date(fs.statSync(real).mtimeMs).toISOString();
    importTokens = resolveImports(text, path.dirname(file)).reduce((a, i) => a + (i.tokens || 0), 0);
  }
  return { path: file, exists, disabled, tokens, lines, mtime, importTokens, parked: parkedFor(file).length };
}

/** Everything about one memory file: content, rules, imports, paused rules and change history. */
export function readStartupFile(file, roots) {
  assertMemoryPath(file, roots);
  const status = fileStatus(file);
  const real = status.exists ? file : status.disabled ? file + DISABLED_SUFFIX : null;
  const content = real ? fs.readFileSync(real, 'utf8') : '';
  const history = readHistory().filter((h) => pathKey(h.path) === pathKey(file) || pathKey(h.path) === pathKey(file + DISABLED_SUFFIX));
  const addedByTacit = new Set(history.filter((h) => h.text).map((h) => normalizeRule(h.text)));
  return {
    ...status,
    content,
    rules: extractRules(content).map((r) => ({ ...r, addedByTacit: addedByTacit.has(normalizeRule(r.text)) })),
    imports: resolveImports(content, path.dirname(file)),
    parkedRules: parkedFor(file),
    history: history.slice(0, 50),
    backups: listBackups(file),
  };
}

/** Rules = list items and imperative lines, with their section and line number. */
export function extractRules(content) {
  const rules = [];
  let section = null;
  let inFence = false;
  content.split(/\r?\n/).forEach((raw, i) => {
    if (/^\s*```/.test(raw)) inFence = !inFence;
    if (inFence) return;
    const heading = /^#{1,6}\s+(.*\S)\s*$/.exec(raw);
    if (heading) {
      section = heading[1];
      return;
    }
    const m = /^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/.exec(raw);
    if (m) rules.push({ line: i + 1, text: m[1], raw, section });
  });
  return rules;
}

/** `@path/to/file` lines pull another file into the startup memory. */
export function resolveImports(content, baseDir) {
  const out = [];
  const seen = new Set();
  // Claude Code ignores @ references inside code, so Tacit does too.
  const plain = content.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  for (const m of plain.matchAll(/(?:^|\s)@((?:~|\.{1,2})?[\\/]?[\w.\-\\/~]+\.\w+)/gm)) {
    const ref = m[1];
    if (seen.has(ref)) continue;
    seen.add(ref);
    const resolved = ref.startsWith('~') ? path.join(os.homedir(), ref.slice(1)) : path.resolve(baseDir, ref);
    const exists = isFile(resolved);
    out.push({ ref, path: resolved, exists, tokens: exists ? estimateTokens(fs.readFileSync(resolved, 'utf8')) : 0 });
  }
  return out;
}

// ---------- switching a whole file off and on ----------

export function setFileEnabled(file, enabled, roots) {
  assertMemoryPath(file, roots);
  const off = file + DISABLED_SUFFIX;
  if (enabled) {
    if (isFile(file)) return { status: 'unchanged', reason: 'This file is already on.' };
    if (!isFile(off)) throw new SafeWriteError('There is no switched-off copy of this file to turn back on.');
    fs.renameSync(off, file);
    recordChange({ path: file, action: 'switched on for new chats' });
    return { status: 'enabled' };
  }
  if (!isFile(file)) return { status: 'unchanged', reason: 'This file is already off, or does not exist.' };
  if (isFile(off)) backupFile(off);
  fs.renameSync(file, off);
  recordChange({ path: file, action: 'switched off for new chats' });
  return { status: 'disabled' };
}

// ---------- pausing single rules ----------

function parkedStore() {
  return path.join(tacitHome(), 'parked-rules.json');
}

function readParked() {
  try {
    return JSON.parse(fs.readFileSync(parkedStore(), 'utf8')) || {};
  } catch {
    return {};
  }
}

function writeParked(data) {
  ensureDir(tacitHome());
  atomicWrite(parkedStore(), JSON.stringify(data, null, 2));
}

export function parkedFor(file) {
  return readParked()[pathKey(file)] || [];
}

/**
 * Take one rule out of the file. "pause" keeps it in Tacit so it can be switched back on;
 * "remove" deletes it (the file is still backed up first).
 */
export function takeOutRule(file, { line, text, mode = 'pause' }, roots) {
  assertMemoryPath(file, roots);
  if (!isFile(file)) throw new SafeWriteError('Switch the file on before changing single rules.');
  const content = fs.readFileSync(file, 'utf8');
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  let idx = Number(line) - 1;
  // The file may have changed since the page loaded: find the rule by its text if needed.
  if (!lines[idx] || !lines[idx].includes(text)) idx = lines.findIndex((l) => l.includes(text));
  if (idx < 0) throw new SafeWriteError('That rule is no longer in the file. Reload the page.');
  const rule = extractRules(content).find((r) => r.line === idx + 1) || { raw: lines[idx], text, section: null };
  const backup = backupFile(file);
  lines.splice(idx, 1);
  atomicWrite(file, lines.join(eol));
  if (mode === 'pause') {
    const data = readParked();
    const key = pathKey(file);
    data[key] = [...(data[key] || []), { text: rule.text, raw: rule.raw.trim(), section: rule.section, pausedAt: new Date().toISOString() }];
    writeParked(data);
  }
  recordChange({ path: file, action: mode === 'pause' ? 'paused a rule' : 'removed a rule', text: rule.raw.trim(), backup });
  return { status: mode === 'pause' ? 'paused' : 'removed', backup };
}

/** Put a paused rule back, under the section it came from. */
export function restoreParkedRule(file, text, roots) {
  assertMemoryPath(file, roots);
  if (!isFile(file)) throw new SafeWriteError('Switch the file on before restoring rules.');
  const data = readParked();
  const key = pathKey(file);
  const list = data[key] || [];
  const i = list.findIndex((p) => p.text === text);
  if (i < 0) throw new SafeWriteError('That paused rule was not found.');
  const item = list[i];
  const backup = backupFile(file);
  const res = appendRule(file, item.raw.startsWith('-') || /^\d+[.)]/.test(item.raw) ? item.raw : `- ${item.text}`, item.section || 'Working agreements');
  list.splice(i, 1);
  data[key] = list;
  writeParked(data);
  recordChange({ path: file, action: 'restored a paused rule', text: item.raw, backup });
  return { status: res.status === 'skipped' ? 'already-there' : 'restored', backup };
}

// ---------- editing ----------

export function saveStartupFile(file, content, roots) {
  assertMemoryPath(file, roots);
  if (typeof content !== 'string') throw new SafeWriteError('Nothing to save.');
  if (content.length > 400000) throw new SafeWriteError('That is too large for a memory file.');
  const target = isFile(file) ? file : isFile(file + DISABLED_SUFFIX) ? file + DISABLED_SUFFIX : file;
  const before = isFile(target) ? fs.readFileSync(target, 'utf8') : '';
  if (before === content) return { status: 'unchanged' };
  const backup = isFile(target) ? backupFile(target) : null;
  ensureDir(path.dirname(target));
  atomicWrite(target, content);
  recordChange({ path: file, action: before ? 'edited in Startup memory' : 'created in Startup memory', backup });
  return { status: 'saved', backup, diff: diffLines(before, content) };
}

// ---------- backups and restore ----------

export function backupName(file) {
  return file.replace(/^[A-Za-z]:/, (m) => m[0]).replace(/[\\/:]+/g, '__');
}

export function listBackups(file) {
  const dir = path.join(tacitHome(), 'backups');
  const names = new Set([backupName(file), backupName(file + DISABLED_SUFFIX)]);
  const out = [];
  let stamps = [];
  try {
    stamps = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const stamp of stamps) {
    for (const name of names) {
      const p = path.join(dir, stamp, name);
      if (isFile(p)) out.push({ id: `${stamp}/${name}`, ts: stampToIso(stamp), path: p });
    }
  }
  return out.sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 30);
}

/** What restoring a backup would change: the file now on the left, the backup on the right. */
export function compareBackup(file, backupId, roots) {
  assertMemoryPath(file, roots);
  const b = resolveBackup(file, backupId);
  const now = currentContent(file);
  return { backup: b, diff: diffLines(now, fs.readFileSync(b.path, 'utf8')) };
}

export function restoreBackup(file, backupId, roots) {
  assertMemoryPath(file, roots);
  const b = resolveBackup(file, backupId);
  const content = fs.readFileSync(b.path, 'utf8');
  const res = saveStartupFile(file, content, roots);
  recordChange({ path: file, action: `restored the version from ${b.ts.slice(0, 16).replace('T', ' ')}` });
  return res;
}

function resolveBackup(file, backupId) {
  const match = listBackups(file).find((b) => b.id === backupId);
  if (!match) throw new SafeWriteError('That backup was not found.');
  return match;
}

function currentContent(file) {
  if (isFile(file)) return fs.readFileSync(file, 'utf8');
  if (isFile(file + DISABLED_SUFFIX)) return fs.readFileSync(file + DISABLED_SUFFIX, 'utf8');
  return '';
}

// ---------- line diff ----------

/**
 * Line-level diff (longest common subsequence). Returns [{type:'same'|'add'|'del', text}].
 * Long unchanged stretches are collapsed so the result stays readable.
 */
export function diffLines(a, b, context = 2) {
  const A = a.split(/\r?\n/);
  const B = b.split(/\r?\n/);
  if (A.length * B.length > 4e6) return [{ type: 'del', text: `(${A.length} lines)` }, { type: 'add', text: `(${B.length} lines)` }];
  const n = A.length;
  const m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      out.push({ type: 'same', text: A[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ type: 'del', text: A[i++] });
    else out.push({ type: 'add', text: B[j++] });
  }
  while (i < n) out.push({ type: 'del', text: A[i++] });
  while (j < m) out.push({ type: 'add', text: B[j++] });
  // Collapse unchanged runs longer than 2*context+1.
  const keep = out.map((x) => x.type !== 'same');
  const show = out.map((_, k) => {
    for (let d = -context; d <= context; d++) if (keep[k + d]) return true;
    return false;
  });
  const result = [];
  let skipped = 0;
  out.forEach((x, k) => {
    if (show[k]) {
      if (skipped) result.push({ type: 'skip', text: `${skipped} unchanged line${skipped > 1 ? 's' : ''}` });
      skipped = 0;
      result.push(x);
    } else skipped++;
  });
  if (skipped) result.push({ type: 'skip', text: `${skipped} unchanged line${skipped > 1 ? 's' : ''}` });
  return result;
}

// ---------- helpers ----------

/** Only CLAUDE.md-family files inside allowed folders can be touched from this page. */
export function assertMemoryPath(file, roots) {
  const base = path.basename(String(file || ''));
  if (!MEMORY_NAMES.includes(base)) throw new SafeWriteError('Only CLAUDE.md and CLAUDE.local.md files can be managed here.');
  assertInside(path.resolve(file), roots);
}

export function estimateTokens(text) {
  return Math.ceil((text || '').length / 3.6);
}

function normalizeRule(t) {
  return String(t).replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim().toLowerCase();
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function stampToIso(stamp) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(stamp);
  return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z` : stamp;
}


/** Add one rule directly from the Startup memory page. */
export function addStartupRule(file, text, section, roots) {
  assertMemoryPath(file, roots);
  const rule = String(text || '').trim().replace(/\s+/g, ' ');
  if (!rule) throw new SafeWriteError('Write the rule first.');
  if (rule.length > 600) throw new SafeWriteError('Keep a rule under 600 characters. Longer instructions belong in a Skill.');
  if (!isFile(file) && isFile(file + DISABLED_SUFFIX)) throw new SafeWriteError('Switch the file on before adding rules.');
  const backup = isFile(file) ? backupFile(file) : null;
  const res = appendRule(file, rule, String(section || '').trim() || 'Working agreements');
  if (res.status === 'written') recordChange({ path: file, action: 'added a rule in Startup memory', text: rule.startsWith('-') ? rule : `- ${rule}`, backup });
  return { status: res.status === 'written' ? 'added' : 'skipped', reason: res.reason, match: res.match, backup };
}

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/** Root of the Claude Code config folder (honours CLAUDE_CONFIG_DIR like Claude Code does). */
export function claudeHome() {
  const env = process.env.CLAUDE_CONFIG_DIR;
  return env ? path.resolve(env) : path.join(os.homedir(), '.claude');
}

/** Where Tacit keeps its own cache and backups. */
export function tacitHome() {
  const env = process.env.TACIT_HOME;
  return env ? path.resolve(env) : path.join(os.homedir(), '.tacit');
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Resolve the folder that holds session transcripts.
 * Accepts either the Claude home (containing `projects/`) or the `projects` folder itself.
 */
export function resolveProjectsDir(input) {
  const base = input ? path.resolve(input) : claudeHome();
  const nested = path.join(base, 'projects');
  if (isDir(nested)) return nested;
  if (path.basename(base) === 'projects' && isDir(base)) return base;
  if (isDir(base) && hasJsonlBelow(base)) return base;
  return nested;
}

export function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function hasJsonlBelow(dir) {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) return true;
      if (entry.isDirectory()) {
        const sub = path.join(dir, entry.name);
        for (const e of fs.readdirSync(sub, { withFileTypes: true })) {
          if (e.isFile() && e.name.endsWith('.jsonl')) return true;
        }
      }
    }
  } catch {
    /* unreadable folder: treat as empty */
  }
  return false;
}

/**
 * List every transcript under the projects folder.
 * Layout: projects/<project-key>/<session>.jsonl and
 *         projects/<project-key>/<session>/subagents/agent-*.jsonl
 */
export function listSessionFiles(projectsDir) {
  const out = [];
  if (!isDir(projectsDir)) return out;
  for (const proj of safeReaddir(projectsDir)) {
    if (!proj.isDirectory()) continue;
    const projDir = path.join(projectsDir, proj.name);
    for (const entry of safeReaddir(projDir)) {
      const full = path.join(projDir, entry.name);
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        pushFile(out, full, proj.name, null);
      } else if (entry.isDirectory()) {
        const subDir = path.join(full, 'subagents');
        for (const sub of safeReaddir(subDir)) {
          if (sub.isFile() && sub.name.endsWith('.jsonl')) {
            pushFile(out, path.join(subDir, sub.name), proj.name, entry.name);
          }
        }
      }
    }
  }
  return out;
}

function pushFile(out, file, projectKey, parentSessionId) {
  try {
    const st = fs.statSync(file);
    if (st.size === 0) return;
    out.push({ file, size: st.size, mtimeMs: Math.round(st.mtimeMs), projectKey, parentSessionId });
  } catch {
    /* file vanished between readdir and stat */
  }
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Normalise a filesystem path for use as a map key (case-insensitive on Windows/macOS defaults). */
export function pathKey(p) {
  if (!p) return '';
  let s = path.resolve(p).replace(/[\\/]+$/, '');
  if (process.platform === 'win32' || process.platform === 'darwin') s = s.toLowerCase();
  return s;
}

/** A short human label for a project folder. */
export function projectLabel(cwd, fallbackKey) {
  if (cwd) {
    const base = path.basename(cwd.replace(/[\\/]+$/, ''));
    if (base) return base;
  }
  return (fallbackKey || 'unknown').replace(/^[a-zA-Z]--/, '').split('-').slice(-3).join(' ');
}

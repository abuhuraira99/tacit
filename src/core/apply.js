import fs from 'node:fs';
import path from 'node:path';
import { tacitHome, ensureDir, pathKey } from './paths.js';
import { trigrams, jaccard } from './text.js';

/**
 * Write an artifact into a project or ~/.claude, safely:
 *  - only inside an allowed root (a project folder seen in your history, or ~/.claude)
 *  - every existing file is copied to ~/.tacit/backups/<timestamp>/ first
 *  - CLAUDE.md rules are appended under a heading and skipped if a near-duplicate exists
 *  - settings.json hooks are merged, never overwritten; invalid JSON aborts the write
 *  - new files are never overwritten unless `overwrite` is set
 */
export function applyArtifact(artifact, { allowedRoots, overwrite = false, content } = {}) {
  const target = path.resolve(artifact.path);
  assertInside(target, allowedRoots);
  const body = content != null ? String(content) : artifact.content;
  const existed = fs.existsSync(target);
  const backup = existed ? backupFile(target) : null;

  let result;
  if (artifact.mode === 'append-rule') result = appendRule(target, body, artifact.section || 'Working agreements');
  else if (artifact.mode === 'merge-json') result = mergeJson(target, body);
  else result = createFile(target, body, overwrite);

  if (result.status === 'written') {
    recordChange({ path: target, action: result.action, kind: artifact.kind || null, text: artifact.mode === 'append-rule' ? body.trim() : null, backup });
  }
  return { ...result, path: target, backup, existed };
}

// ---------- change history ----------

function historyFile() {
  return path.join(tacitHome(), 'history.json');
}

export function readHistory() {
  try {
    const list = JSON.parse(fs.readFileSync(historyFile(), 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** Remember every write Tacit makes, so changes can be reviewed and undone later. */
export function recordChange(entry) {
  try {
    const list = readHistory();
    list.unshift({ ts: new Date().toISOString(), ...entry });
    ensureDir(tacitHome());
    atomicWrite(historyFile(), JSON.stringify(list.slice(0, 500), null, 2));
  } catch {
    /* history is a convenience; never fail a write because of it */
  }
}

export function assertInside(target, roots = []) {
  const t = pathKey(target);
  const ok = roots.some((r) => {
    const root = pathKey(r);
    return root && (t === root || t.startsWith(root + path.sep) || t.startsWith(root + '/'));
  });
  if (!ok) throw new SafeWriteError(`Refusing to write outside your projects and ~/.claude: ${target}`);
}

export class SafeWriteError extends Error {}

export function backupFile(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = ensureDir(path.join(tacitHome(), 'backups', stamp));
  const name = file.replace(/^[A-Za-z]:/, (m) => m[0]).replace(/[\\/:]+/g, '__');
  const dest = path.join(dir, name);
  fs.copyFileSync(file, dest);
  return dest;
}

export function appendRule(file, ruleLine, section) {
  const line = ruleLine.trim().startsWith('-') ? ruleLine.trim() : `- ${ruleLine.trim()}`;
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    /* new file */
  }
  // Skip if the same rule (or one very close to it) is already there.
  const g = trigrams(line);
  const dup = text
    .split(/\r?\n/)
    .filter((l) => /^\s*(?:[-*]|\d+\.)\s+/.test(l))
    .find((l) => jaccard(trigrams(l), g) >= 0.6);
  if (dup) return { status: 'skipped', reason: 'A matching rule is already in this file.', match: dup.trim() };

  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const headingRe = new RegExp(`^#{1,3}\\s+${escapeRe(section)}\\s*$`, 'm');
  let next;
  const m = headingRe.exec(text);
  if (m) {
    // Append at the end of the section (just before the next heading, or at end of file).
    const after = m.index + m[0].length;
    const nextHeading = text.slice(after).search(/\r?\n#{1,6}\s/);
    const blockEnd = nextHeading === -1 ? text.length : after + nextHeading;
    const sectionEmpty = text.slice(after, blockEnd).trim() === '';
    const head = text.slice(0, blockEnd).replace(/\s+$/, '');
    const tail = text.slice(blockEnd).replace(/^\s+/, '');
    next = head + eol + (sectionEmpty ? eol : '') + line + eol + (tail ? eol + tail : '');
    if (tail && !next.endsWith(eol)) next += eol;
  } else {
    const prefix = text.trim() ? text.replace(/\s*$/, '') + eol + eol : '# CLAUDE.md' + eol + eol;
    next = `${prefix}## ${section}${eol}${eol}${line}${eol}`;
  }
  ensureDir(path.dirname(file));
  atomicWrite(file, next);
  return { status: 'written', action: m ? 'appended to existing section' : 'added section' };
}

function mergeJson(file, snippetText) {
  let snippet;
  try {
    snippet = JSON.parse(snippetText);
  } catch {
    throw new SafeWriteError('The hook draft is not valid JSON. Fix it before saving.');
  }
  let current = {};
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf8');
    if (raw.trim()) {
      try {
        current = JSON.parse(raw);
      } catch {
        throw new SafeWriteError(`${path.basename(file)} is not valid JSON, so Tacit will not touch it. Fix the file, then try again.`);
      }
    }
  }
  const merged = { ...current, hooks: { ...(current.hooks || {}) } };
  let added = 0;
  for (const [event, entries] of Object.entries(snippet.hooks || {})) {
    const list = Array.isArray(merged.hooks[event]) ? [...merged.hooks[event]] : [];
    for (const entry of entries) {
      const sig = JSON.stringify(entry);
      if (list.some((e) => JSON.stringify(e) === sig)) continue;
      list.push(entry);
      added++;
    }
    merged.hooks[event] = list;
  }
  if (!added) return { status: 'skipped', reason: 'This hook is already configured.' };
  ensureDir(path.dirname(file));
  atomicWrite(file, JSON.stringify(merged, null, 2) + '\n');
  return { status: 'written', action: `merged ${added} hook${added > 1 ? 's' : ''}` };
}

function createFile(file, body, overwrite) {
  if (fs.existsSync(file) && !overwrite) {
    return { status: 'exists', reason: 'A file with this name already exists. Rename it, or choose to replace it.' };
  }
  ensureDir(path.dirname(file));
  atomicWrite(file, body.endsWith('\n') ? body : body + '\n');
  return { status: 'written', action: 'created' };
}

export function atomicWrite(file, data) {
  const tmp = `${file}.tacit-${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, file);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

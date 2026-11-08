import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { listSessionFiles, tacitHome, ensureDir } from './paths.js';
import { parseSessionFile, PARSER_VERSION } from './parse-file.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CACHE_NAME = `index-v${PARSER_VERSION}.json`;

/**
 * Scan every transcript under `projectsDir`, reusing cached summaries for files
 * whose size and mtime have not changed.
 *
 * @param {object} opts
 * @param {string} opts.projectsDir
 * @param {boolean} [opts.useCache=true]
 * @param {string}  [opts.cacheDir]
 * @param {(p:{done:number,total:number,file?:string})=>void} [opts.onProgress]
 */
export async function scan({ projectsDir, useCache = true, cacheDir, onProgress = () => {} }) {
  const started = Date.now();
  const files = listSessionFiles(projectsDir);
  const cacheFile = path.join(cacheDir || path.join(tacitHome(), 'cache'), CACHE_NAME);
  const cache = useCache ? readCache(cacheFile, projectsDir) : {};

  const summaries = [];
  const todo = [];
  for (const f of files) {
    const hit = cache[f.file];
    if (hit && hit.size === f.size && hit.mtimeMs === f.mtimeMs && hit.summary && hit.summary.v === PARSER_VERSION) {
      summaries.push(hit.summary);
    } else {
      todo.push(f);
    }
  }

  let done = files.length - todo.length;
  onProgress({ done, total: files.length });

  const parsed = await parseAll(todo, (summary, f) => {
    done++;
    onProgress({ done, total: files.length, file: f.file });
  });
  const errors = [];
  for (const { file, summary, error } of parsed) {
    if (summary) summaries.push(summary);
    else errors.push({ file: file.file, error });
  }

  if (useCache) {
    const next = {};
    const byFile = new Map(summaries.map((s) => [s.file, s]));
    for (const f of files) {
      const s = byFile.get(f.file);
      if (s) next[f.file] = { size: f.size, mtimeMs: f.mtimeMs, summary: s };
    }
    writeCache(cacheFile, projectsDir, next);
  }

  return {
    summaries,
    errors,
    stats: {
      files: files.length,
      parsed: todo.length,
      cached: files.length - todo.length,
      bytes: files.reduce((a, f) => a + f.size, 0),
      ms: Date.now() - started,
    },
  };
}

async function parseAll(todo, onEach) {
  if (!todo.length) return [];
  // Biggest files first so the pool stays busy until the end.
  const queue = [...todo].sort((a, b) => b.size - a.size);
  const totalBytes = queue.reduce((a, f) => a + f.size, 0);
  const cpu = Math.max(1, (os.availableParallelism ? os.availableParallelism() : os.cpus().length) - 1);
  const workers = Math.min(cpu, 6, queue.length);

  if (workers <= 1 || totalBytes < 8 * 1024 * 1024 || process.env.TACIT_NO_WORKERS) {
    return parseSerial(queue, onEach);
  }
  try {
    return await parseWithWorkers(queue, workers, onEach);
  } catch {
    return parseSerial(queue, onEach);
  }
}

async function parseSerial(queue, onEach) {
  const out = [];
  for (const f of queue) {
    try {
      const summary = await parseSessionFile(f);
      out.push({ file: f, summary });
      onEach(summary, f);
    } catch (err) {
      out.push({ file: f, error: String((err && err.message) || err) });
      onEach(null, f);
    }
  }
  return out;
}

function parseWithWorkers(queue, count, onEach) {
  return new Promise((resolve, reject) => {
    const results = [];
    const pool = [];
    let next = 0;
    let finished = 0;
    let failed = false;
    const workerPath = path.join(here, 'worker.js');

    const dispatch = (w) => {
      if (next >= queue.length) {
        w.terminate();
        return;
      }
      const id = next++;
      w.currentId = id;
      w.postMessage({ ...queue[id], id });
    };

    for (let i = 0; i < count; i++) {
      const w = new Worker(workerPath);
      pool.push(w);
      w.on('message', (msg) => {
        const f = queue[msg.id];
        results.push(msg.summary ? { file: f, summary: msg.summary } : { file: f, error: msg.error });
        onEach(msg.summary || null, f);
        finished++;
        if (finished === queue.length) {
          for (const p of pool) p.terminate();
          resolve(results);
        } else dispatch(w);
      });
      w.on('error', (err) => {
        if (failed) return;
        failed = true;
        for (const p of pool) p.terminate();
        reject(err);
      });
      dispatch(w);
    }
  });
}

function readCache(file, projectsDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw.projectsDir !== projectsDir) return {};
    return raw.entries || {};
  } catch {
    return {};
  }
}

function writeCache(file, projectsDir, entries) {
  try {
    ensureDir(path.dirname(file));
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ projectsDir, savedAt: new Date().toISOString(), entries }));
    fs.renameSync(tmp, file);
  } catch {
    /* cache is an optimisation; never fail the scan because of it */
  }
}

export function clearCache(cacheDir) {
  const dir = cacheDir || path.join(tacitHome(), 'cache');
  try {
    for (const f of fs.readdirSync(dir)) if (f.startsWith('index-v')) fs.rmSync(path.join(dir, f), { force: true });
  } catch {
    /* nothing to clear */
  }
}

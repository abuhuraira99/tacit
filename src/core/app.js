import { EventEmitter } from 'node:events';
import { scan, clearCache } from './scanner.js';
import { resolveProjectsDir, claudeHome, isDir } from './paths.js';
import { buildIndex, overview, sessionListItem, contextLens } from './analyze.js';
import { minePatterns } from './patterns.js';
import { memoryHealth, readMemoryFile, bestCover } from './health.js';
import { forge, evaluateTrigger, KINDS } from './forge.js';
import { applyArtifact } from './apply.js';
import { refine, engineStatus, DEFAULT_MODEL, MODELS } from './ai.js';
import { buildReport } from './report.js';

/**
 * Application state: one scan of the history, everything derived from it, and settings.
 * The HTTP server and the CLI both drive this object.
 */
export class TacitApp extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.settings = {
      projectsDir: resolveProjectsDir(opts.dir),
      useCache: opts.cache !== false,
      cacheDir: opts.cacheDir,
      engine: opts.engine || 'auto',
      model: opts.model || DEFAULT_MODEL,
      apiKey: null, // memory only, never written to disk
      demo: Boolean(opts.demo),
    };
    this.state = { status: 'idle', progress: { done: 0, total: 0 }, error: null, stats: null, scannedAt: null };
    this.index = null;
    this.patterns = [];
    this._overview = null;
    this._health = null;
    this._scanPromise = null;
  }

  get ready() {
    return this.state.status === 'ready';
  }

  async load({ force = false } = {}) {
    if (this._scanPromise && !force) return this._scanPromise;
    this._scanPromise = this._doScan(force);
    return this._scanPromise;
  }

  async _doScan(force) {
    if (force && !this.settings.useCache) clearCache(this.settings.cacheDir);
    this.state = { ...this.state, status: 'scanning', error: null, progress: { done: 0, total: 0 } };
    this.emit('progress', this.state);
    try {
      if (!isDir(this.settings.projectsDir)) {
        this.index = buildIndex([], { projectsDir: this.settings.projectsDir });
        this.patterns = [];
        this._overview = overview(this.index);
        this._health = null;
        this.state = { status: 'ready', progress: { done: 0, total: 0 }, error: null, stats: { files: 0 }, scannedAt: new Date().toISOString(), empty: true };
        this.emit('progress', this.state);
        return this.state;
      }
      let last = 0;
      const result = await scan({
        projectsDir: this.settings.projectsDir,
        useCache: this.settings.useCache,
        cacheDir: this.settings.cacheDir,
        onProgress: (p) => {
          this.state.progress = { done: p.done, total: p.total };
          const now = Date.now();
          if (now - last > 120 || p.done === p.total) {
            last = now;
            this.emit('progress', this.state);
          }
        },
      });
      this.index = buildIndex(result.summaries, { projectsDir: this.settings.projectsDir });
      this.patterns = minePatterns(this.index.prompts);
      this._overview = overview(this.index);
      this._health = null;
      this.state = {
        status: 'ready',
        progress: { done: result.stats.files, total: result.stats.files },
        error: null,
        stats: { ...result.stats, errors: result.errors.length },
        scannedAt: new Date().toISOString(),
        empty: this.index.sessions.length === 0,
      };
    } catch (err) {
      this.state = { ...this.state, status: 'error', error: String((err && err.message) || err) };
    }
    this.emit('progress', this.state);
    this._scanPromise = null;
    return this.state;
  }

  // ----- read models -----

  status() {
    return {
      ...this.state,
      projectsDir: this.settings.projectsDir,
      claudeHome: claudeHome(),
      demo: this.settings.demo,
      counts: this.index ? { sessions: this.index.sessions.length, projects: this.index.projects.length, prompts: this.index.prompts.length, patterns: this.patterns.length } : null,
    };
  }

  overview() {
    const o = this._overview;
    const habits = this.patterns.filter((p) => p.kind !== 'brief');
    return { ...o, topPattern: habits[0] ? slimPattern(habits[0]) : null, patternCount: this.patterns.length, habitCount: habits.length, briefCount: this.patterns.length - habits.length };
  }

  listPatterns({ kind, scope, q } = {}) {
    let list = this.patterns;
    if (kind && kind !== 'all') list = list.filter((p) => (kind === 'brief' ? p.kind === 'brief' : p.suggestion === kind && p.kind !== 'brief'));
    if (scope && scope !== 'all') list = list.filter((p) => p.scope === scope);
    if (q) {
      const needle = q.toLowerCase();
      list = list.filter((p) => p.title.toLowerCase().includes(needle) || p.text.toLowerCase().includes(needle) || p.variants.some((v) => v.toLowerCase().includes(needle)));
    }
    const covered = this.coverageMap();
    return list.map((p) => ({ ...slimPattern(p), covered: covered.get(p.id) || null }));
  }

  getPattern(id) {
    const p = this.patterns.find((x) => x.id === id);
    if (!p) return null;
    const covered = this.coverageMap().get(p.id) || null;
    const projects = p.projects.map((x) => {
      const proj = this.index.projectById.get(x.id);
      return { ...x, cwd: proj ? proj.cwd : null, exists: Boolean(proj && proj.cwd && isDir(proj.cwd)) };
    });
    return { ...p, projects, covered };
  }

  /** Which patterns already have a matching rule in a memory file. */
  coverageMap() {
    if (this._coverage) return this._coverage;
    const map = new Map();
    const global = readMemoryFile(`${claudeHome()}/CLAUDE.md`);
    const projFiles = new Map();
    for (const p of this.patterns) {
      if (p.kind === 'brief') continue;
      const files = [];
      if (global) files.push(global);
      for (const pr of p.projects) {
        const proj = this.index.projectById.get(pr.id);
        if (!proj || !proj.cwd) continue;
        if (!projFiles.has(proj.id)) projFiles.set(proj.id, readMemoryFile(`${proj.cwd}/CLAUDE.md`));
        const f = projFiles.get(proj.id);
        if (f) files.push(f);
      }
      const rule = bestCover(
        files.flatMap((f) => f.rules.map((r) => ({ ...r, file: f.file }))),
        p,
      );
      if (rule) map.set(p.id, { file: rule.file, line: rule.line, text: rule.text });
    }
    this._coverage = map;
    setTimeout(() => (this._coverage = null), 5000).unref?.();
    return map;
  }

  listSessions({ q, project, sort = 'recent', limit = 500 } = {}) {
    let list = this.index.sessions;
    if (project) list = list.filter((s) => s.projectId === project);
    if (q) {
      const needle = q.toLowerCase();
      list = list.filter((s) => s.title.toLowerCase().includes(needle) || s.projectLabel.toLowerCase().includes(needle) || s.prompts.some((p) => p.text.toLowerCase().includes(needle)));
    }
    const sorters = {
      recent: (a, b) => (b.start || '').localeCompare(a.start || ''),
      cost: (a, b) => b.cost.usd - a.cost.usd,
      tokens: (a, b) => b.tokens.total - a.tokens.total,
      context: (a, b) => b.contextPeak - a.contextPeak,
      prompts: (a, b) => b.promptCount - a.promptCount,
    };
    list = [...list].sort(sorters[sort] || sorters.recent);
    return { total: list.length, items: list.slice(0, limit).map(sessionListItem) };
  }

  getSession(id) {
    const s = this.index.sessionById.get(id);
    if (!s) return null;
    return {
      ...sessionListItem(s),
      cwd: s.cwd,
      entrypoint: s.entrypoint,
      version: s.version,
      tokensDetail: s.tokens,
      cost: s.cost,
      prompts: s.prompts,
      commands: s.commands,
      interrupts: s.interrupts,
      tools: Object.entries(s.tools).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
      bash: Object.entries(s.bash).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([name, count]) => ({ name, count })),
      editedFiles: Object.keys(s.edits).length,
      agents: s.agents,
      skills: s.skills,
      agentRunsDetail: s.agentRuns,
      lens: contextLens(s),
    };
  }

  projects() {
    return this.index.projects.map((p) => ({ ...p, exists: Boolean(p.cwd && isDir(p.cwd)) }));
  }

  health() {
    if (!this._health) this._health = memoryHealth(this.index, this.patterns);
    return this._health;
  }

  report() {
    return buildReport({ overview: this._overview, patterns: this.patterns, health: this.health(), sessions: this.index.sessions.map(sessionListItem) });
  }

  // ----- forge -----

  draft(patternId, kind, { scope, projectId } = {}) {
    const p = this.patterns.find((x) => x.id === patternId);
    if (!p) throw httpError(404, 'That pattern no longer exists. Rescan and try again.');
    if (!KINDS.includes(kind)) throw httpError(400, `Unknown artifact kind "${kind}".`);
    const projectPath = this.projectPathFor(p, projectId);
    const artifact = forge(p, kind, { scope: scope || (projectPath ? p.scope : 'global'), projectPath });
    const result = { artifact };
    if (kind === 'skill' || kind === 'subagent') result.trigger = evaluateTrigger(artifact.description || artifact.content, p, this.index.prompts);
    return result;
  }

  evaluate(patternId, description) {
    const p = this.patterns.find((x) => x.id === patternId);
    if (!p) throw httpError(404, 'Pattern not found.');
    return evaluateTrigger(String(description || ''), p, this.index.prompts);
  }

  projectPathFor(p, projectId) {
    const ids = projectId ? [projectId] : p.projects.map((x) => x.id);
    for (const id of ids) {
      const proj = this.index.projectById.get(id);
      if (proj && proj.cwd && isDir(proj.cwd)) return proj.cwd;
    }
    return null;
  }

  allowedRoots() {
    const roots = [claudeHome()];
    for (const p of this.index.projects) if (p.cwd && isDir(p.cwd)) roots.push(p.cwd);
    return roots;
  }

  apply(patternId, kind, { scope, projectId, content, overwrite } = {}) {
    const { artifact } = this.draft(patternId, kind, { scope, projectId });
    const result = applyArtifact(artifact, { allowedRoots: this.allowedRoots(), overwrite: Boolean(overwrite), content });
    this._health = null;
    this._coverage = null;
    return result;
  }

  async refine(patternId, kind, { scope, projectId, content, engine } = {}) {
    const p = this.patterns.find((x) => x.id === patternId);
    if (!p) throw httpError(404, 'Pattern not found.');
    const { artifact } = this.draft(patternId, kind, { scope, projectId });
    if (content) artifact.content = content;
    const status = await engineStatus(this.settings);
    let chosen = engine || this.settings.engine;
    if (chosen === 'none') chosen = null;
    else if (chosen === 'auto') chosen = status.api.ready ? 'api' : status.cli.ready ? 'cli' : null;
    if (!chosen) throw httpError(400, 'No Claude engine is set up. Add an API key in Settings, or install Claude Code.');
    const out = await refine({ engine: chosen, model: this.settings.model, apiKey: this.settings.apiKey, pattern: p, artifact });
    const result = { ...out };
    if (kind === 'skill' || kind === 'subagent') {
      const desc = (/^description:\s*(.+)$/m.exec(out.content) || [])[1] || out.content;
      result.trigger = evaluateTrigger(desc.replace(/^["']|["']$/g, ''), p, this.index.prompts);
    }
    return result;
  }

  async settingsView() {
    const engines = await engineStatus(this.settings);
    return {
      projectsDir: this.settings.projectsDir,
      claudeHome: claudeHome(),
      engine: this.settings.engine,
      model: this.settings.model,
      models: MODELS,
      hasSessionKey: Boolean(this.settings.apiKey),
      useCache: this.settings.useCache,
      demo: this.settings.demo,
      engines,
    };
  }

  updateSettings(patch = {}) {
    let rescan = false;
    if (typeof patch.projectsDir === 'string' && patch.projectsDir.trim()) {
      const next = resolveProjectsDir(patch.projectsDir.trim());
      if (next !== this.settings.projectsDir) {
        this.settings.projectsDir = next;
        rescan = true;
      }
    }
    if (['auto', 'api', 'cli', 'none'].includes(patch.engine)) this.settings.engine = patch.engine;
    if (typeof patch.model === 'string' && /^[a-z0-9.-]{3,64}$/.test(patch.model)) this.settings.model = patch.model;
    if (typeof patch.apiKey === 'string') this.settings.apiKey = patch.apiKey.trim() || null;
    if (patch.clearKey) this.settings.apiKey = null;
    if (rescan) this.load({ force: true });
    return rescan;
  }
}

export function slimPattern(p) {
  return {
    id: p.id,
    title: p.title,
    text: p.text,
    variants: p.variants.slice(0, 5),
    habit: p.habit,
    kind: p.kind,
    suggestion: p.suggestion,
    alternatives: p.alternatives,
    count: p.count,
    sessions: p.sessions,
    projects: p.projects,
    scope: p.scope,
    firstTs: p.firstTs,
    lastTs: p.lastTs,
    corrections: p.corrections,
    score: p.score,
    words: p.words || null,
  };
}

export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

import { pathKey, projectLabel } from './paths.js';
import { estimateCost, cacheSavings, modelLabel } from './pricing.js';
import { truncate } from './text.js';

const IDLE_GAP_MS = 10 * 60 * 1000;

/**
 * Build the in-memory index the API serves from per-file summaries.
 */
export function buildIndex(summaries, meta = {}) {
  const mains = [];
  const subsByParent = new Map();
  for (const s of summaries) {
    if (s.isSubagent) {
      if (!subsByParent.has(s.parentSessionId)) subsByParent.set(s.parentSessionId, []);
      subsByParent.get(s.parentSessionId).push(s);
    } else mains.push(s);
  }

  const projects = new Map();
  const sessions = [];
  const prompts = [];

  for (const s of mains) {
    if (!s.firstTs) continue; // empty or metadata-only transcript
    const projKey = s.cwd ? pathKey(s.cwd) : `key:${s.projectKey}`;
    let proj = projects.get(projKey);
    if (!proj) {
      proj = {
        id: shortHash(projKey),
        key: projKey,
        label: projectLabel(s.cwd, s.projectKey),
        cwd: s.cwd || null,
        sessions: 0,
        prompts: 0,
        tokens: 0,
        costUSD: 0,
        firstTs: s.firstTs,
        lastTs: s.lastTs,
      };
      projects.set(projKey, proj);
    }
    const subs = subsByParent.get(s.sessionId) || [];
    const session = buildSession(s, subs, proj);
    sessions.push(session);

    proj.sessions++;
    proj.prompts += session.promptCount;
    proj.tokens += session.tokens.total;
    proj.costUSD += session.cost.usd;
    if (s.firstTs < proj.firstTs) proj.firstTs = s.firstTs;
    if (s.lastTs > proj.lastTs) proj.lastTs = s.lastTs;

    s.prompts.forEach((p, i) => {
      prompts.push({
        id: `${session.id}:${i}`,
        sessionId: session.id,
        projectId: proj.id,
        projectLabel: proj.label,
        ts: p.ts,
        text: p.text,
      });
    });
  }

  sessions.sort((a, b) => (b.start || '').localeCompare(a.start || ''));
  const projectList = [...projects.values()].sort((a, b) => b.sessions - a.sessions);

  return {
    meta: { ...meta, builtAt: new Date().toISOString() },
    sessions,
    sessionById: new Map(sessions.map((s) => [s.id, s])),
    projects: projectList,
    projectById: new Map(projectList.map((p) => [p.id, p])),
    prompts,
    orphanSubagents: [...subsByParent.entries()].filter(([pid]) => !sessions.some((x) => x.id === pid)).length,
  };
}

function buildSession(s, subs, proj) {
  const tokens = { in: 0, out: 0, cw: 0, cr: 0, total: 0 };
  const models = {};
  let estimate = 0;
  let saved = 0;
  const addUsage = (usage) => {
    for (const [model, u] of Object.entries(usage)) {
      tokens.in += u.in;
      tokens.out += u.out;
      tokens.cw += u.cw5m + u.cw1h;
      tokens.cr += u.cr;
      const label = modelLabel(model);
      models[label] = (models[label] || 0) + u.out + u.in + u.cw5m + u.cw1h + u.cr;
      estimate += estimateCost(model, u);
      saved += cacheSavings(model, u);
    }
  };
  addUsage(s.usage);
  const tools = { ...s.tools };
  const agentRuns = [];
  for (const sub of subs) {
    addUsage(sub.usage);
    let subTokens = 0;
    for (const u of Object.values(sub.usage)) subTokens += u.in + u.out + u.cw5m + u.cw1h + u.cr;
    for (const [k, v] of Object.entries(sub.tools)) tools[k] = (tools[k] || 0) + v;
    agentRuns.push({ id: sub.agentId, tokens: subTokens, toolCalls: sum(Object.values(sub.tools)), start: sub.firstTs, end: sub.lastTs });
  }
  tokens.total = tokens.in + tokens.out + tokens.cw + tokens.cr;

  const reported = s.cost && s.cost.usd > 0;
  const contextPeak = s.context.reduce((m, p) => Math.max(m, p[1]), 0);
  const activeMs = activeTime([...s.prompts.map((p) => p.ts), ...s.context.map((p) => p[0])]);
  const repeatedReads = Object.entries(s.reads)
    .filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([file, count]) => ({ file, count }));

  const firstPrompt = s.prompts[0] ? s.prompts[0].text : '';
  return {
    id: s.sessionId,
    title: s.customTitle || s.title || truncate(firstPrompt.replace(/\s+/g, ' '), 90) || 'Untitled session',
    projectId: proj.id,
    projectLabel: proj.label,
    cwd: s.cwd,
    branch: s.gitBranch,
    entrypoint: s.entrypoint,
    version: s.version,
    start: s.firstTs,
    end: s.lastTs,
    activeMs,
    promptCount: s.prompts.length,
    prompts: s.prompts,
    commands: s.commands,
    interrupts: s.interrupts,
    images: s.images,
    tokens,
    models,
    cost: { usd: reported ? s.cost.usd : estimate, reported: Boolean(reported), estimate, cacheSavedUSD: saved },
    linesAdded: s.cost ? s.cost.linesAdded : 0,
    linesRemoved: s.cost ? s.cost.linesRemoved : 0,
    context: s.context,
    contextPeak,
    compactions: s.compactions,
    tools,
    toolCalls: sum(Object.values(tools)),
    toolErrors: s.toolErrors,
    toolResultTokens: s.toolResultTokens || 0,
    bash: s.bash,
    edits: s.edits,
    reads: s.reads,
    repeatedReads,
    agents: s.agents,
    skills: s.skills,
    mcp: s.mcp,
    agentRuns,
    heavyResults: s.heavyResults,
    apiErrors: s.apiErrors,
    hookRuns: s.hookRuns,
  };
}

/** Sum of gaps between events, ignoring idle stretches longer than 10 minutes. */
export function activeTime(stamps) {
  const t = stamps
    .filter(Boolean)
    .map((x) => Date.parse(x))
    .filter((x) => Number.isFinite(x))
    .sort((a, b) => a - b);
  let ms = 0;
  for (let i = 1; i < t.length; i++) {
    const gap = t[i] - t[i - 1];
    if (gap > 0 && gap <= IDLE_GAP_MS) ms += gap;
  }
  return ms;
}

/** Everything the Overview page needs. */
export function overview(index) {
  const { sessions, projects, prompts } = index;
  const totals = {
    sessions: sessions.length,
    projects: projects.length,
    prompts: prompts.length,
    activeHours: sum(sessions.map((s) => s.activeMs)) / 3.6e6,
    tokens: sum(sessions.map((s) => s.tokens.total)),
    outputTokens: sum(sessions.map((s) => s.tokens.out)),
    costUSD: sum(sessions.map((s) => s.cost.usd)),
    reportedShare: sessions.length ? sessions.filter((s) => s.cost.reported).length / sessions.length : 0,
    cacheSavedUSD: sum(sessions.map((s) => s.cost.cacheSavedUSD)),
    compactions: sum(sessions.map((s) => s.compactions.length)),
    interrupts: sum(sessions.map((s) => s.interrupts)),
    subagentRuns: sum(sessions.map((s) => s.agentRuns.length)),
    toolCalls: sum(sessions.map((s) => s.toolCalls)),
    linesAdded: sum(sessions.map((s) => s.linesAdded)),
    linesRemoved: sum(sessions.map((s) => s.linesRemoved)),
  };
  const cr = sum(sessions.map((s) => s.tokens.cr));
  const inputSide = sum(sessions.map((s) => s.tokens.in + s.tokens.cw + s.tokens.cr));
  totals.cacheHitRate = inputSide ? cr / inputSide : 0;

  // Daily activity, keyed by local date.
  const days = new Map();
  const day = (iso) => localDate(iso);
  for (const s of sessions) {
    const d = day(s.start);
    if (!d) continue;
    const row = days.get(d) || { date: d, sessions: 0, prompts: 0, tokens: 0, costUSD: 0 };
    row.sessions++;
    row.tokens += s.tokens.total;
    row.costUSD += s.cost.usd;
    days.set(d, row);
  }
  for (const p of prompts) {
    const d = day(p.ts);
    if (!d) continue;
    const row = days.get(d) || { date: d, sessions: 0, prompts: 0, tokens: 0, costUSD: 0 };
    row.prompts++;
    days.set(d, row);
  }
  const daily = fillDays([...days.values()].sort((a, b) => a.date.localeCompare(b.date)));

  // When you work: weekday x hour, by prompts.
  const heat = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const p of prompts) {
    const t = Date.parse(p.ts);
    if (!Number.isFinite(t)) continue;
    const d = new Date(t);
    heat[(d.getDay() + 6) % 7][d.getHours()]++;
  }

  const tools = tally(sessions.map((s) => s.tools)).slice(0, 12);
  const commands = tally(sessions.map((s) => s.bash)).slice(0, 10);
  const slash = tally(sessions.map((s) => s.commands)).slice(0, 10);
  const agents = tally(sessions.map((s) => s.agents)).slice(0, 8);
  const skills = tally(sessions.map((s) => s.skills)).slice(0, 8);
  const mcp = tally(sessions.map((s) => s.mcp)).slice(0, 8);
  const models = tally(sessions.map((s) => s.models)).slice(0, 8);

  const first = sessions.reduce((m, s) => (!m || (s.start && s.start < m) ? s.start : m), null);
  const last = sessions.reduce((m, s) => (!m || (s.end && s.end > m) ? s.end : m), null);

  return {
    totals,
    range: { first, last },
    daily,
    heat,
    tools,
    commands,
    slash,
    agents,
    skills,
    mcp,
    models,
    topProjects: projects.slice(0, 8).map(pick('id', 'label', 'sessions', 'prompts', 'tokens', 'costUSD', 'lastTs')),
  };
}

export function sessionListItem(s) {
  return {
    id: s.id,
    title: s.title,
    projectId: s.projectId,
    projectLabel: s.projectLabel,
    branch: s.branch,
    start: s.start,
    end: s.end,
    activeMs: s.activeMs,
    promptCount: s.promptCount,
    tokens: s.tokens.total,
    outputTokens: s.tokens.out,
    costUSD: s.cost.usd,
    costReported: s.cost.reported,
    contextPeak: s.contextPeak,
    compactions: s.compactions.length,
    toolCalls: s.toolCalls,
    agentRuns: s.agentRuns.length,
    models: Object.keys(s.models),
    linesAdded: s.linesAdded,
    linesRemoved: s.linesRemoved,
  };
}

/** Context lens: where the window went in one session, and what to do about it. */
export function contextLens(s) {
  const findings = [];
  const fmt = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  if (s.compactions.length) {
    findings.push({
      level: 'warn',
      title: `The conversation was compacted ${s.compactions.length} time${s.compactions.length > 1 ? 's' : ''}`,
      detail: 'Each compaction trades detail for room. Splitting long work into focused sessions, or handing exploration to a subagent, keeps the important details intact.',
    });
  }
  const big = s.heavyResults.filter((r) => r.tokens >= 8000);
  if (big.length) {
    findings.push({
      level: 'warn',
      title: `${big.length} tool output${big.length > 1 ? 's' : ''} over 8k tokens`,
      detail: `The largest was ${fmt(big[0].tokens)} tokens from ${big[0].tool}${big[0].target ? ` (${truncate(big[0].target, 70)})` : ''}. Ask for narrower reads, add limits to commands, or let a subagent read it and report back.`,
    });
  }
  if (s.repeatedReads.length) {
    const r = s.repeatedReads[0];
    findings.push({
      level: 'info',
      title: `${s.repeatedReads.length} file${s.repeatedReads.length > 1 ? 's were' : ' was'} read three or more times`,
      detail: `${baseName(r.file)} was read ${r.count} times. Facts that keep being looked up belong in CLAUDE.md.`,
    });
  }
  if (s.interrupts >= 3) {
    findings.push({
      level: 'info',
      title: `You stopped Claude ${s.interrupts} times`,
      detail: 'Frequent interruptions usually mean the plan was unclear. Starting in plan mode lets you agree on the approach before any edits.',
    });
  }
  if (s.contextPeak >= 150000 && !s.compactions.length) {
    findings.push({
      level: 'info',
      title: `Context peaked at ${fmt(s.contextPeak)} tokens`,
      detail: 'Long contexts cost more per turn and dilute attention. /compact at a natural break, or /clear between unrelated tasks.',
    });
  }
  if (!findings.length) {
    findings.push({ level: 'good', title: 'Nothing stands out', detail: 'This session stayed lean: no compactions, no oversized tool outputs, no repeated reads.' });
  }
  return {
    curve: s.context,
    compactions: s.compactions,
    peak: s.contextPeak,
    heavy: s.heavyResults,
    repeatedReads: s.repeatedReads,
    toolResultTokens: s.toolResultTokens,
    findings,
  };
}

export function localDate(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fillDays(rows) {
  if (rows.length < 2) return rows;
  const out = [];
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const start = new Date(rows[0].date + 'T12:00:00');
  const end = new Date(rows[rows.length - 1].date + 'T12:00:00');
  for (let d = start; d <= end && out.length < 800; d = new Date(d.getTime() + 864e5)) {
    const key = localDate(d.toISOString());
    out.push(byDate.get(key) || { date: key, sessions: 0, prompts: 0, tokens: 0, costUSD: 0 });
  }
  return out;
}

function tally(maps) {
  const acc = {};
  for (const m of maps) for (const [k, v] of Object.entries(m || {})) acc[k] = (acc[k] || 0) + v;
  return Object.entries(acc)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));
}

function pick(...keys) {
  return (o) => Object.fromEntries(keys.map((k) => [k, o[k]]));
}

function sum(arr) {
  let n = 0;
  for (const x of arr) n += x || 0;
  return n;
}

function baseName(p) {
  return String(p).split(/[\\/]/).pop();
}

export function shortHash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

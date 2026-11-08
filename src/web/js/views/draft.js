import { h, mount, toast, confirmDialog } from '../dom.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import { tally } from '../charts.js';
import { plural, KIND_LABEL, KIND_EXPLAIN, pct } from '../format.js';

let current = null;
export const title = () => (current ? `Draft: ${current.title}` : 'Draft');

const KINDS = ['rule', 'skill', 'hook', 'subagent', 'command'];
const MODE_TEXT = {
  'append-rule': 'Adds one line under “## Working agreements”. If a matching rule is already there, nothing is written.',
  'merge-json': 'Merges this hook into settings.json. Existing settings are kept as they are.',
  create: 'Creates a new file. If one with this name exists, you will be asked before it is replaced.',
};

export async function render({ params }) {
  const [id, kind] = params;
  const [p, settings] = await Promise.all([api.get(`/api/patterns/${id}`), api.get('/api/settings')]);
  current = p;
  const existing = p.projects.filter((x) => x.exists);
  const ui = {
    scope: p.scope === 'global' || !existing.length ? 'global' : 'project',
    projectId: existing[0] ? existing[0].id : null,
    draft: null,
    busy: false,
  };

  const editor = h('textarea', { class: 'editor', spellcheck: 'false', 'aria-label': 'Draft content', oninput: () => (dirty.textContent = 'Edited') });
  const dirty = h('span', { class: 'muted small' }, '');
  const pathEl = h('div', { class: 'path', title: '' });
  const noteEl = h('p', { class: 'editor-note' });
  const triggerBox = h('div');
  const resultBox = h('div');
  const refineBtn = h('button', { class: 'btn', type: 'button', onclick: doRefine }, icon('spark'), 'Refine with Claude');
  const saveBtn = h('button', { class: 'btn primary', type: 'button', onclick: doSave }, icon('save'), 'Save to file');

  const engineReady = settings.engine !== 'none' && (settings.engines.api.ready || settings.engines.cli.ready);
  if (!engineReady) {
    refineBtn.disabled = true;
    refineBtn.title = 'Add an API key in Settings, or install Claude Code, to refine drafts with Claude.';
  }

  async function load() {
    mount(triggerBox);
    mount(resultBox);
    try {
      const out = await api.post('/api/forge/draft', { patternId: id, kind, scope: ui.scope, projectId: ui.scope === 'project' ? ui.projectId : null });
      ui.draft = out.artifact;
      editor.value = out.artifact.content;
      editor.rows = Math.min(28, Math.max(kind === 'rule' ? 6 : 14, out.artifact.content.split('\n').length + 2));
      dirty.textContent = '';
      mount(pathEl, h('bdi', null, out.artifact.path));
      pathEl.title = out.artifact.path;
      noteEl.textContent = `${out.artifact.note} ${MODE_TEXT[out.artifact.mode] || ''}`;
      if (out.trigger) mount(triggerBox, triggerPanel(out.trigger));
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  async function doRefine() {
    if (ui.busy) return;
    ui.busy = true;
    refineBtn.disabled = true;
    mount(refineBtn, icon('spark'), 'Refining…');
    try {
      const out = await api.post('/api/forge/refine', { patternId: id, kind, scope: ui.scope, projectId: ui.scope === 'project' ? ui.projectId : null, content: editor.value });
      editor.value = out.content;
      dirty.textContent = `Refined with ${out.engine === 'cli' ? 'Claude Code' : out.model}`;
      mount(resultBox, h('div', { class: 'note info', style: { marginTop: '14px' } }, icon('spark'), h('span', null, out.rationale || 'Claude rewrote the draft. Review it before saving.')));
      if (out.trigger) mount(triggerBox, triggerPanel(out.trigger));
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      ui.busy = false;
      refineBtn.disabled = !engineReady;
      mount(refineBtn, icon('spark'), 'Refine with Claude');
    }
  }

  async function doSave(_, overwrite = false) {
    if (!ui.draft) return;
    const ok = await confirmDialog({
      title: overwrite ? 'Replace the existing file?' : 'Save this draft?',
      body: h(
        'div',
        null,
        h('p', null, overwrite ? 'The current file will be replaced. A backup is kept first.' : MODE_TEXT[ui.draft.mode]),
        h('p', { class: 'path', style: { direction: 'ltr', whiteSpace: 'normal', overflowWrap: 'anywhere' } }, ui.draft.path),
        h('p', { class: 'muted small' }, 'Any file Tacit changes is copied to ~/.tacit/backups first.'),
      ),
      confirm: overwrite ? 'Replace file' : 'Save',
    });
    if (!ok) return;
    try {
      const r = await api.post('/api/forge/apply', { patternId: id, kind, scope: ui.scope, projectId: ui.scope === 'project' ? ui.projectId : null, content: editor.value, overwrite, confirm: true });
      if (r.status === 'written') {
        toast(`Saved. ${capitalize(r.action)}.`);
        mount(
          resultBox,
          h(
            'div',
            { class: 'note good', style: { marginTop: '14px' } },
            icon('check'),
            h('span', null, `Saved to ${r.path}.`, r.backup ? ` The previous version is backed up at ${r.backup}.` : '', kind === 'rule' ? ' Claude reads it at the start of the next session.' : ''),
          ),
        );
      } else if (r.status === 'exists') {
        doSave(null, true);
      } else {
        mount(resultBox, h('div', { class: 'note plain', style: { marginTop: '14px' } }, icon('check'), h('span', null, r.reason || 'Nothing to change.', r.match ? ` Existing: ${r.match}` : '')));
      }
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  async function recheck() {
    const m = /^description:\s*(.+)$/m.exec(editor.value);
    const description = m ? m[1].replace(/^["']|["']$/g, '') : editor.value;
    try {
      const t = await api.post('/api/forge/evaluate', { patternId: id, description });
      mount(triggerBox, triggerPanel(t));
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  function triggerPanel(t) {
    const verdictChip = { good: ['good', 'Triggers reliably'], fair: ['', 'Triggers sometimes'], weak: ['warn', 'Rarely triggers'] }[t.verdict];
    return h(
      'section',
      { class: 'sheet panel trigger', style: { marginTop: '18px' }, 'aria-labelledby': 'trig-h' },
      h(
        'div',
        { class: 'trigger-head' },
        h('div', null, h('h2', { class: 'panel-title', id: 'trig-h' }, 'Trigger check'), h('p', { class: 'panel-sub', style: { margin: 0 } }, `Would this description have matched your past requests? Tested against ${plural(t.corpus, 'prompt')} from your history.`)),
        h('span', { class: ['chip', verdictChip[0]] }, verdictChip[1]),
      ),
      h(
        'div',
        { class: 'meter' },
        meter('Caught', t.recall, `${t.caught} of ${t.positives}`),
        meter('Precision', t.precision, pct(t.precision)),
      ),
      h('p', { class: 'small muted', style: { margin: 0 } }, `${t.advice} It would also have matched ${plural(t.falsePositives, 'unrelated prompt')}.`),
      t.examples.misses.length ? h('div', null, h('div', { class: 'label', style: { marginBottom: '6px' } }, 'Missed'), h('ul', { class: 'examples' }, t.examples.misses.map((x) => h('li', null, x)))) : null,
      t.examples.falsePositives.length ? h('div', null, h('div', { class: 'label', style: { marginBottom: '6px' } }, 'Would also fire on'), h('ul', { class: 'examples' }, t.examples.falsePositives.map((x) => h('li', null, x)))) : null,
      h('div', null, h('button', { class: 'btn small', type: 'button', onclick: recheck }, icon('refresh'), 'Check the edited description')),
    );
  }

  function meter(label, value, text) {
    return h('div', { class: 'meter-row' }, h('span', null, label), h('span', { class: 'meter-track' }, h('span', { class: 'meter-fill', style: { width: `${Math.round((value || 0) * 100)}%`, display: 'block' } })), h('span', { class: 'num small muted', style: { textAlign: 'right' } }, text));
  }

  const scopeSel = h(
    'div',
    { class: 'field' },
    h('span', { class: 'label' }, 'Where it applies'),
    h(
      'div',
      { class: 'segmented', role: 'group', 'aria-label': 'Scope' },
      h('button', { type: 'button', 'aria-pressed': String(ui.scope === 'global'), onclick: (e) => setScope('global', e) }, 'Every project'),
      h('button', { type: 'button', 'aria-pressed': String(ui.scope === 'project'), disabled: existing.length ? null : true, onclick: (e) => setScope('project', e) }, 'One project'),
    ),
    existing.length
      ? h(
          'select',
          {
            class: 'select',
            'aria-label': 'Project',
            style: { marginTop: '6px', display: ui.scope === 'project' ? '' : 'none' },
            onchange: (e) => {
              ui.projectId = e.target.value;
              load();
            },
          },
          existing.map((x) => h('option', { value: x.id }, x.label)),
        )
      : h('span', { class: 'hint' }, 'The project folders for this habit are not on this machine, so it can only go in your personal settings.'),
  );

  function setScope(s, e) {
    ui.scope = s;
    scopeSel.querySelectorAll('.segmented button').forEach((b) => b.setAttribute('aria-pressed', 'false'));
    e.currentTarget.setAttribute('aria-pressed', 'true');
    const sel = scopeSel.querySelector('select');
    if (sel) sel.style.display = s === 'project' ? '' : 'none';
    load();
  }

  const side = h(
    'aside',
    { class: 'ws-side' },
    h(
      'section',
      { class: 'sheet panel' },
      h('div', { class: 'row', style: { marginBottom: '6px' } }, tally(p.count)),
      h('div', { class: 'habit-title' }, p.title),
      h('p', { class: 'habit-quote', style: { fontSize: '19px', margin: '8px 0 6px' } }, p.text),
      h('p', { class: 'small muted', style: { margin: 0 } }, `${p.count} times, ${plural(p.sessions, 'session')}.`),
      h('a', { class: 'small', href: `#/repeats/${p.id}` }, 'See every time you said it'),
    ),
    h(
      'nav',
      { class: 'kind-tabs', 'aria-label': 'Artifact type' },
      KINDS.map((k) =>
        h(
          'a',
          { class: 'kind-tab', href: `#/draft/${id}/${k}`, 'aria-current': k === kind ? 'page' : null, style: { color: 'inherit', textDecoration: 'none' } },
          h('span', null, h('b', null, KIND_LABEL[k]), h('small', null, KIND_EXPLAIN[k])),
          p.suggestion === k ? h('span', { class: 'chip rule' }, 'Suggested') : null,
        ),
      ),
    ),
    h('section', { class: 'sheet panel' }, scopeSel),
  );

  const mainCol = h(
    'div',
    null,
    h(
      'section',
      { class: 'sheet editor-card' },
      h('div', { class: 'editor-bar' }, icon('folder', ''), pathEl, dirty),
      editor,
      h(
        'div',
        { class: 'editor-foot' },
        noteEl,
        h(
          'div',
          { class: 'actions' },
          h('button', { class: 'btn ghost', type: 'button', onclick: copy }, icon('copy'), 'Copy'),
          h('button', { class: 'btn ghost', type: 'button', onclick: download }, icon('download'), 'Download'),
          refineBtn,
          saveBtn,
        ),
      ),
    ),
    resultBox,
    triggerBox,
    !engineReady
      ? h('p', { class: 'small muted', style: { marginTop: '14px' } }, 'Drafts come from Tacit’s own templates. To have Claude polish them, add an API key or install Claude Code, then pick it in ', h('a', { href: '#/settings' }, 'Settings'), '.')
      : null,
  );

  async function copy() {
    try {
      await navigator.clipboard.writeText(editor.value);
      toast('Copied.');
    } catch {
      editor.select();
      document.execCommand('copy');
      toast('Copied.');
    }
  }

  function download() {
    const name = (ui.draft && ui.draft.path.split(/[\\/]/).pop()) || 'draft.md';
    const blob = new Blob([editor.value], { type: 'text/plain' });
    const a = h('a', { href: URL.createObjectURL(blob), download: kind === 'rule' ? 'CLAUDE.md-rule.md' : name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  await load();
  return h(
    'div',
    { class: 'page' },
    h('a', { class: 'crumb', href: `#/repeats/${id}` }, icon('back'), 'Back to the repeat'),
    h('header', { class: 'page-head' }, h('div', null, h('h1', { class: 'page-title' }, `Write it down as a ${KIND_LABEL[kind].replace('CLAUDE.md ', '').toLowerCase()}`), h('p', { class: 'page-lede' }, KIND_EXPLAIN[kind]))),
    h('div', { class: 'workspace' }, side, mainCol),
  );
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

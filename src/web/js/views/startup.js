import { h, mount, toast, confirmDialog } from '../dom.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import { int, plural, dateTime, ago } from '../format.js';

export const title = 'Startup memory';

const TABS = [
  ['read', 'Read'],
  ['rules', 'Rules'],
  ['edit', 'Edit'],
  ['changes', 'Changes'],
];

export async function render({ hash }) {
  const params = new URLSearchParams((hash.split('?')[1] || ''));
  const data = await api.get('/api/memory');
  const files = data.scopes.flatMap((s) => s.files.map((f) => ({ ...f, scope: s })));
  const selectedPath = params.get('file') || files[0]?.path;
  const tab = TABS.some(([k]) => k === params.get('tab')) ? params.get('tab') : 'read';
  const file = selectedPath ? await api.get(`/api/memory/file?path=${encodeURIComponent(selectedPath)}`) : null;
  const scope = files.find((f) => f.path === selectedPath)?.scope || data.scopes[0];
  const global = data.scopes[0];

  return h(
    'div',
    { class: 'page' },
    h(
      'header',
      { class: 'page-head' },
      h(
        'div',
        null,
        h('h1', { class: 'page-title' }, 'Startup memory'),
        h(
          'p',
          { class: 'page-lede' },
          'Claude Code reads these files at the start of every new chat, before your first message. See exactly what it gets, switch a file off, pause a rule, or edit it here.',
        ),
      ),
    ),
    startHero(global),
    h(
      'div',
      { class: 'workspace startup' },
      h('aside', { class: 'ws-side' }, data.scopes.map((s) => scopeList(s, selectedPath, tab))),
      file ? fileView(file, scope, tab) : h('section', { class: 'sheet panel' }, h('p', { class: 'muted' }, 'No memory files were found.')),
    ),
  );
}

function startHero(global) {
  const f = global.files[0];
  const state = f.exists ? 'on' : f.disabled ? 'off' : 'none';
  const line = {
    on: `Every new chat, in every project, starts with your personal CLAUDE.md: about ${int(f.tokens + f.importTokens)} tokens before you type anything.`,
    off: 'Your personal CLAUDE.md is switched off. New chats start without it until you turn it back on.',
    none: 'You have no personal CLAUDE.md, so new chats start with only the project files below.',
  }[state];
  return h(
    'section',
    { class: 'startup-hero' },
    h('div', { class: 'startup-hero-num' }, h('span', null, state === 'on' ? int(f.tokens + f.importTokens) : '0'), h('small', null, 'tokens at startup')),
    h('p', null, line),
  );
}

function scopeList(s, selectedPath, tab) {
  return h(
    'section',
    { class: 'sheet panel startup-scope' },
    h('div', { class: 'label' }, s.id === 'global' ? 'Personal, every project' : s.label),
    h(
      'nav',
      { class: 'kind-tabs', 'aria-label': `${s.label} memory files` },
      s.files.map((f) =>
        h(
          'a',
          {
            class: 'kind-tab',
            href: `#/startup?file=${encodeURIComponent(f.path)}&tab=${tab}`,
            'aria-current': f.path === selectedPath ? 'page' : null,
          },
          h('span', null, h('b', null, shortName(f.path, s)), h('small', null, fileLine(f))),
          h('span', { class: ['chip', f.exists ? 'good' : f.disabled ? 'warn' : ''] }, f.exists ? 'On' : f.disabled ? 'Off' : 'None'),
        ),
      ),
    ),
  );
}

function shortName(p, s) {
  if (s.id === 'global') return '~/.claude/CLAUDE.md';
  const rel = p.slice(s.dir.length).replace(/^[\\/]/, '').replace(/\\/g, '/');
  return rel || p;
}

function fileLine(f) {
  if (!f.exists && !f.disabled) return 'Not created yet';
  const parts = [`~${int(f.tokens)} tokens`];
  if (f.importTokens) parts.push(`+${int(f.importTokens)} imported`);
  if (f.parked) parts.push(`${f.parked} paused`);
  return parts.join(', ');
}

function fileView(file, scope, tab) {
  const go = (t) => (location.hash = `#/startup?file=${encodeURIComponent(file.path)}&tab=${t}`);
  const reload = () => window.dispatchEvent(new HashChangeEvent('hashchange'));
  const statusChip = file.exists ? h('span', { class: 'chip good' }, icon('check'), 'Loaded in new chats') : file.disabled ? h('span', { class: 'chip warn' }, 'Off for new chats') : h('span', { class: 'chip' }, 'Not created yet');

  async function toggle() {
    const turningOff = file.exists;
    const ok = await confirmDialog({
      title: turningOff ? 'Switch this file off for new chats?' : 'Switch this file back on?',
      body: h(
        'div',
        null,
        h(
          'p',
          null,
          turningOff
            ? 'Tacit renames it to CLAUDE.md.disabled, so Claude Code stops loading it. Nothing is deleted. Chats that are already open keep what they read when they started.'
            : 'Tacit renames it back to CLAUDE.md. The next new chat loads it again.',
        ),
        h('p', { class: 'path', style: { direction: 'ltr', whiteSpace: 'normal', overflowWrap: 'anywhere' } }, file.path),
      ),
      confirm: turningOff ? 'Switch off' : 'Switch on',
      danger: turningOff,
    });
    if (!ok) return;
    try {
      await api.post('/api/memory/toggle', { path: file.path, enabled: !turningOff, confirm: true });
      toast(turningOff ? 'Switched off. New chats will not load this file.' : 'Switched on. New chats will load this file.');
      reload();
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  const body = { read: readTab, rules: rulesTab, edit: editTab, changes: changesTab }[tab](file, reload);

  return h(
    'div',
    { class: 'stack' },
    h(
      'section',
      { class: 'sheet editor-card' },
      h(
        'div',
        { class: 'editor-bar' },
        icon('memory', ''),
        h('div', { class: 'path', title: file.path }, h('bdi', null, file.path)),
        statusChip,
      ),
      h(
        'div',
        { class: 'startup-facts' },
        fact(file.exists || file.disabled ? `~${int(file.tokens)}` : '0', 'tokens'),
        fact(int(file.rules.length), file.rules.length === 1 ? 'rule' : 'rules'),
        fact(int(file.imports.length), file.imports.length === 1 ? 'import' : 'imports'),
        fact(int(file.parkedRules.length), 'paused'),
        h(
          'div',
          { class: 'startup-facts-action' },
          file.exists || file.disabled
            ? h('button', { class: ['btn', file.exists ? '' : 'primary'], type: 'button', onclick: toggle }, icon(file.exists ? 'alert' : 'check'), file.exists ? 'Switch off for new chats' : 'Switch on for new chats')
            : null,
        ),
      ),
      h(
        'div',
        { class: 'startup-tabs' },
        h(
          'div',
          { class: 'segmented', role: 'tablist', 'aria-label': 'View' },
          TABS.map(([k, label]) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(k === tab), 'aria-pressed': String(k === tab), onclick: () => go(k) }, label, k === 'changes' && file.history.length ? h('span', { class: 'n' }, int(file.history.length)) : null)),
        ),
      ),
      body,
    ),
    scope.sessions ? h('p', { class: 'small muted' }, `This project has ${plural(scope.sessions, 'session')} in your history. Personal memory is loaded first, then project memory.`) : null,
  );
}

function fact(value, label) {
  return h('div', { class: 'startup-fact' }, h('b', null, value), h('span', null, label));
}

// ---------- Read ----------

function readTab(file) {
  if (!file.exists && !file.disabled) {
    return h('div', { class: 'startup-body' }, h('p', { class: 'muted' }, 'This file does not exist yet. Open Edit to write it, or Rules to add a first rule.'));
  }
  return h(
    'div',
    { class: 'startup-body' },
    file.disabled ? h('div', { class: 'note plain' }, icon('alert'), h('span', null, 'Switched off. This is what Claude would read if you turned it back on.')) : h('p', { class: 'small muted', style: { margin: 0 } }, 'This is the exact text Claude Code puts in front of your first message.'),
    h('pre', { class: 'startup-read' }, file.content || '(empty file)'),
    file.imports.length
      ? h(
          'div',
          { class: 'startup-imports' },
          h('h3', { class: 'section-title' }, 'Also pulled in by @ imports'),
          h(
            'ul',
            null,
            file.imports.map((i) => h('li', null, h('code', null, `@${i.ref}`), h('span', { class: 'muted small' }, i.exists ? `~${int(i.tokens)} tokens` : 'file not found, so nothing is loaded'))),
          ),
        )
      : null,
  );
}

// ---------- Rules ----------

function rulesTab(file, reload) {
  const sections = new Map();
  for (const r of file.rules) {
    const key = r.section || 'No heading';
    if (!sections.has(key)) sections.set(key, []);
    sections.get(key).push(r);
  }
  const off = !file.exists;

  async function take(rule, mode) {
    const ok = await confirmDialog({
      title: mode === 'pause' ? 'Pause this rule?' : 'Remove this rule?',
      body: h(
        'div',
        null,
        h('p', { class: 'startup-quote' }, rule.text),
        h(
          'p',
          null,
          mode === 'pause'
            ? 'It comes out of the file, so new chats will not see it. Tacit keeps a copy here and you can turn it back on with one click.'
            : 'It is deleted from the file. A backup of the whole file is kept, so you can still restore it from Changes.',
        ),
      ),
      confirm: mode === 'pause' ? 'Pause rule' : 'Remove rule',
      danger: mode === 'remove',
    });
    if (!ok) return;
    try {
      await api.post('/api/memory/rule', { path: file.path, line: rule.line, text: rule.text, mode, confirm: true });
      toast(mode === 'pause' ? 'Paused. New chats will not see this rule.' : 'Removed.');
      reload();
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  async function unpause(p) {
    try {
      const r = await api.post('/api/memory/unpause', { path: file.path, text: p.text, confirm: true });
      toast(r.status === 'already-there' ? 'That rule is already in the file.' : 'Turned back on.');
      reload();
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  const ruleInput = h('input', { class: 'input', type: 'text', placeholder: 'For example: Explain things in simple language.', 'aria-label': 'New rule', maxlength: '600', disabled: file.disabled || null });
  const sectionInput = h('input', { class: 'input', type: 'text', value: 'Working agreements', 'aria-label': 'Section heading', list: 'startup-sections', disabled: file.disabled || null });
  const sectionList = h('datalist', { id: 'startup-sections' }, [...sections.keys()].filter((k) => k !== 'No heading').map((k) => h('option', { value: k })));

  async function add(e) {
    e.preventDefault();
    if (!ruleInput.value.trim()) return ruleInput.focus();
    try {
      const r = await api.post('/api/memory/add', { path: file.path, text: ruleInput.value, section: sectionInput.value, confirm: true });
      if (r.status === 'added') toast('Added. The next new chat will see it.');
      else toast(`Not added. ${r.reason || ''} ${r.match ? `Existing: ${r.match}` : ''}`.trim());
      reload();
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  return h(
    'div',
    { class: 'startup-body' },
    h(
      'form',
      { class: 'startup-add', onsubmit: add },
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Add a rule'), ruleInput),
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Under the heading'), sectionInput, sectionList),
      h('button', { class: 'btn primary', type: 'submit', disabled: file.disabled || null }, icon('save'), 'Add rule'),
    ),
    file.rules.length
      ? [...sections.entries()].map(([name, rules]) =>
          h(
            'div',
            { class: 'startup-section' },
            h('h3', { class: 'section-title' }, name),
            h(
              'ul',
              { class: 'startup-rules' },
              rules.map((r) =>
                h(
                  'li',
                  null,
                  h('span', { class: 'startup-line num' }, String(r.line)),
                  h('span', { class: 'startup-rule-text' }, r.text, r.addedByTacit ? h('span', { class: 'chip rule' }, 'Added by Tacit') : null),
                  h(
                    'span',
                    { class: 'actions' },
                    h('button', { class: 'btn small ghost', type: 'button', disabled: off || null, onclick: () => take(r, 'pause') }, 'Pause'),
                    h('button', { class: 'btn small ghost', type: 'button', disabled: off || null, onclick: () => take(r, 'remove') }, 'Remove'),
                  ),
                ),
              ),
            ),
          ),
        )
      : h('p', { class: 'muted' }, file.exists ? 'No list-style rules in this file. Open Read to see all of it.' : 'No rules yet.'),
    file.parkedRules.length
      ? h(
          'div',
          { class: 'startup-section parked' },
          h('h3', { class: 'section-title' }, 'Paused rules'),
          h('p', { class: 'small muted', style: { margin: '0 0 8px' } }, 'Kept by Tacit, not in the file. New chats do not see these.'),
          h(
            'ul',
            { class: 'startup-rules' },
            file.parkedRules.map((p) =>
              h(
                'li',
                null,
                h('span', { class: 'startup-line' }, ''),
                h('span', { class: 'startup-rule-text' }, p.text, h('span', { class: 'muted small' }, ` paused ${ago(p.pausedAt)}${p.section ? `, from ${p.section}` : ''}`)),
                h('span', { class: 'actions' }, h('button', { class: 'btn small', type: 'button', disabled: off || null, onclick: () => unpause(p) }, 'Turn back on')),
              ),
            ),
          ),
        )
      : null,
  );
}

// ---------- Edit ----------

function editTab(file, reload) {
  const editor = h('textarea', { class: 'editor', spellcheck: 'false', 'aria-label': 'CLAUDE.md content' });
  editor.value = file.content;
  editor.rows = Math.min(30, Math.max(14, file.content.split('\n').length + 2));
  const diffBox = h('div');
  const counter = h('span', { class: 'muted small' }, `~${int(file.tokens)} tokens`);
  editor.addEventListener('input', () => {
    counter.textContent = `~${int(Math.ceil(editor.value.length / 3.6))} tokens${editor.value !== file.content ? ', not saved' : ''}`;
    mount(diffBox);
  });

  async function preview() {
    try {
      const r = await api.post('/api/memory/preview', { path: file.path, content: editor.value });
      mount(diffBox, diffView(r.diff, 'Your edit compared with the file now'));
      return r.diff;
    } catch (e) {
      toast(e.message, 'err');
      return null;
    }
  }

  async function save() {
    if (editor.value === file.content) return toast('Nothing has changed.');
    const diff = await preview();
    if (!diff) return;
    const ok = await confirmDialog({
      title: 'Save these changes?',
      body: h('div', null, diffView(diff), h('p', { class: 'muted small' }, 'The current file is copied to ~/.tacit/backups first, so you can restore it from Changes.')),
      confirm: 'Save',
    });
    if (!ok) return;
    try {
      await api.post('/api/memory/save', { path: file.path, content: editor.value, confirm: true });
      toast('Saved. The next new chat will read the new version.');
      reload();
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  return h(
    'div',
    null,
    editor,
    h(
      'div',
      { class: 'editor-foot' },
      counter,
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'btn ghost', type: 'button', onclick: () => ((editor.value = file.content), editor.dispatchEvent(new Event('input'))) }, 'Undo my edits'),
        h('button', { class: 'btn', type: 'button', onclick: preview }, 'Show changes'),
        h('button', { class: 'btn primary', type: 'button', onclick: save }, icon('save'), file.exists || file.disabled ? 'Save' : 'Create file'),
      ),
    ),
    h('div', { class: 'startup-body', style: { paddingTop: 0 } }, diffBox),
  );
}

// ---------- Changes ----------

function changesTab(file, reload) {
  const compareBox = h('div');

  async function compare(b) {
    try {
      const r = await api.post('/api/memory/compare', { path: file.path, backup: b.id });
      mount(compareBox, diffView(r.diff, `What restoring the backup from ${dateTime(b.ts)} would change`));
      compareBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  async function restore(b) {
    const ok = await confirmDialog({
      title: 'Restore this version?',
      body: h('p', null, `The file goes back to how it was on ${dateTime(b.ts)}. The current version is backed up first.`),
      confirm: 'Restore',
    });
    if (!ok) return;
    try {
      const r = await api.post('/api/memory/restore', { path: file.path, backup: b.id, confirm: true });
      toast(r.status === 'unchanged' ? 'The file already matches that version.' : 'Restored.');
      reload();
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  return h(
    'div',
    { class: 'startup-body' },
    h('p', { class: 'small muted', style: { margin: 0 } }, 'Every change Tacit made to this file, including rules saved from Repeats. Compare shows what restoring a backup would change. Restore puts it back.'),
    file.history.length
      ? h(
          'ol',
          { class: 'startup-history' },
          file.history.map((c) =>
            h(
              'li',
              null,
              h('span', { class: 'startup-when', title: dateTime(c.ts) }, ago(c.ts)),
              h('span', null, h('b', null, capitalize(c.action)), c.kind ? h('span', { class: ['chip', c.kind] }, c.kind) : null, c.text ? h('code', { class: 'startup-change-text' }, c.text) : null),
              c.backup ? backupButtons(file.backups.find((b) => b.path === c.backup), compare, restore) : h('span'),
            ),
          ),
        )
      : h('p', { class: 'muted' }, 'Tacit has not changed this file yet.'),
    file.backups.length
      ? h(
          'details',
          { class: 'startup-backups' },
          h('summary', null, `All backups (${file.backups.length})`),
          h('ul', null, file.backups.map((b) => h('li', null, h('span', null, dateTime(b.ts)), backupButtons(b, compare, restore)))),
        )
      : null,
    compareBox,
  );
}

function backupButtons(b, compare, restore) {
  if (!b) return h('span');
  return h(
    'span',
    { class: 'actions' },
    h('button', { class: 'btn small ghost', type: 'button', onclick: () => compare(b) }, 'Compare'),
    h('button', { class: 'btn small ghost', type: 'button', onclick: () => restore(b) }, 'Restore'),
  );
}

// ---------- diff ----------

function diffView(diff, caption) {
  const changed = diff.filter((d) => d.type === 'add' || d.type === 'del').length;
  return h(
    'figure',
    { class: 'startup-diff' },
    caption ? h('figcaption', { class: 'small muted' }, changed ? caption : `${caption}: no differences.`) : null,
    changed
      ? h(
          'pre',
          null,
          diff.map((d) => h('span', { class: `d-${d.type}` }, d.type === 'add' ? '+ ' : d.type === 'del' ? '− ' : '  ', d.type === 'skip' ? `… ${d.text}` : d.text)),
        )
      : null,
  );
}

function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

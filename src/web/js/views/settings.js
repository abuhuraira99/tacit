import { h, toast } from '../dom.js';
import { api } from '../api.js';
import { icon } from '../icons.js';

export const title = 'Settings';

export async function render() {
  const s = await api.get('/api/settings');
  const e = s.engines;

  const dir = h('input', { class: 'input', id: 'dir', value: s.projectsDir, spellcheck: 'false', style: { width: '100%', fontFamily: 'var(--mono)', fontSize: '13px' } });
  const engine = h(
    'select',
    { class: 'select', id: 'engine' },
    h('option', { value: 'auto' }, 'Automatic (API key if set, otherwise Claude Code)'),
    h('option', { value: 'api', disabled: e.api.sdkInstalled ? null : true }, `Claude API${e.api.sdkInstalled ? '' : ' (SDK not installed)'}`),
    h('option', { value: 'cli', disabled: e.cli.ready ? null : true }, `Claude Code${e.cli.ready ? '' : ' (not found)'}`),
    h('option', { value: 'none' }, 'Templates only, never call Claude'),
  );
  engine.value = s.engine;
  const model = h('select', { class: 'select', id: 'model' }, s.models.map((m) => h('option', { value: m.id }, m.label)));
  model.value = s.model;
  const key = h('input', { class: 'input', id: 'key', type: 'password', autocomplete: 'off', placeholder: s.hasSessionKey ? 'A key is set for this session' : 'sk-ant-…', style: { width: '100%' } });

  async function save() {
    try {
      const body = { projectsDir: dir.value, engine: engine.value, model: model.value };
      if (key.value.trim()) body.apiKey = key.value.trim();
      const r = await api.post('/api/settings', body);
      key.value = '';
      toast(r.rescan ? 'Saved. Reading the new folder.' : 'Saved.');
      if (r.rescan) location.hash = '#/';
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  async function forget() {
    await api.post('/api/settings', { clearKey: true });
    toast('The key is forgotten.');
    location.reload();
  }

  const status = (ok, text) => h('span', { class: ['chip', ok ? 'good' : ''] }, ok ? icon('check') : null, text);

  return h(
    'div',
    { class: 'page', style: { maxWidth: '820px' } },
    h('header', { class: 'page-head' }, h('div', null, h('h1', { class: 'page-title' }, 'Settings'), h('p', { class: 'page-lede' }, 'Tacit runs on your machine. Nothing here is sent anywhere unless you choose to refine a draft with Claude.'))),
    h(
      'section',
      { class: 'sheet panel stack' },
      h('h2', { class: 'panel-title' }, 'History folder'),
      h('div', { class: 'field' }, h('label', { for: 'dir' }, 'Claude Code transcripts'), dir, h('span', { class: 'hint' }, `Usually ${s.claudeHome}${s.claudeHome.includes('\\') ? '\\' : '/'}projects. Point it at another machine’s copy to analyse that instead.`)),
    ),
    h(
      'section',
      { class: 'sheet panel stack', style: { marginTop: '18px' } },
      h('h2', { class: 'panel-title' }, 'Refine with Claude'),
      h('p', { class: 'panel-sub', style: { margin: 0 } }, 'Optional. Tacit drafts everything from built-in templates. With Claude it can rewrite a draft to fit your words more closely; only that draft and the quotes behind it are sent.'),
      h('div', { class: 'row' }, status(e.api.ready, e.api.ready ? `Claude API ready (${e.api.keySource} key)` : e.api.sdkInstalled ? 'Claude API: add a key' : 'Claude API: SDK not installed'), status(e.cli.ready, e.cli.ready ? 'Claude Code found' : 'Claude Code not found')),
      h('div', { class: 'grid cols-2' }, h('div', { class: 'field' }, h('label', { for: 'engine' }, 'Engine'), engine), h('div', { class: 'field' }, h('label', { for: 'model' }, 'Model for the API'), model)),
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'key' }, 'Anthropic API key'),
        key,
        h('span', { class: 'hint' }, 'Kept in memory for this run only and never written to disk. You can also set ANTHROPIC_API_KEY before starting Tacit.'),
        s.hasSessionKey ? h('div', null, h('button', { class: 'btn small ghost', type: 'button', onclick: forget }, 'Forget the key')) : null,
      ),
    ),
    h('div', { class: 'row', style: { marginTop: '18px' } }, h('button', { class: 'btn primary', type: 'button', onclick: save }, icon('save'), 'Save settings')),
    h(
      'section',
      { class: 'sheet panel', style: { marginTop: '28px' } },
      h('h2', { class: 'panel-title' }, 'Privacy'),
      h(
        'ul',
        { class: 'small', style: { margin: 0, paddingLeft: '18px', color: 'var(--ink-2)' } },
        h('li', null, 'The app listens on 127.0.0.1 only and ignores requests from other sites.'),
        h('li', null, 'API keys, tokens, passwords and private keys found in your prompts are redacted before anything is shown or exported.'),
        h('li', null, 'Results are cached in ~/.tacit/cache so the next start is instant. Delete that folder at any time.'),
        h('li', null, 'Every file Tacit writes is backed up to ~/.tacit/backups first.'),
      ),
    ),
  );
}

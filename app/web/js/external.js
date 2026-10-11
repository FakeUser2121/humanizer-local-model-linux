// Model-server dialog. The real proxy lives in the launcher (internal/launcher/connection.go):
// the page only talks to the launcher, and the API key is sent to it once, stored on this computer,
// and never comes back to the page.
import { t } from './i18n.js';
import { getJSON, postJSON } from './api.js';

const $ = (id) => document.getElementById(id);
const E = { open: false, opener: null, st: null, keyDirty: false, clearKey: false, busy: false };
let hooks = { isRunning: () => false, onChange: () => {}, toast: () => {} };

const KIND_PLACEHOLDER = { llamacpp: 'http://127.0.0.1:8080', openai: 'http://localhost:1234/v1' };

/** A probe result → one human sentence. */
export function describeTest(r, kind) {
  kind = kind || document.getElementById?.('ext-kind')?.value || 'llamacpp';
  if (r.ok) {
    if (kind === 'llamacpp') {
      return {
        kind: 'ok',
        text: t('ext.testOkLlama', {
          model: r.model ? ` (${r.model})` : '',
          ctx: r.ctx_size ? `, ${r.ctx_size} ctx` : '',
        }),
      };
    }
    const n = r.models?.length || 0;
    return { kind: 'ok', text: n ? t('ext.testOk', { models: r.models.slice(0, 4).join(', ') + (n > 4 ? ' …' : '') }) : t('ext.testOkNoModels') };
  }
  switch (r.code) {
    case 'bad_url': return { kind: 'err', text: t('ext.badUrl') };
    case 'auth': return { kind: 'err', text: t('ext.errAuth') };
    case 'loading': return { kind: 'err', text: t('ext.testLoading') };
    case 'not_llamacpp': return { kind: 'err', text: t('ext.notLlama', { url: r.url || '', msg: r.message || '' }) };
    case 'unreachable': return { kind: 'err', text: t('ext.unreachable', { url: r.url || '' }) };
    default: return { kind: 'err', text: t('ext.errOther', { msg: r.message || r.code || '' }) };
  }
}

/** With no model name given, pick one from the list: a name containing "humanizer" first, else the only one. */
export function pickModel(models) {
  if (!Array.isArray(models) || !models.length) return '';
  return models.find((m) => /humanizer/i.test(m)) || (models.length === 1 ? models[0] : '');
}

function showResult(kind, text) {
  const el = $('ext-result');
  el.hidden = !text;
  el.className = 'ext-result' + (kind ? ' ' + kind : '');
  el.textContent = text || '';
}

function render() {
  const st = E.st || {};
  const kind = $('ext-kind').value;
  $('ext-key').placeholder = st.has_key && !E.clearKey ? t('ext.keySaved') : t('ext.keyPh');
  $('ext-key-clear').hidden = !st.has_key || E.clearKey;
  $('ext-model-field').hidden = kind !== 'openai'; // llama.cpp /completion ignores the model name
  $('ext-url').placeholder = KIND_PLACEHOLDER[kind];
  $('ext-note').textContent = t(kind === 'openai' ? 'ext.noteOpenAI' : 'ext.noteLlama');
  $('ext-disconnect').hidden = !st.enabled;
  const running = hooks.isRunning();
  $('ext-save').disabled = E.busy || running;
  $('ext-save').title = running ? t('ext.busyRunning') : '';
  $('ext-disconnect').disabled = E.busy || running;
  $('ext-test').disabled = E.busy;
  $('ext-test').classList.toggle('spinning', E.busy);
}

function fill(st) {
  E.st = st;
  E.keyDirty = false;
  E.clearKey = false;
  $('ext-kind').value = st.kind || 'llamacpp';
  $('ext-url').value = st.url || '';
  $('ext-model').value = st.model || '';
  $('ext-key').value = '';
  render();
}

function keyPayload() {
  if (E.clearKey) return '';
  if (E.keyDirty) return $('ext-key').value.trim();
  return undefined; // keep the saved one
}

async function test() {
  const kind = $('ext-kind').value;
  const url = $('ext-url').value.trim() || KIND_PLACEHOLDER[kind];
  if (!$('ext-url').value.trim()) $('ext-url').value = url;
  E.busy = true;
  render();
  showResult('', t('ext.testing'));
  let r;
  try {
    r = await postJSON('/app/server/test', { kind, url, api_key: keyPayload() }, { timeout: 15000 });
  } catch (e) {
    r = { ok: false, code: 'http', message: e.message };
  }
  E.busy = false;
  const d = describeTest(r, kind);
  showResult(d.kind, d.text);
  if (r.ok) {
    $('ext-models').replaceChildren(...(r.models || []).map((m) => Object.assign(document.createElement('option'), { value: m })));
    if (kind === 'openai' && !$('ext-model').value.trim()) $('ext-model').value = pickModel(r.models);
  }
  render();
  return r;
}

async function save() {
  if (hooks.isRunning()) return;
  const kind = $('ext-kind').value;
  const url = $('ext-url').value.trim();
  if (!url) { showResult('err', t('ext.badUrl')); $('ext-url').focus(); return; }
  const probe = await test(); // saved either way (the server may not be up yet), but say why it failed
  E.busy = true;
  render();
  try {
    const st = await postJSON('/app/server', { kind, url, model: kind === 'openai' ? $('ext-model').value.trim() : '', api_key: keyPayload() }, { timeout: 30000 });
    fill(st);
    hooks.onChange(st);
    if (probe?.ok) { hooks.toast(t('ext.savedOn'), 'ok'); openExternal(false); }
    else showResult('err', describeTest(probe || { ok: false, code: 'unreachable' }, kind).text + ' ' + t('ext.savedAnyway'));
  } catch (e) {
    showResult('err', t(e.message === 'bad url' ? 'ext.badUrl' : 'ext.errOther', { msg: e.message }));
  } finally {
    E.busy = false;
    render();
  }
}

async function disconnect() {
  if (hooks.isRunning()) return;
  E.busy = true;
  render();
  try {
    const st = await postJSON('/app/server', { disconnect: true });
    fill(st);
    hooks.onChange(st);
    hooks.toast(t('ext.savedOff'), 'ok');
    openExternal(false);
  } catch (e) {
    showResult('err', t('ext.errOther', { msg: e.message }));
  } finally {
    E.busy = false;
    render();
  }
}

export async function openExternal(open = true, opener = null) {
  if (open === E.open) return;
  E.open = open;
  $('ext').hidden = !open;
  $('ext-scrim').hidden = !open;
  if (open) {
    E.opener = opener || document.activeElement;
    showResult('', '');
    try { fill(await getJSON('/app/server')); } catch { fill({}); }
    requestAnimationFrame(() => (($('ext-url').value ? $('ext-close') : $('ext-url'))).focus({ preventScroll: true }));
  } else if (E.opener && document.contains(E.opener)) {
    E.opener.focus({ preventScroll: true });
  }
}

export function bindExternal(h) {
  hooks = { ...hooks, ...h };
  $('ext-close').addEventListener('click', () => openExternal(false));
  $('ext-scrim').addEventListener('click', () => openExternal(false));
  $('ext-test').addEventListener('click', () => test());
  $('ext-save').addEventListener('click', () => save());
  $('ext-disconnect').addEventListener('click', () => disconnect());
  $('ext-kind').addEventListener('change', () => { showResult('', ''); render(); });
  $('ext-key').addEventListener('input', () => { E.keyDirty = true; E.clearKey = false; render(); });
  $('ext-key-clear').addEventListener('click', () => { E.clearKey = true; E.keyDirty = false; $('ext-key').value = ''; render(); });
  for (const id of ['ext-url', 'ext-model', 'ext-key']) {
    $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && E.open) { e.stopPropagation(); openExternal(false); }
  }, true);
}

export const externalOpen = () => E.open;
export const refreshExternal = () => { if (E.open) render(); };

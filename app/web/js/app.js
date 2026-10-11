// Humanizer 网页主控:状态轮询 → 视图切换(首次下载 / 编辑器)→ 改写流式输出 → 差异与历史。
import { t, apply, setLang, getLang } from './i18n.js';
import { getJSON, postJSON, countTokens, streamCompletion, streamChat } from './api.js';
import { bindExternal, openExternal, refreshExternal } from './external.js';
import { buildPrompt, selfCheck, nPredictFor } from './prompt.js';
import { withLangGuard, langDrift } from './guard.js';
import { tokenize, diffTokens, markBits, factBits, renderRuns, flagNumbers } from './diff.js';
import { countText, isMostlyCJK, isLongDraft, numberCheck, fmtBytes, fmtDuration, fmtNum, escapeHTML, pyStrip } from './text.js';
import { loadHistory, addHistory, removeHistory, clearHistory, store } from './history.js';
import { planDocument, needsSections, approxTokens, documentSignature, newDocumentJob, readDocumentJob, jobMatches, jobDone, combinedDocument, runDocumentSections } from './document.js';
import { SAMPLES } from './samples.js';
import { activeFacts, protectFacts, restoreFacts, streamView, withFactGuard, FACT_TRIES } from './facts.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const IS_MAC = document.documentElement.classList.contains('mac');
const KEY_LABEL = IS_MAC ? '⌘ ↵' : 'Ctrl ↵';

const S = {
  protect: null, // 本次改写的占位符信息(Create fact),流式显示时用来换回原文
  docJob: readDocumentJob(store.get('document', 'null')), // 长文分段改写的断点(document.js)
  docPlanning: false,
  docSaveFailed: false,
  outPrefix: '', // 分段改写时已完成的各段,流式显示接在它后面
  retryable: false, // 上一次因为保留的文字没带过来而作废:允许直接点「重新生成」
  status: null,
  cfg: null,
  promptOK: false,
  view: null,
  forceSetup: false,
  running: false,
  abort: null,
  out: '',
  facts: [],
  result: null,
  showDiff: store.get('diff', '1') === '1',
  fails: 0,
  quit: false,
  autoRun: params.get('run') === '1',
  pollTimer: 0,
};

// ───────────────────────── 启动 ─────────────────────────
function init() {
  apply();
  markLang();
  $('go-kbd').textContent = KEY_LABEL;
  renderSamples();
  const ex = SAMPLES.find((s) => s.id === params.get('example'));
  $('draft').value = ex ? ex.draft : store.get('draft', '');
  try { S.facts = ex ? [] : JSON.parse(store.get('facts', '[]')); } catch { S.facts = []; }
  onDraftInput(false);
  setDiffToggle(S.showDiff);
  bind();
  // 刷新前有没改完的长文:显示已完成的段,进度条上点「继续改写」(或 ⌘↵)接着改
  if (S.docJob && jobDone(S.docJob)) discardDocumentJob();
  if (S.docJob) {
    showPartialDocument(S.docJob);
    showNotice('', t('document.restored'));
  }
  updateDocumentProgress();
  loadConfig();
  poll();
  if (params.get('panel') === 'history') openDrawer(true);
}

async function loadConfig() {
  for (let i = 0; i < 20 && !S.cfg; i++) {
    try {
      S.cfg = await getJSON('/app/config');
      S.promptOK = selfCheck(S.cfg);
      if (!S.promptOK) showNotice('err', t('out.promptMismatch'));
    } catch {
      await sleep(1000);
    }
  }
  updateGo();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 换档/重启引擎要先停掉旧的 llama-server(启动器最多等 5+3 秒),慢机器上会超过 postJSON 默认的 10 秒。
// 超时只是网页不再等,启动器照常做完,轮询会显示结果;这里放宽,免得白白弹一个超时提示。
const SLOW_POST_MS = 30000;

// ───────────────────────── 轮询状态 ─────────────────────────
async function poll() {
  clearTimeout(S.pollTimer);
  if (S.quit) return;
  let next = 4000;
  try {
    const st = await getJSON('/app/status', { timeout: 4000 });
    S.status = st;
    S.fails = 0;
    $('overlay').hidden = true;
    render();
    if (st.phase === 'setup') next = 2500;
    else if (st.external && st.external.reachable !== true) next = 2000;
    maybeAutoRun();
  } catch {
    S.fails++;
    if (S.fails >= 3 && !S.running) showOverlay(t('overlay.offTitle'), t('overlay.offMsg'), 'offline');
    next = 3000;
  }
  clearTimeout(S.pollTimer); // 可能有两次轮询同时在路上(切回标签页时),只留一个定时器
  S.pollTimer = setTimeout(poll, document.hidden ? Math.max(next, 15000) : next);
}

document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });

function render() {
  const st = S.status;
  if (!st) return;
  if (S.cfg && st.ctx_size > 0) S.cfg.ctx_size = st.ctx_size;
  const view = st.phase === 'setup' ? 'setup' : 'editor';
  if (view !== S.view) {
    S.view = view;
    $('view-setup').hidden = view !== 'setup';
    $('view-editor').hidden = view !== 'editor';
    if (view === 'editor') requestAnimationFrame(() => $('draft').focus({ preventScroll: true }));
    if (view === 'setup') { renderSetup(); if (!S.autoOpened) { S.autoOpened = true; openExternal(true); } }
  }
  renderStatus();
  renderBrand();
  if (!$('pop').hidden) renderPop();
  refreshExternal();
  updateGo();
}

// The configured model server (launcher: internal/launcher/connection.go).
// kind "llamacpp": native /completion + /tokenize (exact training prompt, real token counts)
// kind "openai":   streaming /chat/completions, token counts estimated from the text
const extOn = () => !!S.status?.external?.enabled;
const chatMode = () => extOn() && S.status.external.kind === 'openai';
const engineLabel = () => (S.status?.external?.model || S.status?.external?.server_model || (chatMode() ? 'OpenAI API' : 'llama.cpp'));
const engineId = () => (S.status?.external?.kind || 'llamacpp');

/** 外部服务的错误换成说人话的提示(连不上 / key 不对 / 模型名不对)。 */
function externalMessage(e) {
  const url = S.status?.external?.url || '';
  if (e.type === 'external_unreachable' || e.status === 502) return t('ext.errUnreachable', { url });
  if (e.status === 401 || e.status === 403) return t('ext.errAuth');
  if (e.status === 404 || /model/i.test(e.message)) return t('ext.errModel', { msg: e.message });
  return t('ext.errOther', { msg: e.message });
}

function renderBrand() {
  $('brand-tag').textContent = t('brand.tag', { tier: '12B' });
}

function renderStatus() {
  const st = S.status, el = $('status');
  const ext = st.external || {};
  let state = 'idle', text = '';
  if (st.phase !== 'ready') {
    text = t('status.setup');
  } else if (ext.reachable === null || ext.reachable === undefined) {
    state = 'busy'; text = t('status.checking');
  } else if (!ext.reachable) {
    if (ext.code === 'loading') { state = 'busy'; text = t('status.serverLoading'); }
    else if (ext.code === 'auth') { state = 'error'; text = t('status.serverAuth'); }
    else { state = 'error'; text = t('status.unreachable'); }
  } else {
    state = 'ready';
    text = S.running ? t('status.writing') : [t('status.ready'), engineLabel()].filter(Boolean).join(' · ');
  }
  el.dataset.state = state;
  el.classList.toggle('working', S.running);
  $('status-text').textContent = text;
}

// ───────────────────────── First run: connect to a server ─────────────────────────
function renderSetup() {
  $('setup-title').innerHTML = t('setup.title').replace(/\{([^}]+)\}/g, '<span class="ins">$1</span>');
}

// ───────────────────────── 弹出面板 ─────────────────────────
function renderPop() {
  const st = S.status;
  if (!st) return;
  const ext = st.external || {};
  $('pi-device').textContent = ext.url || '—';
  $('pi-model').textContent = ext.model || ext.server_model || '—';
  $('pi-engine').textContent = ext.enabled ? t(chatMode() ? 'ext.engine' : 'ext.engineLlama') : '—';
  const n = fmtNum(st.ctx_size, getLang());
  $('pi-ctx').textContent = chatMode() ? t('ext.ctxGuess', { n }) : t(st.ctx_detected ? 'ext.ctxDetected' : 'ext.ctxAssumed', { n });
  $('pi-version').textContent = st.version || '—';
  $('pi-idle').textContent = st.idle_exit_minutes > 0 ? t('menu.idle', { n: st.idle_exit_minutes }) : '';
}

function togglePop(force) {
  const pop = $('pop');
  const open = force ?? pop.hidden;
  pop.hidden = !open;
  $('status').setAttribute('aria-expanded', String(open));
  if (open) renderPop();
}

// ───────────────────────── 编辑器 ─────────────────────────
function renderSamples() {
  const box = $('sample-btns');
  box.replaceChildren(...SAMPLES.map((s) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sample-btn';
    b.textContent = s.label[getLang()] || s.label.en;
    b.addEventListener('click', () => { $('draft').value = s.draft; S.facts = []; onDraftInput(); $('draft').focus(); });
    return b;
  }));
}

let saveTimer = 0;
let importing = false;
function onDraftInput(save = true) {
  const v = $('draft').value;
  S.facts = activeFacts(S.facts, v);
  if (S.docJob && !jobMatches(S.docJob, v, S.facts)) discardDocumentJob();
  store.set('facts', JSON.stringify(S.facts));
  renderFacts();
  updateFactSelection();
  const c = countText(v);
  $('draft-count').innerHTML = v ? `${t('count.zh', { n: fmtNum(c.units, getLang()) })} · ${t('count.chars', { n: fmtNum(c.chars, getLang()) })}` : '';
  $('samples').hidden = v.trim() !== '';
  $('draft-long').hidden = !isLongDraft(v);
  $('draft').classList.toggle('cjk', isMostlyCJK(v));
  renderDraftMarks();
  updateGo();
  if (save) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => store.set('draft', v), 400);
  }
}

function updateGo() {
  const ready = S.status?.phase === 'ready' && S.promptOK;
  const has = pyStrip($('draft').value) !== '';
  const go = $('btn-go');
  go.disabled = !S.running && !(ready && has);
  go.classList.toggle('running', S.running);
  let label = t('go.label');
  if (S.running) label = t('go.stop');
  else if (S.status && S.status.phase !== 'ready') label = t('go.loading');
  $('go-label').textContent = label;
  go.setAttribute('aria-label', label);
  if (!importing) $('btn-upload').disabled = S.running;
  updateFactSelection();
  for (const button of $('facts-list').querySelectorAll('button')) button.disabled = S.running;
  $('btn-regen').disabled = S.running || !ready || !(S.result || S.retryable);
  $('btn-copy').disabled = S.running || !S.result || copyState === 'copying';
  renderCopyButton();
  $('btn-download-text').disabled = S.running || !S.result;
  updateDocumentProgress();
  refreshExternal();
  $('out-empty-sub').innerHTML = t('out.emptySub', { key: KEY_LABEL });
}

function showNotice(kind, html) {
  const n = $('out-notice');
  n.className = 'notice ' + kind;
  n.innerHTML = html;
  n.hidden = false;
}

// 草稿框一直能改:原样保留的文字和「被改掉的」(草稿还是上次改写用的那篇时)画在草稿框底下的标记层里。
function renderDraftMarks() {
  const ta = $('draft'), el = $('draft-marks');
  const text = ta.value, r = S.result;
  const showDel = !!(S.showDiff && r && r.diff && text === r.draft);
  const bits = new Uint8Array(text.length);
  if (showDel) markBits(r.aTok, r.diff.a, bits, 1);
  factBits(text, S.facts, bits, 2);
  renderRuns(el, text + '\n\u200b', bits, ['del', 'fact']); // 末尾多垫一行,标记层不会比草稿框矮、滚到底也对得上
  if (showDel) flagNumbers(el, r.nums.missing);
  el.className = 'textview' + (ta.classList.contains('cjk') ? ' cjk' : '');
  $('legend-del').hidden = !showDel;
  $('legend-fact').hidden = !S.facts.length;
  syncDraftMarks();
}

function syncDraftMarks() {
  const ta = $('draft'), el = $('draft-marks');
  el.style.width = ta.clientWidth + 'px';
  el.style.height = ta.clientHeight + 'px';
  el.scrollTop = ta.scrollTop;
  el.scrollLeft = ta.scrollLeft;
}

function maybeAutoRun() {
  if (S.autoRun && S.status?.phase === 'ready' && S.promptOK && pyStrip($('draft').value)) {
    S.autoRun = false;
    run();
  }
}

// 流式输出按帧合并渲染。注意:改写结束后可能还有一帧没跑(后台标签页里 rAF 会被推迟),
// 它不能再把带高亮的结果覆盖成纯文本 —— 所以结束时取消,回调里也再查一次。
// 分段改写时 S.outPrefix 是已经完成的各段(按原文空白拼好),正在写的这段接在后面。
let renderRaf = 0;
function scheduleStreamRender() {
  if (renderRaf) return;
  renderRaf = requestAnimationFrame(() => {
    renderRaf = 0;
    if (!S.running) return;
    const out = $('output');
    const nearBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 80;
    const caret = document.createElement('span');
    caret.className = 'caret';
    const shown = S.outPrefix + (S.protect ? streamView(S.out, S.protect) : S.out);
    out.replaceChildren(shown.replace(/^\s+/, ''), caret);
    out.classList.toggle('cjk', isMostlyCJK(shown));
    $('out-empty').hidden = true;
    if (nearBottom) out.scrollTop = out.scrollHeight;
    const c = countText(shown);
    $('out-count').innerHTML = t('count.zh', { n: fmtNum(c.units, getLang()) });
  });
}

function cancelStreamRender() {
  if (renderRaf) { cancelAnimationFrame(renderRaf); renderRaf = 0; }
}

// 「读稿中」提示;分段改写时前面先显示已经完成的段。
function showReading(note, p) {
  const prefix = S.outPrefix ? escapeHTML(S.outPrefix.replace(/^\s+/, '')) : '';
  $('output').innerHTML = `${prefix}<span class="reading">${note ? escapeHTML(note) : t('out.reading', { p })}</span>`;
}

// token 数:引擎 /tokenize(不加 BOS)。停止 / 超时照常抛出;其他错误(比如接口不可用)退回按字数估算。
// OpenAI-compatible servers have no /tokenize: estimate from the text (conservative).
async function tokensOf(text, signal) {
  if (chatMode()) return approxTokens(text);
  try { return await countTokens(text, { signal }); } catch (e) {
    if (signal?.aborted || e.name === 'AbortError' || e.name === 'TimeoutError') throw e;
    return approxTokens(text);
  }
}

/**
 * 改写一篇草稿(单篇,或长文里的一段)。同一提示词、同一采样参数,单篇和分段走的是这同一个函数:
 *  - 语言保险(guard.js):英文草稿写着写着成了中文,当场掐掉、同样参数静默重采,最多 3 次;最后一次照常交出。
 *  - Create fact(facts.js):写完核对占位符,丢了/改了/重复了就整篇重写,最多 FACT_TRIES 次;都不行就作废。
 * 返回 withFactGuard 的结果 { ok, text, tries, final }。用户停止抛 AbortError。
 */
async function generate(draft, pd, nPred, signal) {
  const body = {
    ...S.cfg.sampling,
    prompt: buildPrompt(S.cfg, pd.text),
    n_predict: nPred,
    stream: true,
    cache_prompt: true,
    return_progress: true,
  };
  // 外部服务:同样的草稿(带占位符)作为唯一一条 user 消息,不带 system;GGUF 自带的模板拼出同一个提示词。
  // 采样参数和自带引擎一样(temperature 1.0、top_p 0.95,其余关掉),和 docs/USAGE.md 第 8 节一致。
  const ext = chatMode() ? S.status.external : null;
  const chatBody = ext && {
    ...(ext.model ? { model: ext.model } : {}),
    messages: [{ role: 'user', content: pyStrip(pd.text) }],
    ...S.cfg.sampling,
    max_tokens: nPred,
    stream: true,
  };
  const open = (sig) => (ext ? streamChat(chatBody, sig) : streamCompletion(body, sig));
  const locked = pd.locks.length > 0;
  S.protect = locked ? pd : null;
  let note = '';
  const attempt = async (i, isLast) => {
    if (signal.aborted) throw new DOMException('stopped', 'AbortError');
    const ctl = new AbortController();
    const onStop = () => ctl.abort();
    signal.addEventListener('abort', onStop);
    let fin = null, drifted = false;
    S.out = '';
    if (i > 0) showReading(note, 0);
    try {
      for await (const ev of open(ctl.signal)) {
        if (ev.prompt_progress && !S.out) {
          const pp = ev.prompt_progress;
          showReading(note, pp.total ? Math.round((100 * pp.processed) / pp.total) : 0);
        }
        if (ev.content) {
          S.out += ev.content;
          if (!isLast && langDrift(draft, locked ? restoreFacts(S.out, pd, false) : S.out, false)) { drifted = true; ctl.abort(); break; }
          scheduleStreamRender();
        }
        if (ev.stop) { fin = ev; break; }
      }
    } catch (e) {
      if (!(drifted && e.name === 'AbortError' && !signal.aborted)) throw e;
    } finally {
      signal.removeEventListener('abort', onStop);
    }
    if (drifted) {
      cancelStreamRender();
      showReading(note, 0);
    }
    return { text: locked ? restoreFacts(S.out, pd, false) : S.out, final: fin, drifted };
  };
  return withFactGuard(pd, async () => {
    const res = await withLangGuard(draft, attempt);
    return { raw: S.out, final: res.final };
  }, FACT_TRIES, (n, m) => {
    cancelStreamRender();
    note = t('facts.retrying', { n, m });
    showReading(note, 0);
  });
}

// 开始一次改写(单篇或分段):清掉上一次的结果和提示。
function beginRun() {
  togglePop(false);
  closeNumbers();
  S.running = true;
  S.abort = new AbortController();
  S.out = '';
  S.outPrefix = '';
  S.result = null;
  renderDraftMarks();
  $('out-notice').hidden = true;
  $('chip-numbers').hidden = true;
  $('out-facts').hidden = true;
  $('out-stats').textContent = '';
  $('out-count').textContent = '';
  $('out-empty').hidden = true;
  $('output').classList.remove('cjk');
  showReading('', 0);
  updateGo();
  renderStatus();
}

async function run() {
  if (S.running) { stop(); return; }
  const draft = $('draft').value;
  if (!pyStrip(draft)) return;
  if (!S.promptOK || !S.cfg) { showNotice('err', t('out.promptMismatch')); return; }
  // 外部服务的开关、存储位置可能刚在别处改过(另一个标签页、后台标签页轮询慢),先对一次状态,
  // 免得按旧状态把请求发到已经不存在的接口(0.3.4 真机测出:关掉外部服务后旧页面报「外部服务 404」)
  if (S.checking) return;
  S.checking = true;
  try { S.status = await getJSON('/app/status', { timeout: 3000 }); render(); } catch { /* 连不上就按手上的状态走 */ } finally { S.checking = false; }
  if (S.running) return;
  if (S.status?.phase !== 'ready') { toast(t('out.notReady')); return; }
  // 这篇草稿有没改完的分段进度(停止过、出过错、刷新过页面):接着改,已完成的段不再送进引擎
  if (resumableJob(draft)) { await runDocument(draft, true); return; }

  const protectedDraft = protectFacts(draft, S.facts);
  beginRun();

  const t0 = performance.now();
  const runSignal = S.abort.signal;
  let final = null, error = null, aborted = false, factsLost = false, factTries = 0, sectioned = false;
  try {
    const nTok = await tokensOf(pyStrip(draft), runSignal);
    const promptTokens = await tokensOf(buildPrompt(S.cfg, protectedDraft.text), runSignal);
    if (runSignal.aborted) throw runSignal.reason;
    // 长草稿(输出可能顶到上限,或者放不进上下文)自动分段;其余草稿走下面原来的单篇流程,一点不变
    if (needsSections(S.cfg, nTok, promptTokens)) sectioned = true;
    else {
      const fg = await generate(draft, protectedDraft, nPredictFor(S.cfg, nTok), runSignal);
      final = fg.final;
      if (protectedDraft.locks.length) {
        if (fg.ok) { S.out = fg.text; factTries = fg.tries; } else { factsLost = true; S.out = ''; }
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') aborted = true;
    else if (e.name === 'TimeoutError') error = Object.assign(new Error(t('out.requestTimeout')), { notice: true });
    else if (e.external) error = Object.assign(new Error(externalMessage(e)), { notice: true });
    else error = e;
    if (S.protect) S.out = ''; // 有保护段时,没核对过的半截结果不显示(可能缺原文)
  }
  S.running = false;
  S.abort = null;
  S.protect = null;
  cancelStreamRender();
  if (sectioned && !aborted && !error) { await runDocument(draft, false); return; }
  S.retryable = factsLost;
  const secs = (performance.now() - t0) / 1000;
  const text = S.out.trim();

  if (error && !text) {
    $('output').replaceChildren();
    $('out-empty').hidden = false;
    showNotice('err', error.notice ? escapeHTML(error.message) : t('out.failed', { msg: escapeHTML(error.message) }));
  } else if (!text) {
    $('output').replaceChildren();
    $('out-empty').hidden = false;
    $('out-count').textContent = '';
    if (aborted) showNotice('', t('out.stopped'));
    else if (factsLost) showNotice('warn', t('facts.failed', { n: FACT_TRIES }));
  } else {
    S.result = makeResult(draft, text, protectedDraft.facts);
    if (final) {
      const tok = final.tokens_predicted || 0;
      const tps = final.timings?.predicted_per_second;
      $('out-stats').textContent = t('out.stats', { tok: fmtNum(tok, getLang()), tps: tps ? tps.toFixed(1) : '—', sec: secs.toFixed(1) });
      if (final.stop_type === 'limit') showNotice('warn', t('out.truncated', { n: final.tokens_predicted }));
      else if (factTries > 1) showNotice('', t('facts.retried', { n: factTries }));
      addHistory({
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        t: Date.now(), draft, facts: protectedDraft.facts, out: text, tier: engineId(), tierLabel: engineLabel(), tok, tps,
        ratio: S.result.diff ? S.result.diff.ratio : null, stop: final.stop_type,
      });
    } else if (aborted) {
      showNotice('', t('out.stopped'));
    } else if (error) {
      showNotice('err', t('out.failed', { msg: escapeHTML(error.message) }));
    }
    renderResult();
  }
  updateGo();
  renderStatus();
}

// ───────────────────────── 长文分段改写(document.js)─────────────────────────
// 断点存在浏览器 localStorage(hz.document),每完成一段存一次;草稿或保留段一改就作废,模型/设置变了不能接着用。
// 分段改写进行中草稿框只读(停止后恢复),免得改到一半的草稿和断点对不上。
const engineSignature = () => documentSignature(S.cfg, `${S.status?.external?.kind}|${S.status?.external?.url}|${S.status?.external?.model || ''}`);

function resumableJob(draft) {
  const job = S.docJob;
  return !!(job && S.cfg && !jobDone(job) && jobMatches(job, draft, S.facts, engineSignature())) && job;
}

function updateDocumentProgress() {
  const job = S.docJob, panel = $('document-progress');
  panel.hidden = !job && !S.docPlanning;
  if (panel.hidden) return;
  const done = job?.outputs.length || 0, total = job?.parts.length || 0;
  const meter = $('document-meter');
  meter.max = Math.max(1, total);
  if (S.docPlanning) meter.removeAttribute('value'); else meter.value = done;
  const stale = !!(job && S.cfg && S.status && job.signature !== engineSignature());
  const key = S.docPlanning ? 'document.planning' : S.running ? 'document.section' : stale ? 'document.stale' : 'document.paused';
  $('document-status').textContent = t(key, { n: fmtNum(Math.min(done + 1, total), getLang()), done: fmtNum(done, getLang()), total: fmtNum(total, getLang()) });
  const ready = S.status?.phase === 'ready' && S.promptOK;
  $('btn-document-resume').hidden = S.running || !job || stale;
  $('btn-document-resume').disabled = !ready;
  $('btn-document-restart').hidden = S.running || !job;
  $('btn-document-restart').disabled = !ready;
}

function discardDocumentJob() {
  if (!S.docJob) return;
  const showingPartial = !S.result && !S.running;
  S.docJob = null;
  store.set('document', 'null');
  if (showingPartial) {
    $('output').replaceChildren();
    $('out-empty').hidden = false;
    $('out-notice').hidden = true;
    $('out-count').textContent = '';
  }
  updateDocumentProgress();
}

function saveDocumentJob(job) {
  S.docJob = job;
  store.set('draft', job.draft);
  store.set('facts', JSON.stringify(job.facts));
  const saved = JSON.stringify(job);
  store.set('document', saved);
  S.docSaveFailed = store.get('document') !== saved; // 无痕模式 / 存储满 / localStorage 不可用:只在这个页面里能接着改
}

function lockDraft(on) {
  const ta = $('draft');
  ta.readOnly = on;
  ta.classList.toggle('locked', on);
  ta.title = on ? t('document.locked') : '';
  $('btn-clear').disabled = on;
  $('btn-paste').disabled = on;
  for (const button of $('sample-btns').querySelectorAll('button')) button.disabled = on;
}

function showPartialDocument(job) {
  const text = job ? combinedDocument(job) : '';
  $('output').textContent = text.replace(/^\s+/, '');
  $('output').classList.toggle('cjk', isMostlyCJK(text));
  $('out-empty').hidden = !!text;
  $('out-count').innerHTML = text ? t('count.zh', { n: fmtNum(countText(text).units, getLang()) }) : '';
}

async function runDocument(draft, resume) {
  const facts = activeFacts(S.facts, draft);
  const signature = engineSignature();
  let job = resume ? resumableJob(draft) : null;
  beginRun();
  S.retryable = false;
  S.docPlanning = !job;
  S.docSaveFailed = false;
  lockDraft(true);
  if (job) { S.outPrefix = combinedDocument(job); showReading('', 0); }
  updateDocumentProgress();
  const signal = S.abort.signal;
  const t0 = performance.now();
  let tok = 0, genSecs = 0, error = null, aborted = false, text = '';
  try {
    if (!job) {
      discardDocumentJob();
      const parts = await planDocument(draft, facts, S.cfg, (s, o) => tokensOf(s, o?.signal), signal);
      job = newDocumentJob(draft, facts, signature, parts);
      saveDocumentJob(job);
    }
    S.docPlanning = false;
    updateDocumentProgress();
    text = await runDocumentSections(job, async (part, jobFacts, sig, i) => {
      S.outPrefix = combinedDocument(job) + job.parts[i].before;
      S.out = '';
      showReading('', 0);
      const pd = protectFacts(part, jobFacts);
      const nTok = await tokensOf(pyStrip(part), sig);
      const fg = await generate(part, pd, nPredictFor(S.cfg, nTok), sig);
      S.protect = null;
      if (!fg.ok) throw new Error('factsLost');
      if (!fg.final || fg.final.stop_type === 'limit') throw new Error('documentIncomplete');
      const n = fg.final.tokens_predicted || 0, tps = fg.final.timings?.predicted_per_second;
      tok += n;
      if (tps) genSecs += n / tps;
      return fg.text;
    }, {
      signal,
      onProgress: () => updateDocumentProgress(),
      onCommit: (j) => saveDocumentJob(j),
    });
  } catch (e) {
    if (e.name === 'AbortError') aborted = true;
    else error = e;
  }
  S.running = false;
  S.abort = null;
  S.protect = null;
  S.docPlanning = false;
  S.outPrefix = '';
  S.out = '';
  cancelStreamRender();
  lockDraft(false);
  const storageNote = S.docSaveFailed ? ' ' + t('document.storage') : '';
  if (!aborted && !error) {
    const secs = (performance.now() - t0) / 1000;
    const tps = genSecs > 0 ? tok / genSecs : 0;
    S.docJob = null; // 做完了:断点清掉,结果进历史
    store.set('document', 'null');
    S.result = makeResult(draft, text, facts);
    $('out-stats').textContent = t('out.stats', { tok: fmtNum(tok, getLang()), tps: tps ? tps.toFixed(1) : '—', sec: secs.toFixed(1) });
    addHistory({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      t: Date.now(), draft, facts, out: text, tier: engineId(), tierLabel: engineLabel(), tok, tps: tps || undefined,
      ratio: S.result.diff ? S.result.diff.ratio : null, stop: 'eos', sections: job.parts.length,
    });
    renderResult();
    const tooBig = S.showDiff && !S.result.diff ? ' ' + t('diff.tooBig') : '';
    showNotice('', t('document.review', { n: fmtNum(job.parts.length, getLang()) }) + tooBig);
  } else {
    showPartialDocument(S.docJob);
    let msg;
    if (aborted) msg = S.docJob?.outputs.length ? t('document.stopped', { key: KEY_LABEL }) : t('out.stopped');
    else if (error.name === 'TimeoutError') msg = t('out.requestTimeout');
    else if (error.external) msg = escapeHTML(externalMessage(error));
    else if (DOC_ERRORS[error.message]) msg = t(DOC_ERRORS[error.message], { n: FACT_TRIES });
    else msg = t('out.failed', { msg: escapeHTML(error.message) });
    if (!aborted && S.docJob) msg += ' ' + t(S.docJob.outputs.length ? 'document.resumeHint' : 'document.retryHint');
    showNotice(aborted ? '' : 'warn', msg + storageNote);
  }
  updateDocumentProgress();
  updateGo();
  renderStatus();
}

const DOC_ERRORS = { factsLost: 'document.factFailed', documentIncomplete: 'document.incomplete', documentContext: 'document.context', documentEmpty: 'document.context' };

function downloadText() {
  const r = S.result;
  if (!r || S.running) return;
  const url = URL.createObjectURL(new Blob([r.out], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'humanizer-rewrite.txt';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function stop() {
  if (S.abort) S.abort.abort();
}

function makeResult(draft, out, facts = []) {
  const aTok = tokenize(draft), bTok = tokenize(out);
  const diff = diffTokens(aTok, bTok);
  return { draft, out, aTok, bTok, diff, nums: numberCheck(draft, out), facts: facts.filter((f) => out.includes(f)) };
}

function renderResult() {
  const r = S.result;
  if (!r) return;
  const out = $('output');
  out.classList.toggle('cjk', isMostlyCJK(r.out));
  $('out-empty').hidden = true;
  // 改写侧:新写的词(显示改动时)+ 原样保留的文字;草稿侧的「被改掉的」在 renderDraftMarks 里画
  const bits = new Uint8Array(r.out.length);
  if (S.showDiff && r.diff) markBits(r.bTok, r.diff.b, bits, 1);
  factBits(r.out, r.facts, bits, 2);
  renderRuns(out, r.out, bits, ['ins', 'fact']);
  renderDraftMarks();
  if (S.showDiff && !r.diff) showNotice('', t('diff.tooBig'));

  const c = countText(r.out);
  let meta = t('count.zh', { n: fmtNum(c.units, getLang()) });
  if (r.diff) meta += ' · ' + t('out.changed', { p: Math.round(r.diff.ratio * 100) });
  $('out-count').innerHTML = meta;

  $('out-facts').hidden = !r.facts.length;
  $('out-facts-text').textContent = t('facts.kept', { n: r.facts.length });

  const chip = $('chip-numbers');
  if (r.nums.total) {
    const ok = r.nums.missing.length === 0;
    chip.hidden = false;
    chip.className = 'chip ' + (ok ? 'ok' : 'warn');
    chip.innerHTML = `<svg><use href="#${ok ? 'i-check' : 'i-hash'}"/></svg>` +
      (ok ? t('num.ok', { n: r.nums.total }) : t('num.warn', { k: r.nums.missing.length }));
  } else {
    chip.hidden = true;
  }
  updateGo();
}

function setDiffToggle(on) {
  S.showDiff = on;
  store.set('diff', on ? '1' : '0');
  $('btn-diff').setAttribute('aria-pressed', String(on));
}

function openNumbers() {
  const r = S.result;
  if (!r || !r.nums.missing.length) return;
  const pop = $('numbers-pop');
  pop.innerHTML = `<div>${t('num.popTitle')}</div><div class="nums">${r.nums.missing.map((n) => `<span>${escapeHTML(n)}</span>`).join('')}</div><div>${t('num.popBody')}</div>`;
  pop.hidden = false;
  const rc = $('chip-numbers').getBoundingClientRect();
  pop.style.left = Math.max(12, Math.min(rc.left, innerWidth - pop.offsetWidth - 12)) + 'px';
  pop.style.top = Math.max(12, rc.top - pop.offsetHeight - 10) + 'px';
}

function closeNumbers() { $('numbers-pop').hidden = true; }

let copyState = 'idle';
let copyTimer = 0;
let copiedResult = null;

function renderCopyButton() {
  if (copyState === 'copied' && copiedResult !== S.result) { clearTimeout(copyTimer); copyState = 'idle'; }
  const b = $('btn-copy');
  b.classList.toggle('done', copyState === 'copied');
  b.setAttribute('aria-busy', String(copyState === 'copying'));
  b.querySelector('span').textContent = t(copyState === 'copying' ? 'out.copying' : copyState === 'copied' ? 'out.copied' : 'out.copy');
  b.querySelector('use').setAttribute('href', copyState === 'copied' ? '#i-check' : '#i-copy');
}

async function copyOut() {
  const r = S.result;
  if (!r || S.running || copyState === 'copying') return;
  clearTimeout(copyTimer);
  copyState = 'copying';
  updateGo(); // Acknowledge the click before waiting for the clipboard permission/write.
  let copied = false;
  try {
    await navigator.clipboard.writeText(r.out);
    copied = true;
  } catch {
    const focus = document.activeElement;
    const ta = document.createElement('textarea');
    ta.value = r.out;
    ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0';
    document.body.append(ta);
    try {
      ta.select();
      copied = document.execCommand('copy');
    } catch { /* Report failure below if both clipboard methods fail. */ }
    finally { ta.remove(); focus?.focus({ preventScroll: true }); }
  }
  copiedResult = r;
  copyState = copied ? 'copied' : 'idle';
  updateGo();
  toast(t(copied ? 'out.copied' : 'out.copyFailed'), copied ? 'ok' : 'err');
  if (copied) copyTimer = setTimeout(() => {
    copyState = 'idle';
    renderCopyButton();
  }, 3000);
}

// ───────────────────────── 历史 ─────────────────────────
function renderHistory() {
  const list = loadHistory();
  $('history-count').textContent = list.length ? String(list.length) : '';
  $('hist-empty').hidden = list.length > 0;
  $('btn-history-clear').hidden = list.length === 0;
  const ol = $('hist');
  ol.replaceChildren(...list.map((h) => {
    const li = document.createElement('li');
    const when = new Date(h.t).toLocaleString(getLang() === 'zh' ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const tier = h.tierLabel || h.tier || '';
    const words = countText(h.out).units;
    const ratio = typeof h.ratio === 'number' ? ` · ${Math.round(h.ratio * 100)}%` : '';
    li.innerHTML = `<div class="hist-meta"><span>${escapeHTML(when)}</span><span>·</span><span>${escapeHTML(tier)}</span><span>·</span><span>${t('count.zh', { n: words }).replace(/<\/?b>/g, '')}${ratio}</span></div>
      <div class="hist-text"></div>
      <button class="hist-del" type="button" aria-label="delete"><svg><use href="#i-close"/></svg></button>`;
    li.querySelector('.hist-text').textContent = h.out.slice(0, 220);
    li.addEventListener('click', () => restore(h));
    li.querySelector('.hist-del').addEventListener('click', (ev) => { ev.stopPropagation(); removeHistory(h.id); renderHistory(); });
    return li;
  }));
}

function restore(h) {
  if (S.running) return;
  $('draft').value = h.draft;
  S.facts = activeFacts(h.facts, h.draft);
  onDraftInput();
  $('out-notice').hidden = true;
  $('out-stats').textContent = h.tok ? `${fmtNum(h.tok, getLang())} tokens` + (h.tps ? ` · ${h.tps.toFixed(1)} tok/s` : '') : '';
  S.result = makeResult(h.draft, h.out, h.facts || []);
  renderResult();
  openDrawer(false);
  toast(t('history.restored'));
}

function openDrawer(open) {
  const d = $('drawer');
  if (open) renderHistory();
  d.classList.toggle('open', open);
  d.setAttribute('aria-hidden', String(!open));
  $('scrim').hidden = !open;
}

// ───────────────────────── 杂项 ─────────────────────────
let toastTimer = 0;
/** kind:'' 普通(1.8 秒)、'ok' 成功(3 秒)、'err' 出错(带红点,5 秒,长句也读得完) */
function toast(msg, kind = '') {
  const el = $('toast');
  el.textContent = msg;
  el.dataset.kind = kind;
  el.setAttribute('role', kind === 'err' ? 'alert' : 'status');
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), kind === 'err' ? 5000 : kind === 'ok' ? 3000 : 1800);
}

function showOverlay(title, msg, kind) {
  $('overlay-title').textContent = title;
  $('overlay-msg').textContent = msg;
  $('overlay').hidden = false;
  $('overlay').dataset.kind = kind;
}

function markLang() {
  for (const b of document.querySelectorAll('[data-lang]')) b.setAttribute('aria-pressed', String(b.dataset.lang === getLang()));
}

function effectiveTheme() {
  const a = document.documentElement.getAttribute('data-theme');
  if (a) return a;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

// ───────────────────────── 导入 .docx / .pdf ─────────────────────────
// 文件交给启动器(/app/document)在本机提取文字,不存盘;提取完草稿若已被改动就不覆盖。
const IMPORT_ERRORS = ['uploadInvalid', 'uploadLarge', 'uploadEmpty', 'uploadUnreadable', 'uploadGarbled'];

function setImporting(on) {
  importing = on;
  const b = $('btn-upload');
  b.disabled = on || S.running;
  b.classList.toggle('busy', on);
  b.setAttribute('aria-busy', String(on));
  b.querySelector('use').setAttribute('href', on ? '#i-spin' : '#i-import');
  b.querySelector('span').textContent = t(on ? 'draft.uploadLoading' : 'draft.upload');
}

async function importDocument(file) {
  if (importing || S.running) return;
  if (!/\.(docx|pdf)$/i.test(file.name)) { toast(t('draft.uploadInvalid'), 'err'); return; }
  if (file.size > 20 * 1024 * 1024) { toast(t('draft.uploadLarge'), 'err'); return; }
  if ($('draft').value.trim() && !confirm(t('draft.uploadReplace', { name: file.name }))) return;
  const original = $('draft').value;
  setImporting(true);
  try {
    const body = new FormData();
    body.append('file', file);
    const response = await fetch('/app/document', { method: 'POST', headers: { 'X-Humanizer': '1' }, body });
    let result = {};
    try { result = await response.json(); } catch { /* 不是 JSON */ }
    if (!response.ok) throw new Error(result.error || 'uploadUnreadable');
    // 提取期间用户改了草稿,或者开始改写了:不覆盖
    if (S.running || $('draft').value !== original) { toast(t('draft.uploadChanged'), 'err'); return; }
    $('draft').value = result.text;
    S.facts = [];
    onDraftInput();
    store.set('draft', result.text);
    $('draft').scrollTop = 0;
    $('draft').setSelectionRange(0, 0);
    toast(t('draft.uploadDone', { name: file.name, n: fmtNum(countText(result.text).units, getLang()) }), 'ok');
  } catch (error) {
    toast(t('draft.' + (IMPORT_ERRORS.includes(error.message) ? error.message : 'uploadUnreadable')), 'err');
  } finally {
    setImporting(false);
  }
}

// 把文件拖到草稿上导入;拖到页面别处松手也不能让浏览器直接打开文件(那会离开 App)。
function bindDrop() {
  const sheet = $('sheet-draft'), zone = $('dropzone');
  const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
  let depth = 0;
  const hide = () => { depth = 0; zone.hidden = true; };
  sheet.addEventListener('dragenter', (e) => {
    if (!hasFiles(e) || S.running || importing) return;
    e.preventDefault();
    depth++;
    zone.hidden = false;
  });
  sheet.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = S.running || importing ? 'none' : 'copy';
  });
  sheet.addEventListener('dragleave', (e) => { if (hasFiles(e) && --depth <= 0) hide(); });
  sheet.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    hide();
    const file = e.dataTransfer.files[0];
    if (file) importDocument(file);
  });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => { if (hasFiles(e)) { e.preventDefault(); hide(); } });
  window.addEventListener('dragend', hide);
}

// ───────────────────────── Create fact:选中的文字改写时一字不改 ─────────────────────────
function selectedFact() {
  const draft = $('draft');
  return S.running ? '' : draft.value.slice(draft.selectionStart, draft.selectionEnd).trim();
}

// 选区在草稿框里的坐标:用一个同样排版的隐藏镜像算(textarea 不给选区坐标)
const MIRROR = ['boxSizing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle',
  'fontVariationSettings', 'letterSpacing', 'lineHeight', 'textTransform', 'wordSpacing', 'textIndent', 'tabSize'];
function caretXY(ta, pos) {
  const cs = getComputedStyle(ta);
  const m = document.createElement('div');
  for (const p of MIRROR) m.style[p] = cs[p];
  Object.assign(m.style, { position: 'absolute', visibility: 'hidden', top: '0', left: '-9999px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', width: ta.clientWidth + 'px', border: '0' });
  m.textContent = ta.value.slice(0, pos);
  const mark = document.createElement('span');
  mark.textContent = '\u200b';
  m.append(mark);
  document.body.append(m);
  const r = { x: mark.offsetLeft, y: mark.offsetTop - ta.scrollTop, h: parseFloat(cs.lineHeight) || 26 };
  m.remove();
  return r;
}

function placeFactPop() {
  const ta = $('draft'), pop = $('btn-create-fact');
  const w = pop.offsetWidth, h = pop.offsetHeight, W = ta.clientWidth, H = ta.clientHeight;
  let x = W - w - 16, y = H - h - 12; // 草稿特别长时不算坐标,放右下角
  if (ta.value.length < 60000) {
    const a = caretXY(ta, ta.selectionStart), b = caretXY(ta, ta.selectionEnd);
    x = (a.y === b.y ? (a.x + b.x) / 2 : a.x + 60) - w / 2;
    y = a.y - h - 6; // 选区第一行上方;太靠上就放到最后一行下方
    if (y < 6) y = b.y + b.h + 4;
  }
  pop.style.left = Math.round(Math.min(Math.max(x, 10), W - w - 10)) + 'px';
  pop.style.top = Math.round(Math.min(Math.max(y, 6), H - h - 6)) + 'px';
}

function updateFactSelection() {
  const pop = $('btn-create-fact');
  const selected = selectedFact();
  const focused = document.activeElement === $('draft') || document.activeElement === pop;
  const show = !!selected && focused;
  pop.hidden = !show;
  if (!show) return;
  const kept = S.facts.includes(selected);
  pop.disabled = S.running || kept;
  pop.querySelector('span').textContent = t(kept ? 'facts.already' : 'facts.create');
  placeFactPop();
}

function renderFacts(fresh = '') {
  // 草稿有字就常驻这一条:没保留任何文字时显示用法提示,让人知道有这个功能
  $('facts-panel').hidden = !S.facts.length && !pyStrip($('draft').value);
  $('facts-hint').hidden = S.facts.length > 0;
  $('facts-count').textContent = S.facts.length > 1 ? String(S.facts.length) : '';
  $('facts-list').replaceChildren(...S.facts.map((fact) => {
    const li = document.createElement('li');
    li.className = 'fact-chip' + (fact === fresh ? ' new' : '');
    li.title = fact;
    const text = document.createElement('span');
    text.className = 'fact-text';
    text.textContent = fact.replace(/\s+/g, ' ');
    text.title = t('facts.jump');
    text.addEventListener('click', () => jumpToFact(fact));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'fact-x';
    remove.innerHTML = '<svg aria-hidden="true"><use href="#i-close"/></svg>';
    remove.setAttribute('aria-label', t('facts.removeLabel', { fact }));
    remove.title = t('facts.remove');
    remove.disabled = S.running;
    remove.addEventListener('click', () => {
      S.facts = S.facts.filter((f) => f !== fact);
      discardDocumentJob();
      store.set('facts', JSON.stringify(S.facts));
      renderFacts();
      updateFactSelection();
    });
    li.append(text, remove);
    return li;
  }));
  renderDraftMarks();
}

// 点标签:在草稿里选中这段并滚到它
function jumpToFact(fact) {
  const ta = $('draft'), at = ta.value.indexOf(fact);
  if (at < 0) return;
  ta.focus({ preventScroll: true });
  ta.setSelectionRange(at, at + fact.length);
  const y = ta.value.length < 60000 ? caretXY(ta, at).y + ta.scrollTop : 0;
  ta.scrollTop = Math.max(0, y - ta.clientHeight / 3);
  syncDraftMarks();
}

function bind() {
  $('btn-document-resume').addEventListener('click', () => run());
  $('btn-document-restart').addEventListener('click', () => {
    if (S.running || !confirm(t('document.confirmRestart'))) return;
    discardDocumentJob();
    run();
  });
  $('btn-download-text').addEventListener('click', downloadText);
  $('btn-upload').addEventListener('click', () => { if (!S.running && !importing) $('document-file').click(); });
  $('document-file').addEventListener('change', () => {
    const file = $('document-file').files[0];
    $('document-file').value = '';
    if (file) importDocument(file);
  });
  bindDrop();
  for (const event of ['select', 'keyup', 'mouseup', 'focus']) $('draft').addEventListener(event, updateFactSelection);
  document.addEventListener('selectionchange', updateFactSelection);
  $('draft').addEventListener('scroll', () => { syncDraftMarks(); if (!$('btn-create-fact').hidden) placeFactPop(); });
  new ResizeObserver(syncDraftMarks).observe($('draft'));
  $('draft').addEventListener('blur', (e) => { if (e.relatedTarget !== $('btn-create-fact')) $('btn-create-fact').hidden = true; });
  window.addEventListener('resize', () => { if (!$('btn-create-fact').hidden) placeFactPop(); });
  // 点按钮时别让草稿框先丢掉选区
  $('btn-create-fact').addEventListener('mousedown', (event) => event.preventDefault());
  $('btn-create-fact').addEventListener('click', () => {
    const fact = selectedFact();
    if (!fact || S.facts.includes(fact)) return;
    if (S.facts.length >= 50) { toast(t('facts.limit'), 'err'); return; }
    S.facts.push(fact);
    discardDocumentJob();
    store.set('draft', $('draft').value);
    store.set('facts', JSON.stringify(S.facts));
    renderFacts(fact);
    const ta = $('draft');
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(ta.selectionEnd, ta.selectionEnd);
    updateFactSelection();
    toast(t('facts.created'), 'ok');
  });
  $('draft').addEventListener('input', () => onDraftInput());
  $('btn-go').addEventListener('click', run);
  $('btn-regen').addEventListener('click', run);
  $('btn-copy').addEventListener('click', copyOut);
  $('btn-diff').addEventListener('click', () => { setDiffToggle(!S.showDiff); renderResult(); });
  $('chip-numbers').addEventListener('click', (e) => { e.stopPropagation(); $('numbers-pop').hidden ? openNumbers() : closeNumbers(); });
  $('btn-clear').addEventListener('click', () => {
    $('draft').value = '';
    onDraftInput();
    $('draft').focus();
  });
  $('btn-paste').addEventListener('click', async () => {
    try {
      const txt = await navigator.clipboard.readText();
      if (txt) { $('draft').value = txt; S.facts = []; onDraftInput(); }
    } catch {
      $('draft').focus();
      toast(IS_MAC ? '⌘ V' : 'Ctrl V');
    }
  });

  // 顶栏
  $('status').addEventListener('click', (e) => { e.stopPropagation(); togglePop(); });
  $('btn-menu').addEventListener('click', (e) => { e.stopPropagation(); togglePop(); });
  $('pop').addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => { togglePop(false); closeNumbers(); });
  $('btn-history').addEventListener('click', () => openDrawer(!$('drawer').classList.contains('open')));
  $('btn-drawer-close').addEventListener('click', () => openDrawer(false));
  $('scrim').addEventListener('click', () => openDrawer(false));
  $('btn-history-clear').addEventListener('click', () => {
    if (confirm(t('history.confirmClear'))) { clearHistory(); renderHistory(); toast(t('history.cleared')); }
  });
  $('btn-theme').addEventListener('click', () => {
    const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    store.set('theme', next);
  });
  for (const b of document.querySelectorAll('[data-lang]')) {
    b.addEventListener('click', () => {
      setLang(b.dataset.lang);
      store.set('lang', b.dataset.lang);
      markLang();
      renderSamples();
      onDraftInput(false);
      renderSetup();
      render();
      if (S.result) renderResult();
      if ($('drawer').classList.contains('open')) renderHistory();
    });
  }
  $('pa-external').addEventListener('click', (e) => { e.stopPropagation(); togglePop(false); openExternal(true, $('btn-menu')); });
  $('btn-setup-external').addEventListener('click', () => openExternal(true));
  bindExternal({
    isRunning: () => S.running,
    toast,
    onChange: () => { poll(); },
  });
  $('pa-quit').addEventListener('click', async () => {
    if (!confirm(t('confirm.quit'))) return;
    S.quit = true;
    togglePop(false);
    try { await postJSON('/app/quit'); } catch { /* 已经没了 */ }
    showOverlay(t('overlay.quitTitle'), t('overlay.quitMsg'), 'quit');
  });

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); run(); }
    else if (e.key === 'Escape') {
      if (S.running) stop();
      togglePop(false);
      closeNumbers();
      openDrawer(false);
    }
  });
}

init();

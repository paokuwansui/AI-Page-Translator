/* background.js —— service worker：调 API / 拉模型列表 / badge 进度 */
'use strict';
if (typeof importScripts === 'function') {
  importScripts('lib/common.js', 'lib/cache.js');
} else if (typeof require !== 'undefined') {
  globalThis.Lib = require('./lib/common.js');
}

/** tabId → (frameId → {url, ts}):子帧自报家门,供跨域内嵌框内容收集精确回问 */
const frameReg = new Map();
  const imgFrameReg = new Map();
/** 各子帧主动上交的资料缓存:tabId -> Map(frameId -> {piece, ts})
 *  —— 阅读助手优先用缓存,拿不到才去"问"(问需要应答,重页面里最容易丢)。 */
const framePiecesByUrl = new Map(); // tabId -> Map(框地址 -> {piece, ts}):页面切课时框会重建,frameId 变了但地址还在
const framePieces = new Map();      // tabId -> Map(frameId -> 该帧图片翻译战绩,用于汇总成'本页/内嵌框各翻了几张')
try {
  if (chrome.tabs && chrome.tabs.onRemoved) chrome.tabs.onRemoved.addListener((tabId) => { frameReg.delete(tabId); framePieces.delete(tabId); framePiecesByUrl.delete(tabId); imgFrameReg.delete(tabId); });
} catch (e) { /* 忽略 */ }

/** 该 tab 里可能要问的 frameId(登记表 + 1..40 试探;frameId 不连续,不能"问几个没人就收手") */
function frameIdsFor(tabId) {
  const ids = new Set();
  const reg = frameReg.get(tabId);
  if (reg) for (const k of reg.keys()) if (k !== 0) ids.add(k);
  for (let i = 1; i <= 40; i++) ids.add(i);
  return ids;
}

/** 问某个帧要一份数据(超时/无接收端 → null) */
function askFrame(tabId, fid, message, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve(null); } }, timeoutMs || 350);
    try {
      chrome.tabs.sendMessage(tabId, message, { frameId: fid }, (r) => {
        void chrome.runtime.lastError;
        if (done) return;
        done = true; clearTimeout(t);
        resolve(r || null);
      });
    } catch (e) { if (!done) { done = true; clearTimeout(t); resolve(null); } }
  });
}

async function fetchJSON(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) throw await httpError(res);
  return res.json();
}

/** 读取服务端错误详情(如 "This model does not support image input"),供上层区分错误类型 */
async function httpError(res) {
  let detail = '';
  try {
    const text = await res.text();
    try { const j = JSON.parse(text); detail = (j && j.error && (j.error.message || j.error)) || j.message || ''; }
    catch (e) { detail = text.slice(0, 300); }
  } catch (e) { /* 忽略 */ }
  const err = new Error('HTTP ' + res.status + (detail ? ': ' + detail : ''));
  err.status = res.status;
  err.detail = String(detail || '');
  return err;
}

/** 获取可用模型列表；base 不含 /v1 时自动补试一次，成功后回填规范化 base */
async function fetchModels(baseUrl, apiKey) {
  const base = Lib.normBase(baseUrl);
  const headers = apiKey ? { Authorization: 'Bearer ' + apiKey } : {};
  const candidates = base.includes('/v1') ? [base] : [base, base + '/v1'];
  let lastErr = null;
  for (const b of candidates) {
    try {
      const j = await fetchJSON(b + '/models', { headers });
      return { ok: true, base: b, models: (j.data || []).map((m) => m.id).filter(Boolean) };
    } catch (e) { lastErr = e; }
  }
  if (lastErr && lastErr.status === 401) return { ok: false, error: 'API Key 无效 (401)' };
  return { ok: false, error: '无法获取模型列表: ' + (lastErr && lastErr.message ? lastErr.message : '网络错误') };
}

async function chatCompletion(baseUrl, apiKey, model, messages) {
  const base = Lib.normBase(baseUrl);
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
  const j = await fetchJSON(base + '/chat/completions', {
    method: 'POST', headers,
    body: JSON.stringify({ model, messages, temperature: 0.3, stream: false })
  });
  const content = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (typeof content !== 'string') throw new Error('响应格式异常');
  return content;
}

/** SSE 流式 chat:边接收边 onPartial(累积文本),返回完整内容 */
async function chatCompletionStream(baseUrl, apiKey, model, messages, onPartial, signal, opts) {
  const base = Lib.normBase(baseUrl);
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
  const res = await fetch(base + '/chat/completions', {
    method: 'POST', headers,
    body: JSON.stringify(Object.assign({ model, messages, temperature: 0.3, stream: true },
      (opts && Number(opts.maxTokens) > 0) ? { max_tokens: Number(opts.maxTokens) } : {})),
    signal,                                   // 供端口断开时真正中断上游请求(用户点"停止")
  });
  if (!res.ok) throw await httpError(res);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', content = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const j = JSON.parse(payload);
        const delta = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
        if (typeof delta === 'string' && delta) { content += delta; onPartial(content); }
      } catch (e) { /* 跳过坏帧 */ }
    }
  }
  return content;
}

/* ---------------- 图片抓取(host_permissions 绕开页面 CORS) ---------------- */

const MAX_IMG = 6 * 1024 * 1024;

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.prototype.map.call(new Uint8Array(buf), (x) => x.toString(16).padStart(2, '0')).join('');
}

function bytesToBase64(buf) {
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < buf.length; i += CH) {
    bin += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
  }
  return btoa(bin);
}

/** 取图 → data URL + 内容摘要(缓存键用)。
 *  放 background 的原因:扩展 fetch 不受页面 CORS 限制;内容脚本里 canvas 画跨域图会 taint。 */
async function fetchImageAsDataUrl(url) {
  if (!url || /^data:/i.test(url)) {
    return { ok: true, dataUrl: url, digest: await sha256Hex(String(url).slice(0, 512)), bytes: 0, mime: '' };
  }
  const res = await fetch(url, { credentials: 'omit', redirect: 'follow' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const type = res.headers.get('content-type') || '';
  if (type && !/^image\//.test(type)) throw new Error('非图片资源: ' + type);
  const len = Number(res.headers.get('content-length') || 0);
  if (len && len > MAX_IMG) throw new Error('图片过大(' + Math.round(len / 1024) + 'KB)');
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > MAX_IMG) throw new Error('图片过大');
  const dataUrl = 'data:' + (type || 'image/png') + ';base64,' + bytesToBase64(buf);
  // 摘要:头 4KB + 总长度(足够区分图片,又不必哈希整张图)
  const digest = await sha256Hex(dataUrl.slice(0, 4096) + ':' + buf.byteLength);
  return { ok: true, dataUrl, digest, bytes: buf.byteLength, mime: type };
}

/** 截取当前可见标签页(captureVisibleTab 需要 <all_urls>,manifest 已有)
 *  ⚠️ Chrome 限制:captureVisibleTab 每秒最多 2 次,超了直接失败(用户"连点几下就失败"就是这个)。
 *  所以这里把截图串行化,并保证两次调用间隔 ≥500ms —— 从根上不撞额度,而不是失败了再补救。 */
const gateCapture = Lib.createSpacer(500);        // 500ms 间隔 = 秒 2 次额度内(且串行)
function captureVisibleTab(windowId, format) {
  return gateCapture().then(() => captureOnce(windowId, 0, format));
}

function captureOnce(windowId, attempt, format) {
  const fmt = format === 'jpeg' ? 'jpeg' : 'png';        // 截图给模型读文字 → 无损 PNG 更准
  const opts = fmt === 'jpeg' ? { format: 'jpeg', quality: 82 } : { format: 'png' };
  return new Promise((resolve) => {
    try {
      chrome.tabs.captureVisibleTab(windowId == null ? undefined : windowId, opts, (dataUrl) => {
        const le = chrome.runtime.lastError;
        if (!le && dataUrl) { resolve({ ok: true, dataUrl }); return; }
        const m = (le && le.message) || '截图失败';
        // 兜底:仍是额度/临时性错误 → 等一秒再试一次(串行化之外的双保险)
        if (attempt === 0 && /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|quota|Failed to capture|not been invoked/i.test(m)) {
          setTimeout(() => resolve(captureOnce(windowId, 1, fmt)), 1000);
          return;
        }
        resolve({ ok: false, error: (attempt > 0 ? '重试后仍失败: ' : '') + m });
      });
    } catch (e) { resolve({ ok: false, error: String((e && e.message) || e) }); }
  });
}

function errMsg(e) {
  const d = e && e.detail ? ': ' + e.detail : '';
  if (e && e.status === 401) return 'API Key 无效 (401)' + d;
  if (e && e.status === 429) return '请求过于频繁 (429)，请稍后重试' + d;
  if (e && e.status >= 500) return '服务端错误 (' + e.status + ')' + d;
  if (e && e.status === 400) return '请求被拒 (400)' + d;
  return '网络错误: ' + (e && e.message ? e.message : String(e)) + d;
}

if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  // 流式端口:content 连接后,后台持续推送 partial,结束回 done
  chrome.runtime.onConnect.addListener((port) => {
    if (!port || port.name !== 'chatStream') return;
    let ctrl = null;                                  // 本次流的中断控制器
    let gone = false;
    port.onDisconnect.addListener(() => {
      gone = true;
      try { ctrl && ctrl.abort(); } catch (e) { /* ignore */ }   // 前端已断开 → 别继续把上游读完
    });
    port.onMessage.addListener(async (msg) => {
      if (!msg || msg.type !== 'chat') return;
      ctrl = new AbortController();
      try {
        const full = await chatCompletionStream(msg.baseUrl, msg.apiKey, msg.model, msg.messages, (t) => {
          if (gone) return;
          try { port.postMessage({ type: 'partial', text: t }); } catch (e) { /* ignore */ }
        }, ctrl.signal, { maxTokens: msg.maxTokens });
        if (!gone) { try { port.postMessage({ type: 'done', text: full }); } catch (e) { /* ignore */ } }
      } catch (e) {
        if (!gone) { try { port.postMessage({ type: 'error', error: errMsg(e) }); } catch (e2) { /* ignore */ } }
      } finally {
        ctrl = null;
      }
    });
  });

  /* ---------------- AI 阅读助手:侧栏 / 右键菜单 / 快捷键 ---------------- */

  function activeTabId() {
    return new Promise((resolve) => {
      try { chrome.tabs.query({ active: true, currentWindow: true }, (ts) => resolve(ts && ts[0] ? ts[0].id : null)); }
      catch (e) { resolve(null); }
    });
  }

  function openSidePanel(tabId) {
    if (!chrome.sidePanel || !chrome.sidePanel.open) return Promise.reject(new Error('no-side-panel'));
    return Promise.resolve()
      .then(() => (chrome.sidePanel.setOptions ? chrome.sidePanel.setOptions({ tabId, path: 'panel/sidepanel.html', enabled: true }) : null))
      .then(() => chrome.sidePanel.open({ tabId }));
  }

  function setupMenus() {
    if (!chrome.contextMenus) return;
    try {
      chrome.contextMenus.removeAll(() => {
        const add = (o) => { try { chrome.contextMenus.create(o); } catch (e) {} };
        add({ id: 'lf-ask', title: '问 AI:这段内容是什么意思?', contexts: ['selection'] });
        add({ id: 'lf-explain', title: 'AI 解释这段内容', contexts: ['selection'] });
        add({ id: 'lf-addctx', title: '加入 AI 对话上下文', contexts: ['selection'] });
        add({ id: 'lf-img', title: '翻译这张图片的文字', contexts: ['image'] });
        add({ id: 'lf-translate-page', title: '翻译此页(AI-Page-Translator)', contexts: ['page'] });
      });
    } catch (e) { /* 忽略 */ }
  }
  try { chrome.runtime.onInstalled.addListener(setupMenus); } catch (e) {}
  setupMenus();

  if (chrome.contextMenus) {
    chrome.contextMenus.onClicked.addListener((info, tab) => {
      if (!tab || tab.id == null) return;
      const send = (m) => { try { chrome.tabs.sendMessage(tab.id, m, Lib.frameOptsFor(m && m.type), () => void chrome.runtime.lastError); } catch (e) {} };
      if (info.menuItemId === 'lf-explain') send({ type: 'askPage', question: '解释下面这段内容(结合页面上下文):\n\n' + (info.selectionText || ''), attachText: '' });
      else if (info.menuItemId === 'lf-addctx') send({ type: 'askSelection', text: info.selectionText || '' });
      else if (info.menuItemId === 'lf-ask') send({ type: 'askPage', attachText: info.selectionText || '', question: '结合页面上下文解释这段内容,并说明它在整页里的作用:' });
      else if (info.menuItemId === 'lf-img') send({ type: 'translateImages' });
      else if (info.menuItemId === 'lf-translate-page') send({ type: 'translate' });
    });
  }

  if (chrome.commands) {
    chrome.commands.onCommand.addListener(async (cmd) => {
      const tabId = await activeTabId();
      if (tabId == null) return;
      const send = (m) => { try { chrome.tabs.sendMessage(tabId, m, Lib.frameOptsFor(m && m.type), () => void chrome.runtime.lastError); } catch (e) {} };
      if (cmd === 'translate-page') send({ type: 'translate' });
      else if (cmd === 'toggle-chat') send({ type: 'toggleChat' });
      else if (cmd === 'translate-images') send({ type: 'translateImages' });
    });
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'openChat') {
      const tabId = (sender.tab && sender.tab.id != null) ? sender.tab.id : null;
      if (!tabId) { sendResponse({ ok: true, mode: 'inpage' }); return false; }
      openSidePanel(tabId)
        .then(() => sendResponse({ ok: true, mode: 'sidepanel' }))
        .catch(() => sendResponse({ ok: true, mode: 'inpage' }));
      return true;
    }
    if (msg && msg.type === 'openOptions') {
      // 不用 chrome.runtime.openOptionsPage():它需要用户手势上下文,失败时还会静默无效果
      // (实测:面板里点 ⚙ 后一个标签都不开)。改成确定性地"聚焦已开的设置页 / 新开一个"。
      const url = chrome.runtime.getURL('options/options.html');
      (async () => {
        try {
          const all = await chrome.tabs.query({});
          const hit = all.find((t) => t.url === url);
          if (hit && hit.id != null) {
            await chrome.tabs.update(hit.id, { active: true });
            sendResponse({ ok: true, mode: 'focus' });
            return;
          }
        } catch (e) { /* 读不到 tab.url 就直接新建 */ }
        try {
          await chrome.tabs.create({ url });
          sendResponse({ ok: true, mode: 'create' });
        } catch (e) {
          try { chrome.runtime.openOptionsPage(); sendResponse({ ok: true, mode: 'api' }); }
          catch (e2) { sendResponse({ ok: false, error: String((e2 && e2.message) || e2) }); }
        }
      })();
      return true;
    }
    if (msg && msg.type === 'digest') {
      // content 页无 WebCrypto 时由 background 代算缓存签名(kiss cacheDigest 同款降级)
      (async () => {
        try {
          const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(msg.text || '')));
          const hex = Array.prototype.map.call(new Uint8Array(buf), (x) => x.toString(16).padStart(2, '0')).join('');
          sendResponse({ ok: true, digest: hex });
        } catch (e) { sendResponse({ ok: false }); }
      })();
      return true;
    }
    if (msg && msg.type === 'fetchImage') {
      fetchImageAsDataUrl(msg.url).then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
      return true;
    }
    if (msg && msg.type === 'framePiece') {                     // 子帧主动上交资料(含图片数)
      const tabId = sender.tab && sender.tab.id;
      const fid = (sender.frameId == null) ? 0 : sender.frameId;
      if (tabId == null) { sendResponse({ ok: false }); return false; }
      if (!framePieces.has(tabId)) framePieces.set(tabId, new Map());
      framePieces.get(tabId).set(fid, { piece: msg.piece || null, ts: Date.now() });
      // 同时按**框地址**索引一份:播放器/SPA 换课时框被重建,frameId 会变,
      // 只按 frameId 记,切一节课就等于该框内容整体丢失。
      try {
        const url = String((msg.piece && msg.piece.url) || '');
        if (url) {
          if (!framePiecesByUrl.has(tabId)) framePiecesByUrl.set(tabId, new Map());
          const m = framePiecesByUrl.get(tabId);
          const prev = m.get(url);
          const np = msg.piece || null;
          const prevN = prev && prev.piece ? ((prev.piece.chunks || []).length + Number(prev.piece.carriers || 0)) : -1;
          const nowN = np ? ((np.chunks || []).length + Number(np.carriers || 0)) : -1;
          if (!prev || nowN >= prevN) m.set(url, { piece: np, ts: Date.now() });   // 只留更全的那份
        }
      } catch (e) { /* 忽略 */ }
      sendResponse({ ok: true });
      return false;
    }
    if (msg && msg.type === 'frameImgResult') {
      // 各帧翻完图后自报战绩(内嵌框里的图由各帧自己翻,顶层看不到)
      try {
        const tabId = sender.tab && sender.tab.id, fid = sender.frameId;
        if (tabId != null) {
          if (!imgFrameReg.has(tabId)) imgFrameReg.set(tabId, new Map());
          imgFrameReg.get(tabId).set(fid == null ? 0 : fid, { rendered: msg.rendered || 0, images: msg.images || 0, cached: msg.cached || 0, items: msg.items || 0, skipped: !!msg.skipped, url: String(msg.url || ''), ts: Date.now() });
        }
      } catch (e) { /* 忽略 */ }
      sendResponse({ ok: true });
      return false;
    }
    if (msg && msg.type === 'collectFrameImages') {
      // 面板「读取页面图片」:顶层只能看到自己文档里的图 → 逐帧问,把内嵌框里的图也收上来
      const tabId = sender.tab && sender.tab.id;
      if (tabId == null) { sendResponse({ ok: false, images: [] }); return false; }
      (async () => {
        const list = [...frameIdsFor(tabId)];
        const rs = await Promise.all(list.map((fid) => askFrame(tabId, fid, { type: 'frameImageList', max: msg.max || 6 }, 4000)));
        const images = [];
        // 打上"来自哪个框":面板要把"图片正文框里的整页图"和普通插图区分开(别把无关的图当正文发出去)
        for (const r of rs) if (r && r.ok && Array.isArray(r.images)) {
          // 每张图自带 frame(产生它的那个框的地址)→ 用它标 frameUrl(顶层自己的图 frame=顶层地址)
          for (const im of r.images) images.push(Object.assign({}, im, { frameUrl: String((im && im.frame) || r.url || '') }));
        }
        sendResponse({ ok: true, images: images, frames: rs.filter((r) => r && r.ok && (r.images || []).length).length });
      })();
      return true;
    }
    if (msg && msg.type === 'frameImgSummary') {
      const tabId = sender.tab && sender.tab.id;
      const m = tabId == null ? null : imgFrameReg.get(tabId);
      const frames = [];
      let images = 0, rendered = 0;
      if (m) {
        for (const [fid, v] of m) {
          if (Date.now() - (v.ts || 0) > 20000) continue;             // 只算刚发生的
          if (msg.since && (v.ts || 0) < msg.since) continue;         // 只要本轮(可选)
          frames.push({ frameId: fid, url: v.url, images: v.images, rendered: v.rendered, items: v.items, skipped: v.skipped });
          images += v.images || 0;
          rendered += v.rendered || 0;
        }
      }
      const reg = frameReg.get(tabId);
      const knownFrames = reg ? [...reg.keys()].filter((k) => k !== 0) : [];
      sendResponse({ ok: true, frames: frames, images: images, rendered: rendered, knownFrames: knownFrames,
        framesWithImages: frames.filter((f) => (f.rendered || 0) > 0 && f.frameId !== 0).length });
      return false;
    }
    if (msg && msg.type === 'captureTab') {
      // ⚠️ captureVisibleTab 截的是「该窗口的**当前活动标签页**」,不是"发消息的标签页"。
      //    面板在 A 标签页、用户切到了 B(或用侧栏时活动页是别的页) → 必须先激活目标标签页、
      //    并让它所在窗口获得焦点,否则会截错页面甚至直接失败(参考实现里最常被忽略的一步)。
      (async () => {
        let tabId = sender.tab && sender.tab.id != null ? sender.tab.id : null;
        let winId = sender.tab && sender.tab.windowId;
        if (tabId == null) {                                  // 侧栏/扩展页没有 sender.tab → 用当前活动页
          try {
            const ts = await new Promise((r) => chrome.tabs.query({ active: true, currentWindow: true }, r));
            const t0 = ts && ts[0];
            tabId = t0 ? t0.id : null;
            winId = t0 ? t0.windowId : winId;
          } catch (e) { /* 忽略 */ }
        }
        try {
          if (tabId != null) {
            const t = await chrome.tabs.get(tabId);
            if (t) {
              winId = t.windowId;
              if (!t.active) { await chrome.tabs.update(tabId, { active: true }); await new Promise((r) => setTimeout(r, 130)); }
              try {
                const w = await chrome.windows.get(t.windowId);
                if (w && w.focused === false) { await chrome.windows.update(t.windowId, { focused: true }); await new Promise((r) => setTimeout(r, 130)); }
              } catch (e) { /* windows API 不可用就算了 */ }
            }
          }
        } catch (e) { /* 取不到标签页信息就按原样试 */ }
        // 裁剪放到内容脚本里做(canvas):MV3 的 service worker 没有 createImageBitmap
        sendResponse(await captureVisibleTab(winId, msg.format));
      })();
      return true;
    }
    if (msg && msg.type === 'frameHello') {
      // 子帧登记:frameId 只能在后台从 sender.frameId 拿到(内容脚本自己不知道)
      try {
        const tabId = sender.tab && sender.tab.id;
        const fid = sender.frameId;
        if (tabId != null && fid != null) {
          if (!frameReg.has(tabId)) frameReg.set(tabId, new Map());
          frameReg.get(tabId).set(fid, { url: String(msg.url || ''), ts: Date.now() });
        }
      } catch (e) { /* 忽略 */ }
      sendResponse({ ok: true });
      return false;
    }
    if (msg && msg.type === 'collectFrameSelection') {
      // 在**内嵌框里**选中的文字,顶层 window.getSelection() 是空的 → 以前一律报"当前没有选中文本"。
      // 逐帧问各自的选择,取最长的一段(框里选的字通常也最长)。
      const tabId = sender.tab && sender.tab.id;
      if (tabId == null) { sendResponse({ ok: false, text: '' }); return false; }
      (async () => {
        const list = [...frameIdsFor(tabId)];
        const rs = await Promise.all(list.map((fid) => askFrame(tabId, fid, { type: 'getSelectionOwn' }, 1200)));
        let best = '';
        for (let i = 0; i < rs.length; i++) {
          const t = (rs[i] && rs[i].text) ? String(rs[i].text) : '';
          if (t.trim().length > best.trim().length) { best = t; }
        }
        sendResponse({ ok: !!best.trim(), text: best, frames: list.length });
      })();
      return true;
    }
    if (msg && msg.type === 'collectFramePieces') {
      // 跨域内嵌框的内容顶层读不到 → 逐帧问每个 frame 自己的 content script 要一份资料。
      // frameId 走登记表(frameHello);表为空时回退到小范围试探(老帧/刚重载扩展的情况)。
      const tabId = sender.tab && sender.tab.id;
      if (tabId == null) { sendResponse({ ok: false, pieces: [], asked: 0 }); return false; }
      (async () => {
        // 覆盖范围必须和翻译一致:凡是装了内容脚本的框都要问一遍 —— 同源框也算(顶层遍历可能只拿到半截)。
        // ⚠️ frameId 不连续(导航后会跳到 5、9…),"连问几个没人就收手"会漏帧,所以登记表 + 大范围并行试探。
        // ① 先用各帧**主动交上来**的缓存(和翻译同一套:各帧自己干活,不需要应答)
        const cache = framePieces.get(tabId);
        const cached = [];
        const needAsk = [];
        const list = [...frameIdsFor(tabId)];
        for (const fid of list) {
          const hit = cache && cache.get(fid);
          if (hit && (Date.now() - hit.ts) < 30000 && hit.piece) cached.push({ fid: fid, piece: hit.piece, from: 'push' });
          else needAsk.push(fid);
        }
        // ①b 再按**框地址**取一遍缓存(框重建后 frameId 变了,地址没变)
        const byUrlCache = framePiecesByUrl.get(tabId);
        if (byUrlCache) {
          for (const [url, hit] of byUrlCache) {
            if (!hit || !hit.piece || (Date.now() - (hit.ts || 0)) > 60000) continue;
            cached.push({ fid: -1, piece: hit.piece, from: 'pushUrl' });
          }
        }
        // ② 缓存里没有的再问(并行:总耗时≈一次超时)。重页面里帧脚本可能正忙 → 放宽到 2.5s
        const rs = await Promise.all(needAsk.map((fid) => askFrame(tabId, fid, { type: 'readerPiece' }, 2500)));
        // ②b 没应答的再补问一次(播放器切课/首次加载时帧脚本常"第一次问没空理"):这是"框里有字读不到"的最后一道保险
        const retryIdx = [];
        for (let i = 0; i < needAsk.length; i++) if (!rs[i]) retryIdx.push(i);
        if (retryIdx.length && retryIdx.length <= 20) {
          const rs2 = await Promise.all(retryIdx.map((i) => askFrame(tabId, needAsk[i], { type: 'readerPiece' }, 1500)));
          for (let k = 0; k < retryIdx.length; k++) if (rs2[k]) rs[retryIdx[k]] = rs2[k];
        }
        const pieces = [];
        const remember = (fid, pc) => {
          if (!frameReg.has(tabId)) frameReg.set(tabId, new Map());
          frameReg.get(tabId).set(fid, { url: String(pc.url || ''), ts: Date.now() });   // 记住真实 frameId
        };
        let frameImages = 0;
        // 「有效」= 有文字片段,或本身就是图片/画布/PDF 正文(文字节点不存在,但内容在 —— 用户已经能靠翻译读到它)。
        // 以前只认 chunks,图片正文的框会被当"没应答"(于是助手说"读不到"),用户投诉的正是这种。
        const useful = (pc) => !!(pc && ((pc.chunks && pc.chunks.length) || Number(pc.images || 0) > 0
          || Number(pc.carriers || 0) > 0
          || pc.kind === 'canvas' || pc.kind === 'pdf' || pc.kind === 'imageOnly'));
        for (const c of cached) {                                      // ① 主动交上来的
          if (useful(c.piece)) {
            pieces.push(c.piece);
            frameImages += Number(c.piece.carriers || c.piece.images || 0);
            if (c.fid >= 0) remember(c.fid, c.piece);       // 地址缓存条目没有真实 frameId(-1)→ 别污染登记表
          }
        }
        for (let i = 0; i < needAsk.length; i++) {                     // ② 问回来的
          const pc = rs[i];
          if (useful(pc)) {
            pieces.push(pc);
            frameImages += Number(pc.carriers || pc.images || 0);
            remember(needAsk[i], pc);
          }
        }
        // 同一框可能同时来自 frameId 缓存与地址缓存 → 按地址去重,只留内容更全的那份
        const dedup = new Map();
        for (const pc of pieces) {
          const key = String((pc && pc.url) || Math.random());
          const n = pc ? ((pc.chunks || []).length + Number(pc.carriers || pc.images || 0)) : -1;
          const cur = dedup.get(key);
          const curN = cur ? ((cur.chunks || []).length + Number(cur.carriers || cur.images || 0)) : -1;
          if (!cur || n > curN) dedup.set(key, pc);
        }
        const finalPieces = [...dedup.values()];
        sendResponse({ ok: true, pieces: finalPieces, asked: list.length, answered: finalPieces.length,
          fromPush: cached.length, frameImages: frameImages });
      })();
      return true;
    }
    if (msg && msg.type === 'fetchModels') {
      fetchModels(msg.baseUrl, msg.apiKey).then(sendResponse).catch((e) => sendResponse({ ok: false, error: errMsg(e) }));
      return true;
    }
    if (msg && msg.type === 'chat') {
      chatCompletion(msg.baseUrl, msg.apiKey, msg.model, msg.messages)
        .then((text) => sendResponse({ ok: true, text }))
        .catch((e) => sendResponse({ ok: false, error: errMsg(e) }));
      return true;
    }
    if (msg && msg.type === 'badge' && sender.tab && sender.tab.id != null) {
      const pct = Number(msg.pct) || 0;
      try {
        chrome.action.setBadgeText({ tabId: sender.tab.id, text: pct > 0 && pct < 100 ? pct + '%' : '' });
        chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: '#2563eb' });
      } catch (e) { /* ignore */ }
      sendResponse({ ok: true });                          // 回一句:不然内容脚本会收到 lastError 噪音
      return false;
    }
    if (msg && msg.type === 'progress' && sender.tab) {
      try {
        chrome.storage.local.set({ lastProgress: { tabId: sender.tab.id, stage: msg.stage || 'translate', pct: Number(msg.pct) || 0, done: Number(msg.done) || 0, total: Number(msg.total) || 0, ts: Date.now() } });
      } catch (e) { /* ignore */ }
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });
}

// 供 node 测试导出
if (typeof module !== 'undefined' && module.exports) module.exports = { fetchModels, chatCompletion, chatCompletionStream, errMsg, fetchImageAsDataUrl, sha256Hex };

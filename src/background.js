/* background.js —— service worker：调 API / 拉模型列表 / badge 进度 */
'use strict';
if (typeof importScripts === 'function') {
  importScripts('lib/common.js');
} else if (typeof require !== 'undefined') {
  globalThis.Lib = require('./lib/common.js');
}

async function fetchJSON(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
  return res.json();
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
async function chatCompletionStream(baseUrl, apiKey, model, messages, onPartial) {
  const base = Lib.normBase(baseUrl);
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
  const res = await fetch(base + '/chat/completions', {
    method: 'POST', headers,
    body: JSON.stringify({ model, messages, temperature: 0.3, stream: true })
  });
  if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
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

function errMsg(e) {
  if (e && e.status === 401) return 'API Key 无效 (401)';
  if (e && e.status === 429) return '请求过于频繁 (429)，请稍后重试';
  if (e && e.status >= 500) return '服务端错误 (' + e.status + ')';
  return '网络错误: ' + (e && e.message ? e.message : String(e));
}

if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  // 流式端口:content 连接后,后台持续推送 partial,结束回 done
  chrome.runtime.onConnect.addListener((port) => {
    if (!port || port.name !== 'chatStream') return;
    port.onMessage.addListener(async (msg) => {
      if (!msg || msg.type !== 'chat') return;
      try {
        const full = await chatCompletionStream(msg.baseUrl, msg.apiKey, msg.model, msg.messages, (t) => {
          try { port.postMessage({ type: 'partial', text: t }); } catch (e) { /* ignore */ }
        });
        try { port.postMessage({ type: 'done', text: full }); } catch (e) { /* ignore */ }
      } catch (e) {
        try { port.postMessage({ type: 'error', error: errMsg(e) }); } catch (e2) { /* ignore */ }
      }
    });
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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
      return false;
    }
    if (msg && msg.type === 'progress' && sender.tab) {
      try {
        chrome.storage.local.set({ lastProgress: { tabId: sender.tab.id, stage: msg.stage || 'translate', pct: Number(msg.pct) || 0, done: Number(msg.done) || 0, total: Number(msg.total) || 0, ts: Date.now() } });
      } catch (e) { /* ignore */ }
      return false;
    }
    return false;
  });
}

// 供 node 测试导出
if (typeof module !== 'undefined' && module.exports) module.exports = { fetchModels, chatCompletion, chatCompletionStream, errMsg };

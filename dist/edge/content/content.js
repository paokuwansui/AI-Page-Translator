/* content/content.js —— 页面文本翻译主流程
 * 流程: 快翻(分块并发 + SSE 流式,段完整即显示) → 润色(全量译文统一措辞,流式二次替换)
 * 能力: 已翻译节点幂等(重复点击不重翻)、MutationObserver 动态内容翻译
 */
'use strict';
(() => {
  if (typeof Chunker === 'undefined' || typeof Lib === 'undefined') return; // 防御

  let originals = new Map();   // 已翻译节点 -> 原文(持久,restore 用;也用于幂等过滤)
  let current = null;          // { running, stage: 'translate'|'polish', done, total, aborted }
  let observer = null;
  let dynTimer = null;
  let dynPending = [];         // 动态内容待翻译节点

  /** SSE 流式请求:background 经 port 持续推送 partial */
  function chatStream(baseUrl, apiKey, model, messages, onPartial) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let port;
      try { port = chrome.runtime.connect({ name: 'chatStream' }); } catch (e) { reject(e); return; }
      port.onMessage.addListener((m) => {
        if (!m) return;
        if (m.type === 'partial') { try { onPartial(m.text); } catch (e) { /* ignore */ } }
        else if (m.type === 'done') { if (!settled) { settled = true; try { port.disconnect(); } catch (e) {} resolve(m.text); } }
        else if (m.type === 'error') { if (!settled) { settled = true; try { port.disconnect(); } catch (e) {} reject(new Error(m.error || '流式请求失败')); } }
      });
      port.onDisconnect.addListener(() => {
        if (!settled) { settled = true; reject(new Error('连接中断')); }
      });
      port.postMessage({ type: 'chat', baseUrl, apiKey, model, messages });
    });
  }

  /** 单节点回填;originals 首次记录原文 */
  function applyOne(nd, tr) {
    if (!nd || !tr || !tr.trim()) return;
    const orig = nd.nodeValue;
    if (tr !== orig) {
      if (!originals.has(nd)) originals.set(nd, orig);
      nd.nodeValue = tr;
    }
  }

  /** 整块回填(非流式/收尾用) */
  function applyChunk(chunk, arr) {
    for (let k = 0; k < chunk.length; k++) {
      applyOne(chunk[k], arr[k]);
    }
  }

  async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
  }

  function report(stage, pct, done, total) {
    if (window.top !== window) return; // iframe 静默翻译,进度/badge 只由顶层汇报
    try { Lib.sendMsg({ type: 'badge', pct }); } catch (e) {}
    try { Lib.sendMsg({ type: 'progress', stage, pct, done, total }); } catch (e) {}
  }

  /** 过滤掉已翻译过的节点(幂等) */
  function freshBlocks(blocks) {
    return blocks
      .map((b) => ({ ...b, nodes: b.nodes.filter((n) => !originals.has(n)) }))
      .filter((b) => b.nodes.length);
  }

  const sysMsg = { role: 'system', content: 'You are a professional translation engine. Return only the requested output.' };

  /** 主翻译路径:SSE 流式,段完整立即显示;流结束未覆盖的段走全量解析,仍缺失再并发降级 */
  async function translateChunkSmart(chunk, st) {
    const text = Chunker.makeChunkText(chunk);
    const prompt = 'Translate the text segments below from ' + st.sourceLang + ' to ' + st.targetLang +
      '.\nKeep every separator token (like ' + '\u27e60\u27e7' + ') exactly as-is.\n' +
      'Output ONLY the translated segments joined by the same separators, in the same order and same count.\n' +
      'No explanations, no notes, no code fences.\n\n' + text;
    const applied = new Set();
    let full = '';
    try {
      full = await chatStream(st.baseUrl, st.apiKey, st.model, [sysMsg, { role: 'user', content: prompt }], (partial) => {
        const segs = Chunker.extractCompleteSegs(partial);
        for (const s of segs) {
          if (applied.has(s.idx) || s.idx >= chunk.length) continue;
          applied.add(s.idx);
          applyOne(chunk[s.idx], s.text);
        }
      });
    } catch (e) { full = ''; }
    if (applied.size === chunk.length) return;
    if (full) {
      const arr = Chunker.parseChunkText(full);
      if (arr && arr.length === chunk.length) {
        for (let k = 0; k < chunk.length; k++) if (!applied.has(k)) applyOne(chunk[k], arr[k]);
        return;
      }
    }
    // 降级:未应用节点并发单请求(替代原来的串行,提速明显)
    const missing = chunk.filter((_, k) => !applied.has(k));
    if (!missing.length) return;
    await mapLimit(missing, Math.max(1, Math.min(st.concurrency, missing.length)), async (nd) => {
      const rr = await Lib.sendMsg({ type: 'chat', baseUrl: st.baseUrl, apiKey: st.apiKey, model: st.model,
        messages: [{ role: 'user', content: 'Translate from ' + st.sourceLang + ' to ' + st.targetLang +
          '. Output ONLY the translation, nothing else.\n\n' + (nd.nodeValue || '') }] });
      if (rr && rr.ok) applyOne(nd, (rr.text || '').trim());
    });
  }

  /** 阶段2:把所有已翻译译文统一润色(流式),第二次替换前端 */
  async function polish(st) {
    const translated = [];
    for (const nd of originals.keys()) {
      if (document.contains(nd) && nd.nodeValue && nd.nodeValue.trim() && nd.nodeValue !== originals.get(nd)) {
        translated.push(nd);
      }
    }
    if (!translated.length) return;
    const chunks = Chunker.buildChunks([{ nodes: translated }], st.polishChunkSize || 3000);
    current.stage = 'polish'; current.done = 0; current.total = chunks.length;
    report('polish', 0, 0, chunks.length);
    await mapLimit(chunks, st.concurrency, async (chunk) => {
      if (current.aborted) return;
      const text = Chunker.makeChunkText(chunk);
      const prompt = 'Below are translations of a web page in ' + st.targetLang + '.\n' +
        'Polish them for consistency and natural phrasing: unify terminology, smooth awkward wording, keep the exact meaning.\n' +
        'Keep every separator token (like ' + '\u27e60\u27e7' + ') exactly as-is.\n' +
        'Output ONLY the polished segments joined by the same separators, in the same order and same count.\n' +
        'No explanations, no notes, no code fences.\n\n' + text;
      const applied = new Set();
      let full = '';
      try {
        full = await chatStream(st.baseUrl, st.apiKey, st.model, [{ role: 'user', content: prompt }], (partial) => {
          const segs = Chunker.extractCompleteSegs(partial);
          for (const s of segs) {
            if (applied.has(s.idx) || s.idx >= chunk.length) continue;
            applied.add(s.idx);
            if (s.text && s.text.trim()) chunk[s.idx].nodeValue = s.text; // 第二次替换(流式)
          }
        });
        if (applied.size < chunk.length && full) {
          const arr = Chunker.parseChunkText(full);
          if (arr && arr.length === chunk.length) {
            for (let k = 0; k < chunk.length; k++) {
              if (!applied.has(k) && arr[k] && arr[k].trim()) chunk[k].nodeValue = arr[k];
            }
          }
        }
      } catch (e) { /* 润色失败保留现有译文 */ }
      current.done++;
      report('polish', Math.round((current.done / current.total) * 100), current.done, current.total);
    });
  }

  async function translatePage(st) {
    if (current && current.running) return { ok: false, error: '正在翻译中' };
    const chunks = Chunker.buildChunks(freshBlocks(Chunker.collectBlocks(document.body)), st.chunkSize);
    if (!chunks.length) return { ok: true, translated: 0, skipped: true }; // 没有新的可翻译内容
    current = { running: true, stage: 'translate', done: 0, total: chunks.length, aborted: false };
    report('translate', 0, 0, chunks.length);
    try {
      await mapLimit(chunks, st.concurrency, async (chunk) => {
        if (current.aborted) return;
        try { await translateChunkSmart(chunk, st); } catch (e) { /* 单块失败跳过 */ }
        current.done++;
        report('translate', Math.round((current.done / current.total) * 100), current.done, current.total);
      });
      if (!current.aborted && st.polishEnabled) await polish(st);
      return { ok: true, translated: current.done, polished: current.stage === 'polish' };
    } finally {
      current.running = false;
      report(current.stage || 'translate', current.aborted ? 0 : 100, current.done, current.total);
      if (dynPending.length) flushDynamic().catch(() => {});
    }
  }

  /** 动态内容小批量翻译(静默,不占主进度) */
  async function translateNodes(nodes, st) {
    const fresh = nodes.filter((n) => document.contains(n) && !originals.has(n) && (n.nodeValue || '').trim());
    if (!fresh.length) return;
    const chunks = Chunker.buildChunks([{ nodes: fresh }], st.chunkSize);
    await mapLimit(chunks, st.concurrency, async (chunk) => {
      try { await translateChunkSmart(chunk, st); } catch (e) { /* 动态翻译失败静默 */ }
    });
  }

  async function flushDynamic() {
    if (current && current.running) return; // 等主流程结束再翻
    if (!dynPending.length) return;
    const st = await Lib.loadSettings();
    const todo = dynPending.filter((n) => document.contains(n) && !originals.has(n));
    dynPending = [];
    if (todo.length) await translateNodes(todo, st).catch(() => {});
  }

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeType === Node.TEXT_NODE) {
            if ((n.nodeValue || '').trim()) dynPending.push(n);
          } else if (n.nodeType === Node.ELEMENT_NODE && n.tagName !== 'SCRIPT' && n.tagName !== 'STYLE') {
            const blocks = Chunker.collectBlocks(n);
            for (const b of blocks) for (const nd of b.nodes) dynPending.push(nd);
          }
        }
      }
      if (dynTimer) clearTimeout(dynTimer);
      dynTimer = setTimeout(() => { dynTimer = null; flushDynamic().catch(() => {}); }, 600);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function restorePage() {
    for (const [nd, orig] of originals) {
      if (document.contains(nd) && nd.nodeValue !== orig) nd.nodeValue = orig;
    }
    originals = new Map();
    current = null;
    report('translate', 0, 0, 0);
    return { ok: true };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === 'translate') {
      if (window.top === window) {
        Lib.loadSettings().then((st) => translatePage(st).then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e) })));
        return true;
      }
      Lib.loadSettings().then((st) => translatePage(st).catch(() => {})).catch(() => {});
      return false;
    }
    if (msg.type === 'restore') {
      const r = restorePage();
      if (window.top === window) sendResponse(r);
      return false;
    }
    if (msg.type === 'stop') {
      if (current) current.aborted = true;
      if (window.top === window) sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  // 启动:动态翻译观察 + 可选的加载后自动翻译
  Lib.loadSettings().then((st) => {
    if (st.translateDynamic) startObserver();
    if (st.translateOnLoad && !window.__aiTransLoaded) {
      window.__aiTransLoaded = true;
      setTimeout(() => translatePage(st).catch(() => {}), 800);
    }
  });
})();

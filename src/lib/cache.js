/* lib/cache.js —— 翻译/图片结果缓存(background + content 共用)
 *
 * 参考:沉浸式(全局 cache:true)、kiss-translator(cacheDigest 三级降级:
 *       WebCrypto SHA-256 → background 代算 → 本地稳定 hash)。
 * 缓存键包含 targetLang / model / 术语摘要,避免切换模型或术语表后命中脏数据。
 */
'use strict';
(function (global) {
  const STORE_KEY = 'lfCacheV1';
  const LIMIT = 2000;          // 条数上限(LRU 淘汰)

  function fnv1a(str) {
    let h = 0x811c9dc5;
    const s = String(str);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(36);
  }

  /** 第二个独立哈希(djb2 变体,反向遍历)→ 与 fnv1a 组合成 ~64 位,避免 2000 条量级下碰撞命中错译文 */
  function djb2r(str) {
    let h = 5381;
    const s = String(str);
    for (let i = s.length - 1; i >= 0; i--) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }

  /** 缓存键:原文 + 目标语言 + 模型 + 术语摘要 */
  function keyFor(src, lang, model, termDigest) {
    const s = String(src == null ? '' : src);
    const payload = s + '\u0000' + (lang || '') + '\u0000' + (model || '') + '\u0000' + (termDigest || '');
    return fnv1a(payload) + djb2r(payload) + ':' + s.length;
  }

  const toHex = (buf) => Array.prototype.map.call(new Uint8Array(buf), (x) => x.toString(16).padStart(2, '0')).join('');

  /** 内容摘要:WebCrypto → background 代算 → 本地 FNV(缓存签名不能阻断主流程) */
  async function digest(text, salt) {
    const payload = String(text == null ? '' : text) + '\u0000' + (salt || '');
    try {
      if (global.crypto && global.crypto.subtle && global.TextEncoder) {
        const buf = await global.crypto.subtle.digest('SHA-256', new global.TextEncoder().encode(payload));
        return toHex(buf);
      }
    } catch (e) { /* 受限页面无 WebCrypto → 降级 */ }
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        const r = await new Promise((res) => {
          let done = false;
          const fin = (v) => { if (!done) { done = true; res(v); } };
          try { chrome.runtime.sendMessage({ type: 'digest', text: payload }, (v) => { void chrome.runtime.lastError; fin(v); }); }
          catch (e) { fin(null); }
          setTimeout(() => fin(null), 5000);           // 后台无响应不能让术语预分析卡死
        });
        if (r && r.ok && r.digest) return r.digest;
      }
    } catch (e) { /* 忽略 */ }
    return fnv1a(payload);
  }

  const defaultStorage = () => {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return null;
    return {
      get: (k) => new Promise((r) => { try { chrome.storage.local.get({ [k]: null }, (v) => r(v[k])); } catch (e) { r(null); } }),
      set: (o) => new Promise((res, rej) => {
        try {
          chrome.storage.local.set(o, () => {
            const err = chrome.runtime.lastError;      // 配额满/上下文失效 → 让上层知道并重试
            if (err) rej(new Error(err.message)); else res();
          });
        } catch (e) { rej(e); }
      }),
    };
  };

  let writeChain = Promise.resolve();      // 同一页面内多个实例串行落盘(跨标签页靠"读-合并-写"兜底)

  /**
   * LRU 缓存。persist=false 时纯内存(单测/临时)。
   * storage 可注入(便于测试),默认用 chrome.storage.local。
   */
  function create(opts = {}) {
    const max = opts.max || LIMIT;
    const persist = opts.persist !== false;
    const storage = opts.storage || defaultStorage();
    const m = new Map();
    let dirty = false, flushTimer = null;

    let unloadHooked = false;
    const hookUnload = () => {                       // 页面隐藏/卸载前把防抖中的缓存落盘
      if (unloadHooked || typeof addEventListener !== 'function') return;
      unloadHooked = true;
      const onHide = () => { try { flush(); } catch (e) { /* 忽略 */ } };
      try { addEventListener('pagehide', onHide, { capture: true }); } catch (e) {}
      try { addEventListener('beforeunload', onHide, { capture: true }); } catch (e) {}
      try {
        if (typeof document !== 'undefined' && document.addEventListener) {
          document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') onHide(); }, { capture: true });
        }
      } catch (e) {}
    };
    const schedule = () => {
      if (!persist || !storage || flushTimer) return;
      hookUnload();
      flushTimer = setTimeout(() => { flushTimer = null; flush(); }, 1500);
    };
    /**
     * 落盘。默认「读-合并-写」:多标签同时翻译时不能把别人刚写的条目覆盖掉
     * (本页条目优先——是最新值)。wipe=true 直接写空(clear 用)。
     * 返回 promise:调用方可等待真正写完(内容脚本里 fire-and-forget 也安全)。
     */
    const flush = ({ wipe = false } = {}) => {
      if (!persist || !storage) return Promise.resolve();
      if (!dirty && !wipe) return writeChain;
      const mine = wipe ? [] : [...m];
      dirty = false;                                     // 乐观清除:避免同一条数据反复重写
      writeChain = writeChain
        .then(() => (wipe ? null : storage.get(STORE_KEY)))
        .then((stored) => {
          const merged = new Map();
          if (!wipe) {
            const prev = stored && Array.isArray(stored.e) ? stored.e : [];
            for (const [k, v] of prev) merged.set(k, v);
          }
          for (const [k, v] of mine) merged.set(k, v);
          while (merged.size > max) merged.delete(merged.keys().next().value);
          return storage.set({ [STORE_KEY]: { v: 1, ts: Date.now(), e: [...merged] } });
        })
        .catch(() => { dirty = true; });                 // 写失败 → 保留脏标记,下次再试
      return writeChain;
    };
    const touch = (k) => {
      const v = m.get(k);
      if (v !== undefined) { m.delete(k); m.set(k, v); }
      return v;
    };

    return {
      get: (k) => touch(k),
      has: (k) => m.has(k),
      put(k, v) {
        if (v === undefined || v === null) return;
        m.delete(k); m.set(k, v);
        while (m.size > max) m.delete(m.keys().next().value);
        dirty = true; schedule();
      },
      del(k) { const had = m.delete(k); if (had) { dirty = true; schedule(); } return had; },
      size: () => m.size,
      clear() { m.clear(); dirty = true; return flush({ wipe: true }); },
      flush,
      async load() {
        if (!persist || !storage) return this;
        try {
          const j = await storage.get(STORE_KEY);
          if (j && Array.isArray(j.e)) {
            m.clear();
            // 只保留最近的 max 条:Map 的插入顺序即 LRU 顺序,超限的老数据直接丢
            const keep = j.e.slice(Math.max(0, j.e.length - max));
            for (const [k, v] of keep) m.set(k, v);
            if (keep.length !== j.e.length) dirty = true;
          }
        } catch (e) { /* 忽略 */ }
        return this;
      },
      stats: () => ({ size: m.size, max }),
    };
  }

  const api = { STORE_KEY, LIMIT, fnv1a, djb2r, keyFor, digest, create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.LFCache = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

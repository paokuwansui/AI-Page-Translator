/* content/rag.js —— 页面片段检索(BM25-lite)+ 上下文拼装
 *
 * 纯函数、零依赖:中文用 bigram、英文用词;标题命中加权、位置微加权、噪声降权。
 * 目的是「长页面问答不用把整页塞给模型」——只送与问题最相关的分片。
 */
'use strict';
(function (global) {
  const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;

  function tokenize(text) {
    const out = [];
    const s = String(text == null ? '' : text);
    for (const w of (s.toLowerCase().match(/[a-z0-9_]+/g) || [])) if (w.length > 1) out.push(w);
    const runs = s.match(/[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]+/g) || [];
    for (const run of runs) {
      if (run.length === 1) { out.push(run); continue; }
      for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
    }
    return out;
  }

  /** BM25(k1=2.2, b=0.75)+ 标题命中 ×1.6 + 噪声 ×0.6 + 位置微加权 */
  function pickChunks(chunks, query, opts = {}) {
    const list = Array.isArray(chunks) ? chunks.filter((c) => c && c.text) : [];
    if (!list.length) return [];
    const k = opts.k || 8;
    const budget = opts.budget || 12000;
    const N = list.length;
    const tfs = list.map((c) => {
      const m = new Map();
      for (const t of tokenize(c.text + ' ' + (c.heading || ''))) m.set(t, (m.get(t) || 0) + 1);
      return m;
    });
    const avgdl = list.reduce((a, c) => a + (c.chars || c.text.length), 0) / N || 1;
    const df = new Map();
    for (const m of tfs) for (const t of m.keys()) df.set(t, (df.get(t) || 0) + 1);

    const qTokens = tokenize(query);
    const qLower = String(query || '').toLowerCase();
    const scored = list.map((c, i) => {
      let s = 0;
      const dl = c.chars || c.text.length;
      for (const q of qTokens) {
        const f = tfs[i].get(q) || 0;
        if (!f) continue;
        const n = df.get(q) || 0;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        s += idf * (f * 2.2) / (f + 1.2 * (1 - 0.75 + 0.75 * dl / avgdl));
      }
      const heading = String(c.heading || '');
      if (heading && (qLower && heading.toLowerCase().includes(qLower))) s *= 1.6;
      else if (heading && qTokens.some((q) => tokenize(heading).indexOf(q) >= 0)) s *= 1.25;
      if (c.noise) s *= 0.6;
      s *= 1 + 0.15 * (1 - i / N);
      return { c, s };
    });

    scored.sort((a, b) => b.s - a.s);
    const picked = [];
    let used = 0;
    for (const { c, s } of scored) {
      if (s <= 0) continue;
      if (picked.length >= k) break;
      const len = c.text.length;
      // 超预算的片段:跳过它继续看更小的(原先直接 break → 一个巨型片段会把后面的全挡掉)
      if (used + len > budget) { if (picked.length) continue; }
      // 单个片段就超过整个预算 → 截断后再用,避免一次把上下文撑爆
      const text = (len > budget) ? c.text.slice(0, budget) : c.text;
      picked.push(text === c.text ? c : Object.assign({}, c, { text }));
      used += text.length;
    }
    return picked;
  }

  /** 拼装上下文:页面元信息 + 大纲 + 命中片段(带编号,便于模型写 [[n]] 引用) */
  function buildContext(reader, picked) {
    const m = (reader && reader.meta) || {};
    const lines = ['[页面] ' + (m.title || '') + (m.url ? ' — ' + m.url : '')];
    if (reader && reader.outline && reader.outline.length) {
      lines.push('[大纲] ' + reader.outline.slice(0, 40)
        .map((h) => '  '.repeat(Math.max(0, (h.level || 1) - 1)) + '· ' + h.text).join(' | '));
    }
    for (const c of (picked || [])) {
      lines.push('[片段 ' + c.id + (c.heading ? '｜' + c.heading : '') + '] ' + c.text);
    }
    return lines.join('\n');
  }

  /** 全页资料(整会话固定不变的那部分:meta + 大纲 + 开篇)—— 便于命中上游 prompt cache */
  function buildDigest(reader, headChars = 1200) {
    const m = (reader && reader.meta) || {};
    const parts = ['页面标题:' + (m.title || ''), 'URL:' + (m.url || '')];
    if (m.description) parts.push('页面描述:' + m.description);
    if (reader && reader.outline && reader.outline.length) {
      parts.push('大纲:\n' + reader.outline.slice(0, 40).map((h) => '  '.repeat(Math.max(0, (h.level || 1) - 1)) + '· ' + h.text).join('\n'));
    }
    if (reader && reader.chunks && reader.chunks.length) {
      parts.push('开篇内容:\n' + reader.chunks.slice(0, 3).map((c) => c.text).join('\n').slice(0, headChars));
    }
    if (reader && reader.images && reader.images.length) {
      parts.push('页面图片:' + reader.images.slice(0, 8).map((i) => (i.alt ? i.alt : '(无描述)')).join(' / '));
    }
    const fr = (reader && reader.stats && reader.stats.frames) || null;
    if (fr && (fr.included || fr.crossOrigin)) {
      parts.push('内嵌框(iframe):已并入资料 ' + (fr.included || 0) + ' 个'
        + (fr.crossOrigin ? ';另有 ' + fr.crossOrigin + ' 个跨域框内容读不到(用户问到就如实说明)' : ''));
    }
    return parts.join('\n');
  }

  const api = { tokenize, pickChunks, buildContext, buildDigest };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.LFRag = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* content/chunker.js —— DOM 文本收集 / 切片 / 哨兵编解码 */
'use strict';
(function (global) {
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE', 'SVG', 'CANVAS',
    'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'IFRAME', 'VIDEO', 'AUDIO', 'OBJECT', 'EMBED', 'MATH']);
  const BLOCK_TAGS = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'LI', 'TD', 'TH', 'BLOCKQUOTE', 'DD', 'DT', 'FIGCAPTION', 'SUMMARY', 'HGROUP']);
  const S = '\u27E6';            // ⟦
  const E = '\u27E7';            // ⟧
  const SENT_RE = new RegExp(S + '(\\d+)' + E, 'g');

  function isSkippedLeaf(node, root) {
    const el = node.parentElement;
    if (!el) return true;
    let a = el;
    while (a && a !== root) {
      if (SKIP_TAGS.has(a.tagName)) return true;
      const tr = a.getAttribute && a.getAttribute('translate');
      if (tr && tr.toLowerCase() === 'no') return true;
      if (a.classList && a.classList.contains('notranslate')) return true;
      a = a.parentElement;
    }
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return true;
    if (el.closest('[hidden]')) return true;
    return !(node.nodeValue || '').trim();
  }

  function nearestBlock(el, root) {
    let a = el;
    while (a && a !== root) { if (BLOCK_TAGS.has(a.tagName)) return a; a = a.parentElement; }
    return null;
  }

  /** 收集 [{ block, nodes:[TextNode...] }]，按文档顺序 */
  function collectBlocks(root) {
    const doc = root.ownerDocument || document;
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => isSkippedLeaf(n, root) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
    });
    const groups = new Map(), order = [];
    let n;
    while ((n = walker.nextNode())) {
      const block = nearestBlock(n.parentElement, root) || root;
      if (!groups.has(block)) { groups.set(block, []); order.push(block); }
      groups.get(block).push(n);
    }
    return order.map((b) => ({ block: b, nodes: groups.get(b) }));
  }

  /** 把节点流按字符预算切成 chunk（chunk = 一组节点，可跨块） */
  function buildChunks(blocks, budget = 1500) {
    const chunks = [];
    let cur = [], len = 0;
    for (const { nodes } of blocks) {
      for (const nd of nodes) {
        const t = nd.nodeValue || '';
        if (len + t.length > budget && cur.length) { chunks.push(cur); cur = []; len = 0; }
        cur.push(nd); len += t.length;
      }
    }
    if (cur.length) chunks.push(cur);
    return chunks;
  }

  /** 拼接请求文本：⟦0⟧文本A⟦1⟧文本B */
  function makeChunkText(nodes) {
    return nodes.map((nd, i) => S + i + E + (nd.nodeValue || '')).join('');
  }

  /** 解析响应为按 index 的译文数组；格式不符返回 null。
   *  以哨兵开头、不以哨兵结尾(丢段)、索引完整连续才视为合法；
   *  段数是否与请求一致由调用方比对 arr.length。 */
  function parseChunkText(resp) {
    if (typeof resp !== 'string') return null;
    const parts = resp.split(SENT_RE);
    if (parts.length < 3) return null;
    if (parts[0] !== '') return null;                     // 必须以哨兵开头
    if (parts[parts.length - 1] === '') return null;      // 以哨兵结尾 = 丢段
    const out = [];
    for (let i = 1; i < parts.length; i += 2) out[Number(parts[i])] = parts[i + 1];
    for (let i = 0; i < out.length; i++) if (out[i] === undefined || out[i] === '') return null;
    return out;
  }

  /** 流式增量解析:从部分响应文本提取"已完整"的哨兵段。
   *  最后一段若可能仍在生成(其后没有新哨兵开头)则保守不返回,等流结束用 parseChunkText 补齐。 */
  function extractCompleteSegs(partial) {
    if (typeof partial !== 'string' || !partial) return [];
    const re = new RegExp(S + '(\\d+)' + E + '([^' + S + ']*)', 'g');
    const segs = [];
    let m, end = 0;
    while ((m = re.exec(partial))) { segs.push({ idx: Number(m[1]), text: m[2] }); end = re.lastIndex; }
    if (!segs.length) return [];
    const tail = partial.slice(end);
    if (tail.startsWith(S)) return segs; // 尾部还有(未闭合的)哨兵,前面段已闭合,全部完整
    return segs.slice(0, -1);            // 最后一段可能未生成完,等流结束用 parseChunkText 补齐
  }

  const api = { collectBlocks, buildChunks, makeChunkText, parseChunkText, extractCompleteSegs };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.Chunker = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* content/chunker.js —— DOM 文本/属性收集 · 切片 · 哨兵编解码
 *
 * 翻译目标(Target)抽象:文本节点与属性统一为 {kind, get(), set()},
 * 使「属性翻译」复用同一条分块/哨兵/回填管道。
 * 目标对象按 DOM 元素缓存(WeakMap),保证幂等判定(originals.has)跨次收集稳定。
 */
'use strict';
(function (global) {
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE', 'SVG', 'CANVAS',
    'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'IFRAME', 'VIDEO', 'AUDIO', 'OBJECT', 'EMBED', 'MATH']);
  const BLOCK_TAGS = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'ASIDE', 'NAV', 'HEADER', 'FOOTER',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'TD', 'TH', 'BLOCKQUOTE', 'DD', 'DT', 'FIGCAPTION',
    'SUMMARY', 'HGROUP', 'FORM', 'LABEL', 'FIGURE', 'CAPTION', 'ADDRESS', 'DIALOG']);
  const PANEL_HOST_ID = 'lf-panel-host';       // 页内对话面板宿主:永不翻译自身
  const ATTRS = ['placeholder', 'title', 'alt', 'aria-label'];
  const S = '\u27E6';            // ⟦
  const E = '\u27E7';            // ⟧
  const SENT_RE = new RegExp(S + '(\\d+)' + E, 'g');

  /* ---------------- Target 抽象 ---------------- */

  const Target = {
    text(node) {
      return { kind: 'text', el: node, get: () => node.nodeValue || '', set: (v) => { node.nodeValue = v; } };
    },
    attr(el, name) {
      return { kind: 'attr', el, name, get: () => el.getAttribute(name) || '', set: (v) => { el.setAttribute(name, v); } };
    },
    prop(el, name) {                            // input.value 这类「属性无关」的活值
      return { kind: 'attr', el, name, prop: true, get: () => el[name] || '', set: (v) => { el[name] = v; } };
    },
  };

  const tCache = new WeakMap();
  const aCache = new WeakMap();
  /** 同一文本节点始终返回同一 Target 对象 —— 幂等/去重依赖对象身份 */
  function textTargetOf(node) {
    let t = tCache.get(node);
    if (!t) { t = Target.text(node); tCache.set(node, t); }
    return t;
  }
  /** 同一元素+属性名始终返回同一 Target(prop 与 attr 分开缓存,避免冲突) */
  function attrTargetOf(el, name, isProp) {
    let map = aCache.get(el);
    if (!map) { map = new Map(); aCache.set(el, map); }
    const k = (isProp ? 'p:' : 'a:') + name;
    let t = map.get(k);
    if (!t) { t = isProp ? Target.prop(el, name) : Target.attr(el, name); map.set(k, t); }
    return t;
  }

  /** 读取任意 target(或历史遗留的 {nodeValue} 假对象)的当前文本 */
  function getText(t) {
    if (!t) return '';
    if (typeof t.get === 'function') return t.get() || '';
    return t.nodeValue || '';
  }

  /* ---------------- 遍历工具(跨影子边界) ---------------- */

  /** 沿父链向上;到影子根时跳到 host,到 root 停 */
  function up(a, root) {
    if (!a) return null;
    if (a === root) return root;
    if (a.parentElement) return a.parentElement;
    const r = a.getRootNode ? a.getRootNode() : null;
    return r && r.host ? r.host : null;
  }

  /** 收集 root 下全部「开放」shadow root(含嵌套),BFS + 去重 */
  function collectShadowRoots(root) {
    const out = [], seen = new Set(), q = [root];
    while (q.length) {
      const r = q.shift();
      if (!r || !r.querySelectorAll) continue;
      let all;
      try { all = r.querySelectorAll('*'); } catch (e) { continue; }
      for (const el of all) {
        const sr = el.shadowRoot;
        if (sr && !seen.has(sr)) { seen.add(sr); out.push(sr); q.push(sr); }
      }
    }
    return out;
  }

  /** 永久跳过:脚本/样式/代码块/输入控件/translate=no/.notranslate/面板自身/空白 */
  function isHardSkip(node, root) {
    if (!node || node.nodeType !== 3) return true;
    let el = node.parentElement;
    if (!el) {
      // 裸文本节点直接挂在 ShadowRoot(nodeType 11)下时没有 parentElement:
      // 拿宿主元素当容器继续做跳过判定,否则这类文本永远收不到(某些 Web Components 就这么写)
      const pn = node.parentNode;
      if (pn && pn.nodeType === 11 && pn.host && pn.host.nodeType === 1) el = pn.host;
    }
    if (!el) return true;
    for (let a = el; a; a = up(a, root)) {
      if (a === root) break;
      if (a.nodeType === 1) {
        if (SKIP_TAGS.has(a.tagName)) return true;
        if (a.id === PANEL_HOST_ID) return true;
        if (a.classList && a.classList.contains('notranslate')) return true;
        const tr = a.getAttribute && a.getAttribute('translate');
        if (tr && String(tr).toLowerCase() === 'no') return true;
      }
    }
    return !(node.nodeValue || '').trim();
  }

  /** 隐藏(不是跳过):折叠/懒加载/隐藏 tab —— 仍翻译,但降为最低优先级 */
  function isHiddenEl(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.closest && el.closest('[hidden]')) return true;
    let cs = null;
    try { cs = getComputedStyle(el); } catch (e) { return false; }
    if (!cs) return false;
    return cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0';
  }

  function nearestBlock(el, root) {
    let a = el;
    while (a && a !== root) {
      if (a.nodeType === 1 && BLOCK_TAGS.has(a.tagName)) return a;
      a = up(a, root);
    }
    return null;
  }

  /* ---------------- 属性目标 ---------------- */

  function makeTargetsForAttrEl(el) {
    if (!el || !el.getAttribute) return [];
    if (el.id === PANEL_HOST_ID || (el.closest && el.closest('#' + PANEL_HOST_ID))) return [];
    const out = [];
    for (const name of ATTRS) {
      const v = el.getAttribute(name);
      if (v && v.trim().length > 1 && /[A-Za-z\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(v)) {
        out.push(attrTargetOf(el, name, false));
      }
    }
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (el.tagName === 'INPUT' && /^(button|submit|reset)$/.test(type)) {
      const v = el.value;
      if (v && v.trim().length > 1) out.push(attrTargetOf(el, 'value', true));
    }
    return out;
  }

  const ATTR_SELECTOR = 'input[placeholder],input[title],input[value],img[alt],*[title],[aria-label]';

  /* ---------------- 超长文本切分 ---------------- */

  const SENT_END = /[.。!！?？;；:：]/;
  const splitDone = new WeakSet();

  /** 在 ≤max 的前提下优先在句末标点/空白处切;返回每段结束偏移(最后一段为余下部分) */
  function cutPoints(text, max) {
    const out = [];
    if (!text || max < 2) return out;
    const min = Math.max(1, Math.floor(max * 0.6));
    let seg = 0;
    while (text.length - seg > max) {
      const hard = Math.min(seg + max, text.length);
      let cut = -1;
      for (let i = hard; i > seg + min; i--) {
        const ch = text[i - 1];
        if (SENT_END.test(ch) || ch === '\n') { cut = i; break; }
      }
      if (cut < 0) for (let i = hard; i > seg + min; i--) { if (/\s/.test(text[i - 1])) { cut = i; break; } }
      if (cut < 0) cut = hard;                       // 无标点无空格(CJK 长串)→ 硬切
      out.push(cut);
      seg = cut;
    }
    return out;
  }

  /** 物理切分超长文本节点(仅「纯文本块级容器」,避免破坏行内元素流);返回切出的段数 */
  function splitLongText(node, max = 600) {
    if (!node || node.nodeType !== 3) return 0;
    const text = node.nodeValue || '';
    if (text.length <= max) return 0;
    const p = node.parentElement;
    if (!p || p.childNodes.length !== 1) return 0;
    if (!BLOCK_TAGS.has(p.tagName) && p.tagName !== 'BODY') return 0;
    if (splitDone.has(p)) return 0;
    splitDone.add(p);
    const bounds = cutPoints(text, max);
    if (!bounds.length) return 0;
    let cur = node, consumed = 0;
    for (const b of bounds) {
      const at = b - consumed;
      if (at <= 0 || at >= (cur.nodeValue || '').length) continue;
      cur = cur.splitText(at);
      consumed = b;
    }
    return bounds.length;
  }

  /* ---------------- 收集 ---------------- */

  /**
   * 收集 [{ block, targets:[Target...] }],按文档顺序。
   * opts: { shadow=true, attrs=true, splitLong=true, splitMax=600, hidden=true }
   */
  function collectBlocks(root, opts = {}) {
    const groups = new Map(), order = [];
    const push = (block, t) => {
      if (!groups.has(block)) { groups.set(block, []); order.push(block); }
      groups.get(block).push(t);
    };
    if (!root) return [];
    const wantHidden = opts.hidden !== false;
    const hidCache = new WeakMap();
    const hiddenOf = (el) => {
      if (!wantHidden || !el || el.nodeType !== 1) return false;
      if (hidCache.has(el)) return hidCache.get(el);
      const v = isHiddenEl(el);
      hidCache.set(el, v);
      return v;
    };

    const roots = [root];
    if (opts.shadow !== false) {
      for (const sr of collectShadowRoots(root)) roots.push(sr);
    }

    for (const r of roots) {
      const doc = r.ownerDocument || document;
      if (!r.querySelectorAll && !doc.createTreeWalker) continue;
      try {
        const walker = doc.createTreeWalker(r, NodeFilter.SHOW_TEXT, {
          acceptNode: (n) => (isHardSkip(n, r) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
        });
        let n;
        while ((n = walker.nextNode())) {
          if (opts.splitLong !== false) splitLongText(n, opts.splitMax || 600);
          const block = nearestBlock(n.parentElement, r) || r;
          const t = textTargetOf(n);
          t.hidden = hiddenOf(n.parentElement);
          push(block, t);
        }
      } catch (e) { /* 跨域/异常子树跳过 */ }

      if (opts.attrs !== false && r.querySelectorAll) {
        let els;
        try { els = r.querySelectorAll(ATTR_SELECTOR); } catch (e) { els = []; }
        for (const el of els) {
          const block = nearestBlock(el, r) || r;
          for (const t of makeTargetsForAttrEl(el)) { t.hidden = hiddenOf(el); push(block, t); }
        }
      }
    }
    return order.map((b) => ({ block: b, targets: groups.get(b) }));
  }

  /** head 文本:标题 + meta description(T1.10) */
  function collectHeadTargets(doc = document) {
    const out = [];
    const titleEl = doc.querySelector('title');
    if (titleEl && titleEl.firstChild && titleEl.firstChild.nodeType === 3) {
      out.push({ block: doc.head || titleEl, targets: [textTargetOf(titleEl.firstChild)] });
    }
    const meta = doc.querySelector('meta[name="description"],meta[property="og:description"]');
    if (meta && meta.getAttribute('content')) {
      out.push({ block: doc.head || meta, targets: [attrTargetOf(meta, 'content', false)] });
    }
    return out;
  }

  /* ---------------- 同构重复块检测(沉浸式 batchPattern 思路) ---------------- */

  /** 结构签名:标签 + 前几个子元素标签 + 文本长度量级 */
  function blockSignature(b) {
    const el = b && b.block;
    if (!el) return '';
    const childTags = el.children ? Array.from(el.children).slice(0, 4).map((c) => c.tagName).join(',') : '';
    const len = (b.targets || []).reduce((a, t) => a + getText(t).length, 0);
    return el.tagName + '|' + childTags + '|' + Math.round(len / 40);
  }

  /** 同一父容器下 ≥minCount 个同构块 → 返回 block → 组序号;用于「让重复块排到相邻位置,
   *  自然落入同一次请求」,从而保证列表/表格的措辞一致(不改变翻译内容,只改顺序) */
  function repeatGroupRank(blocks, minCount = 3) {
    const byParent = new Map();
    for (const b of blocks) {
      const p = b && b.block && b.block.parentElement;
      if (!p) continue;
      if (!byParent.has(p)) byParent.set(p, []);
      byParent.get(p).push(b);
    }
    const ranks = new Map();
    let rank = 0;
    for (const list of byParent.values()) {
      if (list.length < minCount) continue;
      const counts = new Map();
      for (const b of list) {
        const sig = blockSignature(b);
        counts.set(sig, (counts.get(sig) || 0) + 1);
      }
      let bestSig = null, bestN = 0;
      for (const [k, v] of counts) if (v > bestN) { bestN = v; bestSig = k; }
      if (bestN >= minCount) {
        rank++;
        for (const b of list) if (blockSignature(b) === bestSig) ranks.set(b, rank);
      }
    }
    return ranks;
  }

  /* ---------------- 切块 / 编解码 ---------------- */

  /** 按字符预算切块(chunk = 一组 target,可跨块) */
  function buildChunks(blocks, budget = 1500) {
    const chunks = [];
    let cur = [], len = 0;
    for (const b of blocks) {
      const list = b.targets || b.nodes || [];
      for (const t of list) {
        const s = getText(t);
        if (len + s.length > budget && cur.length) { chunks.push(cur); cur = []; len = 0; }
        cur.push(t); len += s.length;
      }
    }
    if (cur.length) chunks.push(cur);
    return chunks;
  }

  /** 拼接请求文本:⟦0⟧文本A⟦1⟧文本B */
  function makeChunkText(targets) {
    return targets.map((t, i) => S + i + E + getText(t)).join('');
  }

  /** 稀疏容错解析:返回 { map:Map<idx,text>, complete:boolean }。
   *  1) 正常按哨兵解析,能解出多少算多少(缺段由调用方重试);
   *  2) 哨兵全丢但非空行数 == 期望段数 → 按行序修复(模型最常见的失格式方式)。 */
  function parseSegments(resp, expectCount) {
    const map = new Map();
    if (typeof resp !== 'string' || !resp) return { map, complete: false };
    if (resp.indexOf(S) === -1) {
      if (!expectCount || expectCount < 1) return { map, complete: false };
      const lines = resp.replace(/\r/g, '').split('\n')
        .map((s) => s.trim())
        .filter((s) => s && !/^```/.test(s));
      // 行序修复是"启发式":行数恰好吻合也可能是垃圾/提示词回声 → 打 fixed 标记,由调用方质检
      if (lines.length === expectCount) { lines.forEach((t, i) => map.set(i, t)); return { map, complete: true, fixed: true }; }
      return { map, complete: false };
    }
    const re = new RegExp(S + '(\\d+)' + E + '([\\s\\S]*?)(?=' + S + '\\d+' + E + '|$)', 'g');
    let m;
    while ((m = re.exec(resp))) {
      const i = Number(m[1]);
      const t = m[2].replace(/\s+$/, '');
      if (Number.isInteger(i) && i >= 0 && t !== '') map.set(i, t);
    }
    const complete = !!expectCount && expectCount >= 1 && map.size === expectCount
      && [...map.keys()].every((k) => k < expectCount);
    return { map, complete };
  }

  /** 严格解析(legacy):格式不符返回 null。以哨兵开头、不以哨兵结尾、段段非空。 */
  function parseChunkText(resp) {
    if (typeof resp !== 'string') return null;
    const parts = resp.split(SENT_RE);
    if (parts.length < 3) return null;
    if (parts[0] !== '') return null;
    if (parts[parts.length - 1] === '') return null;
    const out = [];
    for (let i = 1; i < parts.length; i += 2) out[Number(parts[i])] = parts[i + 1];
    for (let i = 0; i < out.length; i++) if (out[i] === undefined || out[i] === '') return null;
    return out;
  }

  /** 流式增量解析:从部分响应文本提取"已完整"的哨兵段 */
  function extractCompleteSegs(partial) {
    if (typeof partial !== 'string' || !partial) return [];
    const re = new RegExp(S + '(\\d+)' + E + '([^' + S + ']*)', 'g');
    const segs = [];
    let m, end = 0;
    while ((m = re.exec(partial))) { segs.push({ idx: Number(m[1]), text: m[2] }); end = re.lastIndex; }
    if (!segs.length) return [];
    const tail = partial.slice(end);
    if (tail.startsWith(S)) return segs;
    return segs.slice(0, -1);
  }

  const api = {
    SKIP_TAGS, BLOCK_TAGS, PANEL_HOST_ID, ATTRS,
    Target, getText, textTargetOf, attrTargetOf, up, collectShadowRoots,
    isHardSkip, isHiddenEl, nearestBlock, makeTargetsForAttrEl,
    cutPoints, splitLongText, collectBlocks, collectHeadTargets, blockSignature, repeatGroupRank,
    buildChunks, makeChunkText, parseSegments, parseChunkText, extractCompleteSegs,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.Chunker = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

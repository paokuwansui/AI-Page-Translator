/* content/content.js —— 页面翻译主流程
 *
 * 管道: 术语先行 → 收集(Target:文本+属性/影子DOM/head) → 缓存命中回填
 *      → 视口优先调度(IntersectionObserver) → 批聚合 + 并发池 + 令牌桶限速
 *      → SSE 流式按段回填 → 稀疏解析 + 缺失段重试 → 流水线润色(与快翻重叠)
 */
'use strict';
(() => {
  if (typeof Chunker === 'undefined' || typeof Lib === 'undefined') return;
  const PoolLib = (typeof LFPool !== 'undefined') ? LFPool
    : (typeof require === 'function' ? require('../lib/pool.js') : null);
  const CacheLib = (typeof LFCache !== 'undefined') ? LFCache
    : (typeof require === 'function' ? require('../lib/cache.js') : null);

  const PANEL_HOST_ID = Chunker.PANEL_HOST_ID || 'lf-panel-host';
  const IO_MARGIN = '0px 0px 35% 0px';        // 沉浸式 deferredRenderRootMargin 同款

  let originals = new Map();        // Target -> 原文
  const wrote = new WeakMap();      // Target -> 我们最后写入的值
  const revs = new WeakMap();       // Target -> 版本号(快翻每次更新 +1,用于润色竞态守卫)
  let polishedOk = new WeakSet();    // 已被润色过的 Target(恢复原文时重置)
  let current = null;
  let observer = null, dynTimer = null, dynPending = [];
  let failedTargets = [];
  let tc = null, pool = null, limiter = null, batcher = null, io = null;
  let st = null;
  let gen = 0;                      // 代际:restore/stop 时 +1,使在途请求的回写失效
  const ioMap = new Map();          // element -> chunk
  const submitted = new WeakSet();
  // 指标对象永不置空:动态内容可能在首次整页翻译之前就触发(float-翻译路径也要能统计)
  let stats = { req: 0, segments: 0, cacheHits: 0, polished: 0, polishBatches: 0, polishApps: 0, polishSkips: 0, retries: 0, throttled: 0 };

  /* ============ 基础工具 ============ */

  /** 元素是否仍在文档中(跨影子树) */
  function inDocument(el) {
    if (!el) return false;
    if (document.contains(el)) return true;
    const r = el.getRootNode ? el.getRootNode() : null;
    if (r && r.host) return inDocument(r.host);
    return false;
  }
  /** 取 Target 对应的"容器元素":文本节点的 parentElement 可能为 null(裸文本直接挂在 ShadowRoot 下),
   *  这时退回宿主元素,否则会被 inDocument() 判成"已离开文档"而整段漏译 */
  const elOf = (t) => {
    if (!t) return null;
    if (t.kind !== 'text') return t.el;
    const n = t.el;
    if (!n) return null;
    if (n.parentElement) return n.parentElement;
    const pn = n.parentNode;
    if (pn && pn.host) return pn.host;
    return pn || null;
  };
  const liveTargets = (list) => list.filter((t) => inDocument(elOf(t)));

  /** 统一写入器:由我们发起的写必须走它,否则会被 observer 误判为「页面改了自己的内容」 */
  function writeTarget(t, v) { t.set(v); wrote.set(t, v); }

  function applyOne(t, tr) {
    if (!t || typeof tr !== 'string' || !tr.trim()) return false;
    // 唯一写入咽喉:没有有效会话(未开始 / 已停止 / 已恢复原文)时,一律不写 DOM。
    // 否则「恢复原文后滚动」或「停止后在途响应」会把译文又写回去。
    if (!current || current.aborted) return false;
    const orig = Chunker.getText(t);
    if (!originals.has(t)) originals.set(t, orig);
    if (tr !== orig) writeTarget(t, tr); else wrote.set(t, tr);
    polishedOk.delete(t);
    return true;
  }
  const done = (t) => originals.has(t);

  /** 页面(SPA)改写了已翻译内容 → 视为新原文 */
  function invalidateIfPageChanged(t) {
    const cur = Chunker.getText(t);
    if (!cur.trim()) return false;
    const w = wrote.get(t);
    if (w !== undefined && w !== cur) {
      originals.delete(t); polishedOk.delete(t);
      bumpRev(t);                       // 关键:作废在途润色,避免旧译文回写覆盖页面的新内容
      return true;
    }
    return false;
  }

  function bumpRev(t) { revs.set(t, (revs.get(t) || 0) + 1); }

  /** 清理"已离开文档"的强引用:originals/failedTargets/ioMap 都是强引用,
   *  SPA 反复挂载卸载节点时不清理会单调涨内存(WeakMap 的 wrote/revs 能自动回收,这些不能)。 */
  function pruneStale(limit = 20000) {
    if (originals.size > limit || failedTargets.length > limit) {
      for (const t of [...originals.keys()]) if (!inDocument(elOf(t))) { originals.delete(t); failedTargets = failedTargets.filter((x) => x !== t); }
      while (originals.size > limit) originals.delete(originals.keys().next().value);   // 硬上限:先丢最老的
    }
    if (ioMap.size) {
      for (const [el, c] of [...ioMap.entries()]) if (!inDocument(el)) { ioMap.delete(el); try { io.unobserve(el); } catch (e) {} void c; }
    }
    if (failedTargets.length > limit) failedTargets = failedTargets.slice(-limit);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ============ 缓存 ============ */

  async function cacheReady(s) {
    if (tc) return tc;
    tc = CacheLib.create({ max: s.cacheMax || 2000 });
    await tc.load();
    return tc;
  }
  function transKey(src) {
    return CacheLib.keyFor(src, st.targetLang, st.model, st.termDigest || '');
  }

  /* ============ 池 / 限速(单例) ============ */

  /** 降级(单段)专用池:绝不能复用主池 —— 主池的任务正在等它,复用会自锁死锁 */
  let fbPool = null;
  function ensureFallbackPool(s) {
    const c = s.fallbackConcurrency || 4;
    if (!fbPool) {
      fbPool = PoolLib.createPool({ concurrency: c, maxRetry: 1, retryInterval: 800, jobTimeout: 180000, limiter });
    }
    fbPool.setConcurrency(c);
    return fbPool;
  }

  function ensurePool(s) {
    if (pool && limiter) {
      pool.setConcurrency(s.concurrency || 12);
      limiter.set({ limit: s.rateLimit || 8, interval: s.rateInterval || 1200 });
      return pool;
    }
    limiter = PoolLib.createRateLimiter({ limit: s.rateLimit || 8, interval: s.rateInterval || 1200 });
    pool = PoolLib.createPool({
      concurrency: s.concurrency || 12,
      maxRetry: 2,
      retryInterval: 1000,
      jobTimeout: 180000,                                  // 兜底:任务永不 settle 也不会永久占槽
      recoverAfter: 15000,                                 // 限流后 15s 无错 → 并发逐级回升(不再只降不升)
      limiter,
      onChange: (o) => { if (o && o.status !== 'recover') stats.throttled++; },
    });
    return pool;
  }

  /* ============ 术语先行(沉浸式 enableAIContext 同款) ============ */

  function parseLooseJSON(raw) {
    if (typeof raw !== 'string') return null;
    let s = raw.trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) s = fence[1].trim();
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
  }

  function sampleText(max) {
    const t = (document.body && document.body.innerText ? document.body.innerText : '') || '';
    return t.slice(0, max);
  }

  /** 页面签名必须与「是否已翻译」无关,否则缓存键每次都会变(术语缓存/翻译缓存都会失效):
   *  标题取原文(originals 里有则用原文),正文样本完全不参与签名 */
  function originalTitle() {
    try {
      const tt = document.querySelector('title');
      const node = tt && tt.firstChild;
      if (!node) return '';
      const tgt = Chunker.textTargetOf(node);
      return originals.has(tgt) ? originals.get(tgt) : (node.nodeValue || '');
    } catch (e) { return ''; }
  }
  function pageSig() {
    return location.origin + location.pathname + location.search + '|' + originalTitle();
  }

  async function preAnalyze(s) {
    const meta = { title: document.title || '', url: location.href };
    const sample = sampleText(3000);
    if (!s.termPreAnalyze) return { terms: [], style: '', topic: '', digest: '' };
    const sig = await CacheLib.digest(pageSig(), s.targetLang + s.model);
    const key = 'terms:' + sig;
    if (s.useCache && tc) {
      const hit = tc.get(key);
      if (hit && hit.digest) return hit;
    }
    const outline = Array.from(document.querySelectorAll('h1,h2,h3')).slice(0, 20).map((h) => h.tagName + ' ' + (h.innerText || '').trim()).join('\n');
    const prompt = '你是翻译预处理器。根据下面的网页信息,产出供机器翻译使用的约束。\n' +
      '输出严格 JSON,不要任何解释、不要代码围栏:\n' +
      '{"terms":[{"src":"原文词","dst":"指定译法"}],"style":"一句话风格指南","topic":"主题"}\n' +
      '要求:terms 只收专有名词/产品名/人名/领域术语(最多 30 条);普通词汇不要收录。\n\n' +
      '标题:' + meta.title + '\nURL:' + meta.url + '\n大纲:\n' + outline + '\n开头正文:\n' + sample;
    let out = { terms: [], style: '', topic: '', digest: sig.slice(0, 12) };
    try {
      stats.req++;
      const raw = await Lib.chatStream(s.baseUrl, s.apiKey, s.model, [{ role: 'user', content: prompt }], () => {});
      const j = parseLooseJSON(raw) || {};
      out = {
        terms: Array.isArray(j.terms) ? j.terms.filter((x) => x && x.src && x.dst).slice(0, 30) : [],
        style: typeof j.style === 'string' ? j.style : '',
        topic: typeof j.topic === 'string' ? j.topic : '',
        digest: sig.slice(0, 12),
      };
    } catch (e) { /* 预分析失败不阻断翻译 */ }
    if (s.useCache && tc) tc.put(key, out);
    return out;
  }

  function termBlockOf(term) {
    if (!term) return '';
    const parts = [];
    if (term.terms && term.terms.length) parts.push('[术语表(必须遵守)]\n' + term.terms.map((t) => t.src + ' → ' + t.dst).join('\n'));
    if (term.style) parts.push('[风格] ' + term.style);
    if (term.topic) parts.push('[主题] ' + term.topic);
    return parts.length ? parts.join('\n') + '\n\n' : '';
  }

  /* ============ 提示词 ============ */

  const sysMsg = { role: 'system', content: 'You are a professional translation engine. Return only the requested output.' };

  function segPrompt(text, s) {
    return (s.termBlock || '') +
      'Translate the text segments below from ' + s.sourceLang + ' to ' + s.targetLang + '.\n' +
      'Keep every separator token (like ' + '\u27e60\u27e7' + ') exactly as-is.\n' +
      'Output ONLY the translated segments joined by the same separators, in the same order and same count.\n' +
      'No explanations, no notes, no code fences.\n\n' + text;
  }
  const singlePrompt = (s, text) => (s.termBlock || '') + 'Translate from ' + s.sourceLang + ' to ' + s.targetLang +
    '. Output ONLY the translation, nothing else.\n\n' + text;
  function polishPrompt(text, s) {
    return (s.termBlock || '') +
      'Below are translations of a web page in ' + s.targetLang + '.\n' +
      'Polish them for consistency and natural phrasing: unify terminology, smooth awkward wording, keep the exact meaning.\n' +
      'Keep every separator token (like ' + '\u27e60\u27e7' + ') exactly as-is.\n' +
      'Output ONLY the polished segments joined by the same separators, in the same order and same count.\n' +
      'No explanations, no notes, no code fences.\n\n' + text;
  }

  /* ============ 进度 ============ */

  function report(stage, pct, doneN, total) {
    if (window.top !== window) return;
    try { Lib.sendMsg({ type: 'badge', pct }); } catch (e) {}
    try { Lib.sendMsg({ type: 'progress', stage, pct, done: doneN, total }); } catch (e) {}
  }

  /* ============ 收集 ============ */

  function collectAll(s) {
    const blocks = Chunker.collectBlocks(document.body, {
      shadow: s.translateShadow !== false,
      attrs: s.translateAttrs !== false,
      splitLong: s.splitLongText !== false,
      splitMax: s.splitMax || 600,
      hidden: s.translateHidden !== false,
    });
    if (s.translateHead !== false) {
      try { for (const b of Chunker.collectHeadTargets(document)) blocks.unshift(b); } catch (e) {}
    }
    return blocks;
  }

  function freshBlocks(blocks) {
    return blocks
      .map((b) => ({ block: b.block, targets: (b.targets || []).filter((t) => !done(t) && Chunker.getText(t).trim()) }))
      .filter((b) => b.targets.length);
  }

  /* ============ 视口调度 ============ */

  function targetTier(t) {
    const el = elOf(t);
    if (!el || typeof el.getBoundingClientRect !== 'function') return 2;
    const doc = el.ownerDocument;
    if (doc && doc.head && doc.head.contains(el)) return 0;      // head(title/meta):立即翻译
    if (t.hidden) return 3;
    let r;
    try { r = el.getBoundingClientRect(); } catch (e) { return 2; }
    if (!r || (r.width === 0 && r.height === 0)) return 3;
    if (r.bottom > -200 && r.top < innerHeight + 200) return 0;
    if (r.bottom > -innerHeight && r.top < innerHeight * 2) return 1;
    return 2;
  }
  function chunkTier(chunk) {
    let best = 3;
    for (const t of chunk) { const v = targetTier(t); if (v < best) best = v; }
    return best;
  }

  function ensureIO(s) {
    if (io) return io;
    io = new IntersectionObserver((entries) => {
      const hits = [];
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const c = ioMap.get(e.target);
        if (c) { ioMap.delete(e.target); hits.push(c); }
        try { io.unobserve(e.target); } catch (err) {}
      }
      const cur = st || s;                                // 用最新设置,避免捕获首次调用的旧设置
      if (hits.length) hits.forEach((c) => submitChunk(c, cur));
    }, { rootMargin: IO_MARGIN });
    return io;
  }

  function observeChunk(chunk, s) {
    const rep = chunk.map(elOf).find((el) => el && el.nodeType === 1);
    if (!rep) { submitChunk(chunk, s); return; }
    try { ensureIO(s).observe(rep); ioMap.set(rep, chunk); } catch (e) { submitChunk(chunk, s); }
  }

  function submitChunk(chunk, s) {
    if (!chunk || !chunk.length || submitted.has(chunk)) return;
    if (!current || current.aborted) return;             // 无会话 / 已停止 / 已恢复 → 不再提交
    submitted.add(chunk);
    if (!pool) ensurePool(s);
    pool.run(() => translateChunkSmart(chunk, s))
      .then(() => {
        if (!current) return;
        current.done++;                                    // 只有成功才计完成(失败块计完成会让进度/translated 虚高)
        report(current.stage || 'translate', Math.round((current.done / Math.max(1, current.total)) * 100), current.done, current.total);
      }, () => {
        if (current && current.aborted) return;            // 用户主动停止 → 不算失败段
        for (const t of chunk) if (!done(t) && failedTargets.indexOf(t) < 0) failedTargets.push(t);
      });
  }

  /** 滚动预翻:把视口上下各一屏内的延迟块提前提交(沉浸式 scrollLimitScreens=1) */
  function promoteScrollNear(s) {
    if (!ioMap.size) return;
    const top = -innerHeight * 1.5, bottom = innerHeight * 2.5;
    for (const [el, chunk] of [...ioMap.entries()]) {
      let r;
      try { r = el.getBoundingClientRect(); } catch (e) { continue; }
      if (r.bottom > top && r.top < bottom) { ioMap.delete(el); try { io.unobserve(el); } catch (e) {} submitChunk(chunk, s); }
    }
  }

  let scrollTimer = null;
  function onScroll() {
    if (!st || !st.viewportFirst || scrollTimer) return;
    scrollTimer = setTimeout(() => { scrollTimer = null; promoteScrollNear(st); }, 200);
  }

  /** 模型返回文本的清洗与质检:
   *  - 去掉回显的哨兵 / 行首 code fence
   *  - 原样回显(没翻)直接判失败
   *  - 明显的提示词回声/垃圾串判失败(否则会被当成译文写进页面)
   *  - 单段降级路径额外做"目标语言"哨兵检查:目标是中日韩却一个 CJK 字符都没有 → 多半是没翻/垃圾 */
  const JUNK_RE = /translate the text segments|output only the translation|keep every separator|no explanations|code fences/i;
  function cleanSegText(raw, src, opt) {
    let t = String(raw == null ? '' : raw).replace(/\u27e6\d*\u27e7/g, '').trim();
    t = t.replace(/^```[a-zA-Z]*\s*/, '').replace(/```$/, '').trim();
    if (!t) return '';
    const o = String(src == null ? '' : src).trim();
    if (o && t === o) return '';                                  // 原样回显 = 没翻
    if (JUNK_RE.test(t)) return '';                               // 提示词回声
    if (opt && opt.cjk && !/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(t)
        && /[A-Za-z]{3,}/.test(t) && t.length > 8) return '';      // 目标语言不是拉丁语系却全英文 → 判失败
    return t;
  }

  /* ============ 翻译核心 ============ */

  async function translateChunkSmart(chunk, s) {
    if (!chunk || !chunk.length) return;
    if (!current || current.aborted) return;

    // 1) 缓存命中即时回填(0 请求)
    const work = [];
    for (const t of chunk) {
      const src = Chunker.getText(t);
      if (!src.trim() || done(t)) continue;
      if (s.useCache && tc) {
        const hit = tc.get(transKey(src));
        if (hit !== undefined && typeof hit === 'string') {
          if (applyOne(t, hit)) { stats.cacheHits++; bumpRev(t); notifyTranslated(t); }
          continue;
        }
      }
      work.push(t);
    }
    if (!work.length) return;

    const expect = work.length;
    const myGen = gen;
    const applied = new Set();
    const cjkTarget = /^zh|^ja|^ko/i.test(s.targetLang || '');
    const onSeg = (idx, text) => {
      if (gen !== myGen) return;                          // 已被 restore/stop 取代 → 丢弃回写
      if (!(idx >= 0) || idx >= expect || applied.has(idx)) return;
      if (!text || !text.trim()) return;
      const t = work[idx];
      // 质检:丢哨兵「行数吻合」的启发式结果不可全信(可能是垃圾/回声),目标语言不符时更要拦
      const clean = cleanSegText(text, Chunker.getText(t), { cjk: !!fixedParse && cjkTarget });
      if (!clean) return;
      text = clean;
      if (applyOne(t, text)) {
        applied.add(idx);
        if (s.useCache && tc) tc.put(transKey(originals.get(t) || ''), text);
        bumpRev(t); notifyTranslated(t); stats.segments++;
      }
    };

    let fixedParse = false;                                 // 本次结果是否来自"行序修复"启发式
    let full = '';
    try {
      stats.req++;
      full = await Lib.chatStream(s.baseUrl, s.apiKey, s.model,
        [sysMsg, { role: 'user', content: segPrompt(Chunker.makeChunkText(work), s) }],
        (partial) => { for (const seg of Chunker.extractCompleteSegs(partial)) onSeg(seg.idx, seg.text); });
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (/429|5\d\d|连接中断/.test(msg)) {
        const err = new Error(msg);
        err.status = /429/.test(msg) ? 429 : 500;
        if (pool) pool.throttle(err.status);
        throw err;                                   // 交给池做退避重试
      }
      full = '';
    }

    if (full) {
      const seg = Chunker.parseSegments(full, expect);
      fixedParse = !!seg.fixed;
      for (const [idx, text] of seg.map) onSeg(idx, text);
      if (!seg.complete) stats.retries++;
    }

    let missing = work.filter((t, i) => !applied.has(i) && !done(t) && Chunker.getText(t).trim());
    if (!missing.length) return;

    // 2) 整块重试一次(模型偶发丢格式/丢段)
    if (missing.length > 3 && s.retryWholeChunk !== false) {
      const list = missing;
      try {
        stats.req++;
        const r2 = await Lib.sendMsg({
          type: 'chat', baseUrl: s.baseUrl, apiKey: s.apiKey, model: s.model,
          messages: [{ role: 'user', content: segPrompt(Chunker.makeChunkText(list), s) }],
        });
        if (r2 && r2.ok && r2.text) {
          const seg2 = Chunker.parseSegments(r2.text, list.length);
          for (const [idx, text] of seg2.map) if (idx < list.length) onSegIn(list, idx, text, s, myGen);
        }
      } catch (e) { /* 继续降级 */ }
      missing = list.filter((t) => !done(t) && Chunker.getText(t).trim());
    }

    // 3) 降级:单段并发 —— 用独立池(复用主池会因"主池任务等主池任务"死锁),仍共享令牌桶限速
    if (missing.length) {
      const fb = ensureFallbackPool(s);
      await Promise.all(missing.map((t) => fb.run(async () => {
        if (gen !== myGen) return;
        if (!current || current.aborted) return;          // 已停止/已恢复 → 不必再请求
        stats.req++;
        const rr = await Lib.sendMsg({
          type: 'chat', baseUrl: s.baseUrl, apiKey: s.apiKey, model: s.model,
          messages: [{ role: 'user', content: singlePrompt(s, Chunker.getText(t)) }],
        });
        if (gen !== myGen || !current || current.aborted) return;   // 响应回来时再判一次:别把译文写回已恢复的页面
        if (!rr || !rr.ok) {
          const err = new Error((rr && rr.error) || 'chat failed');
          if (/429|5\d\d|限流|频繁/.test(String(err.message))) err.status = 429;
          throw err;
        }
        const src = Chunker.getText(t);
        const cjk = /^zh|^ja|^ko/i.test(s.targetLang || '');
        const text = cleanSegText(rr.text, src, { cjk });
        if (text) {
          if (applyOne(t, text)) {
            if (s.useCache && tc) tc.put(transKey(originals.get(t) || ''), text);
            bumpRev(t); notifyTranslated(t); stats.segments++;
          }
        }
      }).catch(() => { if (!done(t) && failedTargets.indexOf(t) < 0) failedTargets.push(t); })));
    }

    // 4) 收尾不变量:走完全部降级仍有段落没翻(含"模型返回不可用内容被质检拦下")→
    //    必须计入未翻译段,否则会静默假装翻译完成,用户看不到也重试不了。
    if (!current || !current.aborted) {
      for (const t of work) {
        if (!done(t) && Chunker.getText(t).trim() && failedTargets.indexOf(t) < 0) failedTargets.push(t);
      }
    }
  }

  function onSegIn(list, idx, text, s, myGen) {
    if (myGen !== undefined && gen !== myGen) return;
    const t = list[idx];
    if (!t || done(t)) return;
    const clean = cleanSegText(text, Chunker.getText(t));
    if (!clean) return;
    if (applyOne(t, clean)) {
      if (s.useCache && tc) tc.put(transKey(originals.get(t) || ''), clean);
      bumpRev(t); notifyTranslated(t); stats.segments++;
    }
  }

  /* ============ 流水线润色(保留全页统一润色,但不再串行等它) ============ */

  let scheduler = null;

  function notifyTranslated(t) { if (scheduler) scheduler.onTranslated(t); }

  function polishBatch(batch, s) {
    const pairs = batch.map((p) => (Array.isArray(p) ? p : [p, revs.get(p)]));
    const seen = new Set();
    const targets = [];
    for (const t of liveTargets(pairs.map((p) => p[0]))) {
      if (seen.has(t)) continue;                       // 同批内同一目标只润一次
      seen.add(t); targets.push(t);
    }
    if (!targets.length) return Promise.resolve();
    const revAt = new Map(pairs);
    const subs = Chunker.buildChunks([{ targets }], s.polishChunkSize || 3000);
    const myGen = gen;
    return Promise.all(subs.map((sub) => pool.run(async () => {
      if (gen !== myGen) return;
      stats.req++; stats.polishBatches++;
      const applied = new Set();
      const put = (idx, text) => {
        if (!(idx >= 0) || idx >= sub.length || applied.has(idx)) return;
        if (!text || !text.trim()) return;
        applied.add(idx);
        applyPolish(sub[idx], text, revAt, s, false, myGen);
      };
      let full = '';
      try {
        full = await Lib.chatStream(s.baseUrl, s.apiKey, s.model,
          [{ role: 'user', content: polishPrompt(Chunker.makeChunkText(sub), s) }],
          (partial) => { for (const seg of Chunker.extractCompleteSegs(partial)) put(seg.idx, seg.text); });
      } catch (e) { return; }
      if (full) {
        const parsed = Chunker.parseSegments(full, sub.length);
        for (const [idx, text] of parsed.map) put(idx, text);
      }
    })));
  }

  function applyPolish(t, text, revAt, s, force, myGen) {
    if (myGen !== undefined && gen !== myGen) { stats.polishSkips++; return; }   // 已被 restore/stop 取代
    const expected = revAt ? revAt.get(t) : revs.get(t);
    if (expected !== undefined && revs.get(t) !== expected) { stats.polishSkips++; return; }
    if (!inDocument(elOf(t))) return;
    if (!force && s.polishAvoidReading && isReading(t)) { deferPolish(t, text, expected, s, myGen); return; }
    writeTarget(t, text);
    polishedOk.add(t);
    stats.polished++; stats.polishApps++;
    if (s.useCache && tc) tc.put(transKey(originals.get(t) || ''), text);
  }

  function isReading(t) {
    const el = elOf(t);
    if (!el || typeof el.getBoundingClientRect !== 'function') return false;
    let r;
    try { r = el.getBoundingClientRect(); } catch (e) { return false; }
    return r.bottom > 0 && r.top < innerHeight;
  }

  function deferPolish(t, text, expected, s, myGen) {
    let done = false, timer = null;
    const later = () => apply();
    function apply() {
      if (done) return;                                    // 滚动与定时器只允许生效一次(否则同段写两次、指标双计)
      done = true;
      try { removeEventListener('scroll', later, true); } catch (e) {}
      if (timer) { clearTimeout(timer); timer = null; }
      applyPolish(t, text, new Map([[t, expected]]), s, true, myGen);
    }
    try { addEventListener('scroll', later, { passive: true, capture: true, once: true }); } catch (e) {}
    timer = setTimeout(apply, 2000);
    void s;
  }

  function createPolishScheduler(s) {
    let buf = [], timer = null, inflight = 0, stopped = false;
    const flush = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (!buf.length) return Promise.resolve();
      const batch = buf; buf = [];
      inflight++;
      return polishBatch(batch, s)
        .catch(() => {})
        .then(() => { inflight--; });
    };
    return {
      onTranslated(t) {
        if (stopped || !t) return;
        buf.push([t, revs.get(t) || 1]);
        if (buf.length >= (s.polishBatchBlocks || 8)) { flush(); return; }
        if (!timer) timer = setTimeout(() => { flush(); }, (s.polishWindow || 6) * 1000);
      },
      finish: () => flush(),
      pending: () => buf.length + inflight,
      stop: () => { stopped = true; if (timer) clearTimeout(timer); },
    };
  }

  /** 收尾:把「已快翻但未润色」的段补润一次(保证全页统一) */
  async function polishLeftovers(s) {
    const left = [];
    for (const t of originals.keys()) {
      if (polishedOk.has(t)) continue;
      const cur = Chunker.getText(t);
      if (cur && cur.trim() && cur !== originals.get(t) && inDocument(elOf(t))) left.push([t, revs.get(t) || 1]);
    }
    if (!left.length) return;
    for (let i = 0; i < left.length; i += (s.polishBatchBlocks || 8)) {
      if (current && current.aborted) return;
      await polishBatch(left.slice(i, i + (s.polishBatchBlocks || 8)), s).catch(() => {});
    }
  }

  /** 兼容旧行为:关闭流水线润色时,翻译完成后统一润色一遍 */
  async function polishAll(s) {
    const all = [];
    for (const t of originals.keys()) {
      const cur = Chunker.getText(t);
      if (cur && cur.trim() && cur !== originals.get(t) && inDocument(elOf(t))) all.push([t, revs.get(t) || 1]);
    }
    if (!all.length) return;
    if (!current) return;                                 // 可能已被"恢复原文"置空
    current.stage = 'polish';
    for (let i = 0; i < all.length; i += (s.polishBatchBlocks || 8)) {
      if (!current || current.aborted) return;
      await polishBatch(all.slice(i, i + (s.polishBatchBlocks || 8)), s).catch(() => {});
    }
  }

  /* ============ 动态内容:批聚合 ============ */

  let batcherSt = null;
  function dynamicBatcher(s) {
    if (batcher && batcherSt === s) return batcher;
    batcherSt = s;                                        // 设置对象变了 → 用新参数重建批处理器
    batcher = PoolLib.createBatcher({
      batchInterval: s.batchInterval || 400,
      batchSize: s.batchSize || 20,
      batchLength: s.batchLength || 8000,
      flush: async (items) => {
        const targets = items.map((i) => i.target);
        const chunks = Chunker.buildChunks([{ targets }], s.chunkSize);
        await Promise.all(chunks.map((c) => translateChunkSmart(c, s).catch(() => {
          for (const t of c) if (!done(t) && failedTargets.indexOf(t) < 0) failedTargets.push(t);
        })));
        return items.map(() => true);
      },
    });
    return batcher;
  }

  async function translateNodes(targets, s) {
    const fresh = liveTargets(targets).filter((t) => !done(t) && Chunker.getText(t).trim());
    if (!fresh.length) return;
    for (const b of fresh) {
      if (b.hidden) {
        const el = elOf(b);
        let vis = true;
        try { const r = el.getBoundingClientRect(); vis = r.width > 0 || r.height > 0; } catch (e) { vis = true; }
        b.hidden = !vis;
      }
    }
    const ordered = fresh.filter((t) => !t.hidden).concat(fresh.filter((t) => t.hidden));
    await Promise.all(ordered.map((t) => dynamicBatcher(s).add({ text: Chunker.getText(t), target: t }).catch(() => {})));
  }

  async function flushDynamic() {
    if (current && current.running) return;
    if (!dynPending.length) return;
    const s = st || await Lib.loadSettings();
    const todo = dynPending.filter((t) => !done(t));
    dynPending = [];
    if (todo.length) await translateNodes(todo, s).catch(() => {});
  }

  /* ============ 图片文字翻译(T3) ============ */

  const Panel = (typeof LFPanel !== 'undefined') ? LFPanel : null;
  const Reader = (typeof LFReader !== 'undefined') ? LFReader : null;
  const ImgEngine = (typeof LFImgEngine !== 'undefined') ? LFImgEngine : null;
  const ImgRender = (typeof LFImgRender !== 'undefined') ? LFImgRender : null;
  const ImgCollect = (typeof LFImgCollect !== 'undefined') ? LFImgCollect : null;
  let imgRunning = false;
  const imgDigests = new Map();         // src → 图片摘要:重复图命中缓存时省掉一次取图(每轮重算)

  // 视觉能力结论只记在"本次页面会话":瞬时 429/5xx 误判不会永久关掉该模型的图片翻译
  const visionMemo = new Map();
  const visionKey = (s, model) => 'vision:' + model + '|' + (s.visionBaseUrl || s.baseUrl || '');

  /** 三层视觉能力探测:名称特征 → 缓存的结论 → (首次请求失败会在调用处学习并缓存) */
  async function visionUsable(s, model) {
    if (!ImgEngine) return { ok: false, reason: 'engine-missing' };
    if (!model) return { ok: false, reason: 'no-model' };
    const memo = visionMemo.get(visionKey(s, model));
    if (memo === false) return { ok: false, reason: 'vision-unsupported' };
    if (memo === true) return { ok: true };
    // 不用"已知模型名单"去否决:模型迭代很快,名单必然过时(new 一版可能就是多模态)。
    // 策略:能力未知也**先试一次**,只有接口真的以"不支持图片"报错才降级并记住(见 isUnsupportedError)。
    return { ok: true, untested: !ImgEngine.looksVisionCapable(model) };
  }

  /**
   * 图片翻译。⚠️ **每个帧翻自己那份**:顶层读不到跨域框的 DOM,同源框里元素的坐标也不在顶层坐标系里,
   * 所以让各帧用自己的内容脚本翻自己的图最稳(与翻译/阅读助手同一套覆盖范围)。
   * 本帧结果会报给后台,顶层再汇总 → 面板/弹窗就能说清"本页 0 张 · 内嵌框 3 张"。
   */
  async function translateImages(s) {
    const r = await translateImagesInner(s);
    try {
      Lib.sendMsg({
        type: 'frameImgResult',
        // "翻了几张"= 新视觉请求 + 缓存命中(命中同样渲染了覆盖层,别漏算)
        rendered: ((r && r.images) || 0) + ((r && r.cached) || 0),
        images: (r && r.images) || 0, cached: (r && r.cached) || 0,
        items: (r && r.items) || 0, skipped: !!(r && r.skipped), url: location.href,
      }, 3000);
    } catch (e) { /* 忽略 */ }
    return r;
  }

  async function translateImagesInner(s) {
    if (imgRunning) return { ok: false, error: '图片翻译进行中' };
    if (!ImgEngine || !ImgRender || !ImgCollect) return { ok: false, error: '图片模块未加载' };
    if (s.imageTranslateEnabled === false) return { ok: false, error: '图片翻译已关闭' };

    imgRunning = true;
    const t0 = Date.now();
    const model = s.visionModel || s.chatModel || s.model;
    const stats2 = { images: 0, cached: 0, vision: 0, items: 0 };
    try {
      await cacheReady(s);
      ensurePool(s);

      const cap = await visionUsable(s, model);
      if (!cap.ok) {
        return { ok: false, skipped: true, reason: cap.reason, error: ImgEngine.NO_VISION_HINT };
      }

      const maxPer = Math.max(1, s.imageMaxPerPage || 8);
      const cands = ImgCollect.collect({
        minW: s.imageMinSize || 100, minH: s.imageMinSize || 100,
        max: maxPer, viewportOnly: s.imageAllViewportOnly !== false,
        scanMax: s.bgScanMax || 5000,                        // 背景图扫描元素上限(可配)
        dedupeSameSrc: s.imageDedupeSameSrc === true,         // 默认 false:同图多处都翻,靠 OCR 缓存不额外花钱
      }).slice(0, maxPer);

      if (!cands.length) return { ok: true, images: 0, skipped: true, ms: Date.now() - t0 };

      let unsupported = false;
      imgDigests.clear();                                 // 每轮重算(页面可能换了图),体积受 maxPer 限制
      const myGen = gen;                                   // 代际:restore/停止 之后不许再把覆盖层画回去
      const stale = () => gen !== myGen;
      await Promise.all(cands.map((c) => pool.run(async () => {
        if (unsupported || stale()) return;
        // 同一张图出现多次:已知摘要 + 缓存命中 → 连取图都省掉(零网络、零模型成本)
        const knownDigest = imgDigests.get(c.src);
        if (knownDigest && s.useCache && tc) {
          const hitKnown = tc.get('img:' + knownDigest + '|' + s.targetLang + '|' + model);
          if (hitKnown && hitKnown.items) {
            stats2.cached++;
            ImgRender.render(c, hitKnown, { paintMode: s.imagePaintMode || 'auto', fills: hitKnown.fills });
            return;
          }
        }
        const fr = await Lib.sendMsg({ type: 'fetchImage', url: c.src });
        if (!fr || !fr.ok || stale()) return;
        imgDigests.set(c.src, fr.digest);
        const key = 'img:' + fr.digest + '|' + s.targetLang + '|' + model;
        const hit = s.useCache && tc ? tc.get(key) : undefined;
        if (hit && hit.items) {
          if (stale()) return;
          stats2.cached++;
          ImgRender.render(c, hit, { paintMode: s.imagePaintMode || 'auto', fills: hit.fills });
          return;
        }
        const small = await ImgEngine.downscale(fr.dataUrl, s.imageMaxDimOcr || 1568);
        if (stale()) return;
        stats2.vision++;
        let out;
        try {
          out = await ImgEngine.ocrTranslate({
            dataUrl: small, targetLang: s.targetLang,
            baseUrl: s.visionBaseUrl || s.baseUrl, apiKey: s.apiKey, model,
            stream: Lib.chatStream,
            // 原始像素尺寸(降采样前的):模型若直接回像素坐标,归一化才有正确基准
            logicalW: c.nw || c.w || 0, logicalH: c.nh || c.h || 0,
          });
        } catch (e) {
          if (ImgEngine.isUnsupportedError(e)) {
            unsupported = true;
            visionMemo.set(visionKey(s, model), false);                 // 只记本次会话:瞬时误判不会被持久化后永久关掉
            return;                                                     // 不 rethrow:池不应把"不支持"当可重试错误反复打
          }
          throw e;                                                      // 其他错误(限流/5xx)交给池退避重试
        }
        if (!out.items.length || stale()) return;
        const fills = await ImgRender.ringColors(small, out.items);
        if (stale()) return;                               // 取色期间可能已被 restore
        ImgRender.render(c, out, { paintMode: s.imagePaintMode || 'auto', fills });
        if (s.useCache && tc) tc.put(key, { items: out.items, lang: out.lang, fills });
        stats2.images++; stats2.items += out.items.length;
      }).catch(() => {})));

      if (s.useCache && tc) tc.flush();
      if (unsupported) {
        return { ok: false, skipped: true, reason: 'vision-unsupported', error: ImgEngine.NO_VISION_HINT, ...stats2, ms: Date.now() - t0 };
      }
      return { ok: true, ...stats2, ms: Date.now() - t0 };
    } finally {
      imgRunning = false;
    }
  }

  /** 顶层汇总:内嵌框里的图是各帧自己翻的,把它们的战绩并进来(否则会误报"本页没有图片") */
  /** 等各帧把战绩报上来再汇总:各帧是并行跑视觉 OCR 的,顶层若立刻汇总会误报"本页没有图片"。
   *  收敛条件:① 已登记的帧都报了;或 ② 上报数量稳定 1.2s。上限 12s。 */
  async function frameImgSummarySettled(maxMs, since) {
    const cap = maxMs || 12000;
    const t0 = Date.now();
    let last = null, prevKey = '', lastGrow = Date.now();
    while (Date.now() - t0 < cap) {
      const sum = await frameImgSummary(since);
      if (sum) {
        const reported = (sum.frames || []).filter((f) => f.frameId !== 0 && !f.stale).length;
        const known = (sum.knownFrames || []).length;
        const key = String(reported);
        if (key !== prevKey) { prevKey = key; lastGrow = Date.now(); }
        last = sum;
        if (known && reported >= known) break;                        // 所有登记帧都报了
        if (reported && Date.now() - lastGrow > 1200) break;          // 数量不再涨
        if (!known && !reported && Date.now() - t0 > 4000) break;     // 没有任何帧:别干等
      }
      await new Promise((res) => setTimeout(res, 350));
    }
    return last;
  }

  async function frameImgSummary(since) {
    try {
      const sum = await Lib.sendMsg({ type: 'frameImgSummary', since: since || 0 }, 4000);
      if (sum && sum.ok) return sum;
    } catch (e) { /* 忽略 */ }
    return null;
  }

  /* ============ 主流程 ============ */

  async function translatePage(s) {
    if (current && current.running) return { ok: false, error: '正在翻译中' };
    st = s;
    failedTargets = [];
    const t0 = Date.now();
    for (const k of Object.keys(stats)) stats[k] = 0;      // 就地重置,保持引用不变
    // 会话对象:整个流程只用它,不再直接解引用可被 restore 置空的 current
    const session = { running: true, stage: 'translate', done: 0, total: 0, aborted: false };
    current = session;               // 翻译完成后保留(动态内容翻译依赖它),仅在「恢复原文/停止」时失效

    try {
      await cacheReady(s).catch(() => {});
      ensurePool(s);

      // 术语先行(1 次小请求,强缓存;失败不阻断)
      try {
        const term = await preAnalyze(s);
        s.termDigest = term.digest || '';
        s.termBlock = termBlockOf(term);
      } catch (e) { s.termBlock = ''; }
      if (session.aborted) return { ok: false, aborted: true, ms: Date.now() - t0, req: stats.req };

      const blocks = freshBlocks(collectAll(s));
      if (!blocks.length) {
        return { ok: true, translated: 0, skipped: true, ms: Date.now() - t0, req: stats.req };
      }

      // 先给 block 排序(视口优先 → 重复块相邻),再切 chunk:
      // 这样「同一次请求」只包含同一可见性层级的文本,避免视口内容与页脚被合并成一块
      const ranks = s.repeatPattern === false ? new Map() : Chunker.repeatGroupRank(blocks, 3);
      const blockTier = new Map();
      for (const b of blocks) {
        let best = 3;
        for (const x of b.targets) { const v = targetTier(x); if (v < best) best = v; }
        blockTier.set(b, best);
      }
      const order0 = new Map(blocks.map((b, i) => [b, i]));
      const orderedBlocks = (s.viewportFirst === false && !ranks.size) ? blocks : blocks.slice().sort((a, b) => {
        if (s.viewportFirst !== false) {
          const ta = blockTier.get(a), tb = blockTier.get(b);
          if (ta !== tb) return ta - tb;
        }
        const ra = ranks.get(a) || 1e9, rb = ranks.get(b) || 1e9;
        if (ra !== rb) return ra - rb;
        return order0.get(a) - order0.get(b);
      });
      // 切 chunk 时按可见性层级分组(同一请求内不混装视口内容与页脚内容)
      const tierGroups = [[], [], [], []];
      for (const b of orderedBlocks) (tierGroups[blockTier.get(b)] || tierGroups[2]).push(b);
      const ordered = [].concat(...tierGroups.filter((g) => g.length).map((g) => Chunker.buildChunks(g, s.chunkSize)));
      session.total = ordered.length;
      report('translate', 0, 0, ordered.length);

      scheduler = (s.polishEnabled && s.polishPipelined !== false) ? createPolishScheduler(s) : null;

      // 立即队列 vs 延迟队列(视口/滚动驱动)
      const immediate = [], deferred = [];
      for (const c of ordered) {
        if (s.viewportFirst !== false && chunkTier(c) > 1) deferred.push(c);
        else immediate.push(c);
      }
      immediate.forEach((c) => submitChunk(c, s));
      deferred.forEach((c) => observeChunk(c, s));

      // 等立即队列完成
      await pool.idle();
      // 延迟队列:用户不滚动时也要把整页翻完(默认 3.5s 后兜底)
      if (deferred.length && !session.aborted) {
        await sleep(s.deferIdle || 3500);
        if (!session.aborted) deferred.forEach((c) => submitChunk(c, s));   // 等待期间可能已被停止/恢复
        await pool.idle();
      }
      if (!session.aborted && scheduler) await scheduler.finish();
      if (!session.aborted && s.polishEnabled && s.polishPipelined === false) await polishAll(s);
      if (!session.aborted && s.polishEnabled && scheduler) await polishLeftovers(s);
      if (tc && s.useCache) tc.flush();
      pruneStale();
      if (!session.aborted && s.imageAutoTranslate && s.imageTranslateEnabled !== false) {
        translateImages(s).catch(() => {});          // 可选:页面翻译完顺手翻视口内图片(默认关)
      }
      return {
        ok: true,
        aborted: session.aborted || undefined,
        translated: session.done,
        polished: !!s.polishEnabled,
        failed: failedTargets.length,
        ms: Date.now() - t0,
        req: stats.req,
        cacheHits: stats.cacheHits,
        segments: stats.segments,
        polishApps: stats.polishApps,
        polishSkips: stats.polishSkips,
        throttled: stats.throttled,
        chunks: session.total,
      };
    } finally {
      // 无论中途抛错/被恢复,都必须释放「运行中」标记,否则页面会永久卡在"正在翻译中"
      session.running = false;
      if (current === session) {
        report(session.stage || 'translate', session.aborted ? 0 : 100, session.done, session.total);
        if (!session.aborted && dynPending.length) flushDynamic().catch(() => {});
      }
    }
  }

  /* ============ observer ============ */

  function pendingAttrs(el) {
    if (!el || !el.getAttribute) return;
    for (const t of Chunker.makeTargetsForAttrEl(el)) {
      const changed = invalidateIfPageChanged(t);
      if (changed || !done(t)) dynPending.push(t);
    }
  }

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver((muts) => {
      let dirty = false;
      for (const m of muts) {
        if (m.type === 'characterData') {
          const n = m.target;
          if (n && n.nodeType === Node.TEXT_NODE && (n.nodeValue || '').trim()) {
            const t = Chunker.textTargetOf(n);
            const changed = invalidateIfPageChanged(t);
            if (changed || !done(t)) { dynPending.push(t); dirty = true; }
          }
          continue;
        }
        if (m.type === 'attributes') {
          if (m.target && m.target.nodeType === 1) { pendingAttrs(m.target); dirty = true; }
          continue;
        }
        for (const n of m.addedNodes) {
          if (n.nodeType === Node.TEXT_NODE) {
            if ((n.nodeValue || '').trim()) { dynPending.push(Chunker.textTargetOf(n)); dirty = true; }
          } else if (n.nodeType === Node.ELEMENT_NODE && n.tagName !== 'SCRIPT' && n.tagName !== 'STYLE') {
            if (n.id === PANEL_HOST_ID) continue;
            for (const b of Chunker.collectBlocks(n, {})) for (const t of (b.targets || [])) { dynPending.push(t); dirty = true; }
          }
        }
      }
      if (!dirty) return;
      if (dynTimer) clearTimeout(dynTimer);
      dynTimer = setTimeout(() => { dynTimer = null; flushDynamic().catch(() => {}); }, 600);
    });
    observer.observe(document.body, {
      childList: true, subtree: true, characterData: true,
      attributes: true,
      attributeFilter: ['placeholder', 'title', 'alt', 'aria-label', 'value', 'style', 'class', 'hidden'],
    });
  }

  function restorePage() {
    if (current) current.aborted = true;                  // 中止在途翻译,避免恢复后被回填译文
    gen++;                                               // 使在途请求的回写失效
    const keep = new Map();                               // 暂时不在文档里的:保留原文,等它回来还能恢复
    for (const [t, orig] of originals) {
      const el = elOf(t);
      if (!inDocument(el)) { keep.set(t, orig); continue; }
      if (Chunker.getText(t) !== orig) writeTarget(t, orig); else wrote.set(t, orig);
    }
    originals = keep;
    failedTargets = [];
    polishedOk = new WeakSet();                           // 重翻时要能重新润色
    dynPending = [];
    if (dynTimer) { clearTimeout(dynTimer); dynTimer = null; }
    if (io) { try { io.disconnect(); } catch (e) {} io = null; ioMap.clear(); }
    current = null;
    try { if (ImgRender) ImgRender.resetAll(); } catch (e) {}
    if (scheduler) { scheduler.stop(); scheduler = null; }
    report('translate', 0, 0, 0);
    return { ok: true };
  }

  /* ============ 消息路由 ============ */

  /** Reader.build() 会全页扫一遍:侧栏/引用 chip 短时间连问时没必要重复扫 → 3 秒 TTL 缓存 */
  let readerCache = { at: 0, val: null };
  function readerCached() {
    if (readerCache.val && Date.now() - readerCache.at < 3000) return readerCache.val;
    readerCache = { at: Date.now(), val: Reader.build() };
    return readerCache.val;
  }

  /** 带内嵌框的完整读取(跨域框要经后台逐帧收集 → 异步)。面板/侧栏取资料用它。 */
  let readerCacheFull = { at: 0, val: null };
  async function readerCachedFull(maxAgeMs) {
    const age = maxAgeMs == null ? 3000 : maxAgeMs;
    if (readerCacheFull.val && Date.now() - readerCacheFull.at < age) return readerCacheFull.val;
    const v = (Reader && Reader.buildWithFrames) ? await Reader.buildWithFrames() : Reader.build();
    readerCacheFull = { at: Date.now(), val: v };
    readerCache = { at: Date.now(), val: v };              // 同步路径也顺带更新(锚点仍只对顶层有效)
    return v;
  }

  const isTopFrame = window.top === window;
  /** UI/面板类消息只由顶层 frame 处理:子 frame 若也应答,tabs.sendMessage 会「先到先得」拿到错的数据 */
  // 注意:translateImages/resetImages 不在 UI_MSGS 里 —— 图片属于各帧自己的文档,每个 frame 翻自己那份
  const UI_MSGS = new Set(['panelStatus', 'readerDump', 'getSelection', 'scrollToChunk', 'askPage',
    'openChatPanel', 'askSelection', 'askWithShot', 'toggleChat']);

  /** 消息处理主体(抽出成函数,便于统一兜底:同步异常必须回一个响应,否则发送方只会看到「端口已关闭」) */
  function handleMsg(msg, sender, sendResponse) {
    if (!msg) return;
    if (UI_MSGS.has(msg.type) && !isTopFrame) return false;
    if (msg.type === 'translate') {
      if (window.top === window) {
        Lib.loadSettings().then((s) => translatePage(s).then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e) })));
        return true;
      }
      Lib.loadSettings().then((s) => translatePage(s).catch(() => {})).catch(() => {});
      return false;
    }
    if (msg.type === 'restore') {
      const r = restorePage();
      if (window.top === window) sendResponse(r);
      return false;
    }
    if (msg.type === 'stop') {
      if (Panel && Panel.stop) { try { Panel.stop(); } catch (e) {} }     // 面板侧也标记"用户主动停止"
      if (current) current.aborted = true;
      gen++;
      if (scheduler) scheduler.stop();
      dynPending = [];
      if (dynTimer) { clearTimeout(dynTimer); dynTimer = null; }
      if (io) { try { io.disconnect(); } catch (e) {} io = null; ioMap.clear(); }   // 停止后滚动不应再触发翻译
      if (window.top === window) sendResponse({ ok: true });
      return false;
    }
    /* ---- AI 阅读助手(面板) ---- */
    if (msg.type === 'toggleChat') {
      const want = msg.mode || (st && st.panelMode) || 'auto';   // iframe 由上面的 UI_MSGS 早退拦掉
      if (!Panel) { sendResponse({ ok: false, error: '面板未加载' }); return false; }
      if (want === 'inpage') {
        Panel.togglePanel();
        sendResponse({ ok: true, mode: 'inpage' });
        return false;
      }
      // auto / sidepanel:先问后台能不能开原生侧栏,开不了再退回页内面板
      Lib.sendMsg({ type: 'openChat' }).then((r) => {
        if (r && r.mode === 'sidepanel') { sendResponse({ ok: true, mode: 'sidepanel' }); return; }
        Panel.openPanel();
        sendResponse({ ok: true, mode: 'inpage' });
      }).catch(() => { Panel.openPanel(); sendResponse({ ok: true, mode: 'inpage' }); });
      return true;
    }
    if (msg.type === 'openChatPanel') {                       // 强制页内面板(popup/右键带 mode)
      if (Panel) Panel.openPanel();
      if (window.top === window) sendResponse({ ok: true });
      return false;
    }
    if (msg.type === 'askPage') {                             // 预设任务:总结/笔记/…
      if (!Panel) { sendResponse({ ok: false, error: '面板未加载' }); return false; }
      Panel.openPanel().then(() => {
        if (msg.attachText) Panel.addTextAttachment(msg.attachText, '选中文本');
        return Panel.send(msg.question || '请总结这个页面。');
      }).then((r) => sendResponse(r || { ok: true })).catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }
    if (msg.type === 'askSelection') {
      if (!Panel) { sendResponse({ ok: false, error: '面板未加载' }); return false; }
      Panel.openPanel().then(() => {
        Panel.addTextAttachment(msg.text, '选中文本');
        if (msg.question) return Panel.send(msg.question);
        return { ok: true };
      }).then((r) => sendResponse(r || { ok: true })).catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }
    if (msg.type === 'panelStatus') {
      try {
        const c = (typeof LFPanelCore !== 'undefined') ? LFPanelCore.state : null;
        sendResponse({
          ok: true,
          hasPanel: !!Panel,
          open: !!(Panel && Panel.isOpen && Panel.isOpen()),
          ready: !!(c && c.ready),
          busy: !!(c && c.busy),
          turns: c ? c.history.length : 0,
          sentIds: c ? c.sentIds.size : 0,
          chunks: c && c.reader ? (c.reader.chunks || []).length : 0,
          images: c && c.reader ? (c.reader.images || []).length : 0,
          lastError: (c && c.lastError) || '',
          md: !!(Panel && Panel.mdOn && Panel.mdOn()),
          attCount: c && c.attachments ? c.attachments.length : 0,
        });
      } catch (e) { sendResponse({ ok: false, error: String(e) }); }
      return false;
    }
    if (msg.type === 'getSelectionOwn') {                     // 每个帧各自的选择(内嵌框里的选中只有它自己知道)
      try { sendResponse({ ok: true, text: String(window.getSelection ? window.getSelection().toString() : '') }); }
      catch (e) { sendResponse({ ok: false, error: String(e) }); }
      return false;
    }
    if (msg.type === 'getSelection') {
      // 顶层选择为空时要向内嵌框要:用户在框里选字,顶层 window.getSelection() 是空的 ——
      // 选中可能发生在任意内嵌框里:只查顶层的 window.getSelection() 会误报"当前没有选中文本"。
      (async () => {
        try {
          let text = String(window.getSelection ? window.getSelection().toString() : '');
          if (!text.trim()) {
            try {
              const r = await Lib.sendMsg({ type: 'collectFrameSelection' }, 4000);
              if (r && r.ok && r.text) text = String(r.text);
            } catch (e2) { /* 忽略 */ }
          }
          sendResponse({ ok: true, text: text, frameSel: !!(text && !String(window.getSelection ? window.getSelection().toString() : '').trim()) });
        } catch (e) { sendResponse({ ok: false, error: String(e) }); }
      })();
      return true;
    }
    if (msg.type === 'pickRegionShot') {                        // 侧栏/弹窗要框选截图:选框必须画在**网页**上
      (async () => {
        try {
          if (window.top !== window || !Panel || !Panel.pickRegion) { sendResponse({ ok: false, error: 'not-top-or-no-panel' }); return; }
          if (Panel.isOpen()) Panel.closePanel();        // 页内面板别挡着选框
          const region = await Panel.pickRegion();
          if (!region || region.cancelled) { sendResponse({ ok: false, cancelled: true }); return; }
          sendResponse({ ok: true, rect: region.rect, vw: region.vw, dpr: region.dpr, whole: !!region.whole });
        } catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
      })();
      return true;
    }
    if (msg.type === 'askWithShot') {                          // 截图翻译
      if (!Panel) { sendResponse({ ok: false, error: '面板未加载' }); return false; }
      Panel.openPanel()
        .then(() => Panel.attachShot({ question: msg.question, translate: msg.translate }))   // 截图 → 加入面板(translate:true 才自动翻)
        .then((r) => sendResponse(r || { ok: true }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }
    if (msg.type === 'readerDump') {                           // 侧栏/测试:取页面资料摘要(含内嵌框)
      (async () => {
        try {
          const r = msg.force ? await (LFReader.buildWithFrames ? LFReader.buildWithFrames() : LFReader.build()) : await readerCachedFull();
        sendResponse({
          ok: true,
          meta: r.meta,
          stats: r.stats,
          outline: r.outline.slice(0, 20),
          chunks: r.chunks.slice(0, msg.maxChunks || 40),
          images: r.images.slice(0, 10),
          frames: (r.meta && r.meta.frames) || [],
          crossOrigin: (r.meta && r.meta.crossOrigin) || [],
        });
        } catch (e) { sendResponse({ ok: false, error: String(e) }); }
      })();
      return true;
    }
    if (msg.type === 'frameImageList') {                        // 面板「读取页面图片」:各帧自报图片(含内嵌框里的)
      (async () => {
        try {
          if (!ImgCollect) { sendResponse({ ok: false, error: '图片模块未加载' }); return; }
          const st2 = await Lib.loadSettings();
          const list = ImgCollect.collect({
            minW: st2.imageMinSize || 100, minH: st2.imageMinSize || 100,
            max: Math.max(1, msg.max || 6), viewportOnly: false,
          }).slice(0, msg.max || 6);
          const out = [];
          for (const c of list) {
            const fr = await Lib.sendMsg({ type: 'fetchImage', url: c.src }, 8000);
            if (fr && fr.ok && fr.dataUrl) out.push({ url: c.src, dataUrl: fr.dataUrl, w: c.w, h: c.h, frame: location.href });
          }
                    // 没有任何 <img> 但页面上有画布(PDF.js / ebook 阅读器把整页画在 canvas 上):
          // 画布内容不会出现在 DOM 里,存成图才能交给视觉模型 —— 否则用户看到的"能翻到的内容"助手一无所知。
          if (!out.length) {
            try {
              const cvs = [...document.querySelectorAll('canvas')].slice(0, msg.max || 6);
              for (const cv of cvs) {
                const cw = cv.width || 0, chh = cv.height || 0;
                if (cw < 80 || chh < 80) continue;                       // 太小的画布当装饰,跳过
                let durl = '';
                try { durl = cv.toDataURL('image/png'); } catch (e) { durl = ''; }   // 跨域污染的画布会抛
                if (!durl || durl.length < 2000) continue;
                out.push({ url: location.href + '#canvas', dataUrl: durl, w: cw, h: chh, frame: location.href, canvas: true });
                if (out.length >= (msg.max || 6)) break;
              }
            } catch (e) { /* 忽略 */ }
          }
sendResponse({ ok: true, images: out });
        } catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
      })();
      return true;
    }
    if (msg.type === 'readerPiece') {                          // 跨域子帧:把自己的资料交回顶层(所有 frame 都要应答)
      try {
        const r = Reader.build({ maxChunks: 24, minChunkChars: 12 });   // 内嵌文档常见短段落 → 放宽
        let chunks = r.chunks.slice(0, 24).map((c) => ({ text: c.text, heading: c.heading, chars: c.chars }));
        if (!chunks.length) chunks = frameFallbackChunks(40);
        let ch2 = 0;
        for (const c of chunks) ch2 += (c.chars || (c.text || '').length || 0);
        const kd2 = frameKind(ch2, (r.images || []).length);
        sendResponse({
          ok: true, url: location.href, title: document.title,
          chunks: chunks,
          outline: r.outline.slice(0, 8).map((o) => ({ level: o.level, text: o.text })),
          images: (r.images || []).length, chars: ch2,
          carriers: (r.images || []).length + kd2.canvas,
          kind: kd2.kind, canvas: kd2.canvas, pdf: kd2.pdf,
        });
      } catch (e) { sendResponse({ ok: false, error: String(e) }); }
      return false;
    }
    if (msg.type === 'scrollToChunk') {
      const r = readerCached();
      const c = r.chunks.find((x) => x.id === msg.id);
      sendResponse({ ok: !!(c && c.anchor && Reader.scrollTo(c.anchor)) });
      return false;
    }
    if (msg.type === 'translateImages') {
      // 每次都重新读设置:用户改完 options 立刻生效(不要用启动时缓存的 st)
      const runSince = Date.now() - 800;                   // 本轮起点(各帧几乎同时收到广播)
      Lib.loadSettings().then((s2) => { st = s2; return translateImages(s2); })
        .then(async (r) => {
          if (window.top !== window) return;                 // 子帧不抢答;它的战绩已单独报给后台
          const sum = await frameImgSummarySettled(12000, runSince);
          if (sum && r) {
            r.frames = sum.frames || [];
            r.framesImages = sum.rendered || sum.images || 0;      // 内嵌框里实际翻了几张(含缓存命中)
            r.framesWithImages = sum.framesWithImages || 0;
          }
          sendResponse(r);
        })
        .catch((e) => { if (window.top === window) sendResponse({ ok: false, error: String(e && e.message || e) }); });
      return true;
    }
    if (msg.type === 'resetImages') {
      if (ImgRender) ImgRender.resetAll();
      if (window.top === window) sendResponse({ ok: true });
      return false;
    }
    if (msg.type === 'retryFailed') {
      const todo = failedTargets.slice();
      failedTargets = [];
      if (window.top !== window) {
        // 子 frame 自己重试(与 translate 同策略),但立刻关掉自己的通道:
        // 返回 true 却不响应会让多帧页面里的发送方拿不到顶层 frame 的响应
        Lib.loadSettings().then((s2) => translateNodes(todo, s2)).catch(() => {});
        return false;
      }
      if (!todo.length) { sendResponse({ ok: true, retried: 0, failed: 0, note: '没有需要重试的段落' }); return false; }
      // 点过「恢复原文」后 current 已被置空 → 没有会话时提交会被静默丢弃(表现为"点重试没反应"),
      // 所以重试要能自发建一个会话。
      if (!current || current.aborted) current = { running: true, stage: 'translate', done: 0, total: 0, aborted: false, retry: true };
      current.total = Math.max(current.total || 0, (current.done || 0) + todo.length);
      Lib.loadSettings()
        .then((s2) => { st = s2; return translateNodes(todo, s2); })
        .then(() => { try { sendResponse({ ok: true, retried: todo.length, failed: failedTargets.length }); } catch (e) {} })
        .catch((e) => { try { sendResponse({ ok: false, error: String((e && e.message) || e) }); } catch (e2) {} });
      return true;
    }
    return false;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    try {
      return handleMsg(msg, sender, sendResponse);
    } catch (e) {
      try { sendResponse({ ok: false, error: '内部错误: ' + String((e && e.message) || e) }); } catch (e2) {}
      return false;
    }
  });

  /* ============ 子帧主动上交资料 ============ */

  /**
   * 把本帧的正文/大纲/图片数交给后台缓存。
   * 为什么不用"顶层来问":问是要**应答**的 —— 重页面(ebook/播放器)里帧脚本正忙,350ms/1.5s 内回不上话就被当成
   * "读不到",于是出现"翻译能翻到、阅读助手看不到"。翻译之所以稳,就是因为各帧自己干活、无需应答。这里照搬这套思路:
   * 各帧在加载后与内容变动后主动交一份,阅读助手直接用缓存。
   */
  /** 判定本帧的「内容形态」。
   *  有些内嵌框(ebook/PDF 阅读器)的正文是**图片或画布**渲染的 —— 文字节点根本不存在,
   *  阅读助手的过滤当然颗粒无收;而翻译能"翻到"的恰恰是这些图上的字(图片翻译)。
   *  所以这里如实上报形态,让面板能对用户和模型说清「这块是图片」而不是含糊的"读不到"。 */
  function frameKind(textChars, imgCount) {
    const o = { kind: 'empty', canvas: 0, pdf: 0, imgs: imgCount || 0 };
    try {
      const d = document;
      try { o.canvas = d.querySelectorAll('canvas').length; } catch (e) { /* 忽略 */ }
      try { o.pdf = d.querySelectorAll('embed[type*="pdf" i],object[type*="pdf" i],iframe[src*=".pdf" i]').length; } catch (e) { /* 忽略 */ }
      if (textChars >= 200) o.kind = 'text';
      else if (o.canvas) o.kind = 'canvas';
      else if (o.pdf) o.kind = 'pdf';
      else if (o.imgs) o.kind = 'imageOnly';
      else o.kind = textChars > 0 ? 'short' : 'empty';
    } catch (e) { /* 忽略 */ }
    return o;
  }

  /** 兜底取文:阅读助手的正文过滤会丢"导航/短行"这类内容,而翻译是"能看见就翻"。
   *  翻译能翻到框内文字、阅读助手却拿不到时就是这种情况 —— 子帧若过滤后颗粒无收,就直接取可见文本。 */
  function frameFallbackChunks(limit) {
    try {
      const body = document.body;
      if (!body) return [];
      const txt = String(body.innerText || '').replace(/\u00a0/g, ' ');
      const lines = txt.split(/\n+/).map((x) => x.trim()).filter((x) => x.length > 1);
      if (!lines.length) return [];
      const out = [];
      let cur = '';
      for (const ln of lines) {
        cur = cur ? (cur + ' ' + ln) : ln;
        if (cur.length >= 300) { out.push(cur); cur = ''; if (out.length >= (limit || 12)) break; }
      }
      if (cur && out.length < (limit || 12)) out.push(cur);
      if (!out.length) {
        // 再深一层:框里又套了框(播放器/文档查看器常见)→ 把同源嵌套框的可见文字也收上来
        try {
          const frames = [...document.querySelectorAll('iframe,frame')];
          for (const f of frames) {
            let d2 = null;
            try { d2 = f.contentDocument; } catch (e) { d2 = null; }
            if (!d2 || !d2.body) continue;
            const t2 = String(d2.body.innerText || '').replace(/\u00a0/g, ' ').trim();
            if (t2.length < 2) continue;
            const lines2 = t2.split(/\n+/).map((x) => x.trim()).filter((x) => x.length > 1);
            let cur2 = '';
            for (const ln of lines2) {
              cur2 = cur2 ? (cur2 + ' ' + ln) : ln;
              if (cur2.length >= 300) { out.push(cur2); cur2 = ''; if (out.length >= (limit || 12)) break; }
            }
            if (cur2 && out.length < (limit || 12)) out.push(cur2);
            if (out.length >= (limit || 12)) break;
          }
        } catch (e2) { /* 忽略 */ }
      }
      return out.map((t) => ({ text: t.slice(0, 1200), heading: '', chars: t.length }));
    } catch (e) { return []; }
  }

  let pieceDirty = true;
  async function pushReaderPiece() {
    if (window.top === window) return;                    // 顶层自己的文档由 LFReader 直接读,不用上报
    try {
      if (typeof Reader === 'undefined' || !Reader || !Reader.build) return;
      const r = Reader.build({ maxChunks: 24, minChunkChars: 12 });   // 内嵌文档常见短段落 → 放宽
      let chunks = r.chunks.slice(0, 24).map((c) => ({ text: c.text, heading: c.heading, chars: c.chars || (c.text || '').length }));
      if (!chunks.length) chunks = frameFallbackChunks(40);           // 过滤后颗粒无收 → 直接取可见文本(与翻译同口径)
      const imgN = (r.images || []).length;
      let chars = 0;
      for (const c of chunks) chars += (c.chars || (c.text || '').length || 0);
      const kd = frameKind(chars, imgN);                 // 形态:文字 / 图片正文 / 画布 / PDF
      Lib.sendMsg({
        type: 'framePiece',
        piece: {
          url: location.href, title: document.title,
          chunks: chunks,
          outline: r.outline.slice(0, 8).map((o) => ({ level: o.level, text: o.text })),
          images: imgN, chars: chars,
          carriers: imgN + kd.canvas,                       // 承载内容的"图"数:img + canvas(PDF.js 把整页画在 canvas 上)
          kind: kd.kind, canvas: kd.canvas, pdf: kd.pdf,
        },
      }, 4000).catch(() => {});
    } catch (e) { /* 忽略 */ }
  }

  /* ============ 启动 ============ */

  // 子帧向后台登记自己(frameId 由后台从 sender.frameId 取):跨域内嵌框内容要靠它精确回问,
  // 不能靠"从 1 往上试"—— frameId 不连续,导航后新帧的 id 可能很大,试几下就漏了。
  if (window.top !== window) {
    try { Lib.sendMsg({ type: 'frameHello', url: location.href }).catch(() => {}); } catch (e) { /* 忽略 */ }
    // 主动上交(不靠应答):延迟一点等 DOM 成型,之后 DOM 有变动就重交
    setTimeout(() => { pushReaderPiece(); }, 700);
    try {
      const mo = new MutationObserver(() => { pieceDirty = true; });
      mo.observe(document.documentElement || document, { childList: true, subtree: true, characterData: true });
      setInterval(() => { if (pieceDirty) { pieceDirty = false; pushReaderPiece(); } }, 4000);   // 切课/换页后更快把新内容交上去
    } catch (e) { /* 忽略 */ }
  }

  try { addEventListener('scroll', onScroll, { passive: true }); } catch (e) {}

  Lib.loadSettings().then((s) => {
    st = s;
    if (Panel && window.top === window && s.chatEnabled !== false && s.panelMode !== 'sidepanel') {
      try { Panel.build(); } catch (e) { /* 面板构建失败不影响翻译 */ }
    }
    if (s.translateDynamic) startObserver();
    if (s.translateOnLoad && !window.__aiTransLoaded) {
      window.__aiTransLoaded = true;
      setTimeout(() => translatePage(s).catch(() => {}), 800);
    }
  });
})();

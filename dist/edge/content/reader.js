/* content/reader.js —— 页面读取(给 AI 对话提供上下文)
 *
 * 产出:meta / 大纲 / 正文分片(带 DOM 锚点,便于引用跳转)/ 图片清单 / 表格。
 * 正文定位用「文本密度 ×(1-链接密度)+ 标签加权」启发式,不引入 Readability 依赖。
 */
'use strict';
(function (global) {
  const MAX_CHUNK = 800;
  const NOISE_TAGS = new Set(['NAV', 'FOOTER', 'ASIDE', 'HEADER']);

  /* ---------- 纯逻辑(可单测) ---------- */

  function linkDensity(text, linkText) {
    const t = String(text || '').length;
    if (!t) return 0;
    return Math.min(1, String(linkText || '').length / t);
  }

  function scoreOf({ textLen = 0, linkLen = 0, tag = '', inArticle = false }) {
    const density = textLen ? Math.min(1, Math.max(0, linkLen) / textLen) : 0;   // 数值直接算,别造字符串
    let s = textLen * (1 - density);
    if (tag === 'ARTICLE' || tag === 'MAIN') s += 300;
    else if (tag === 'SECTION') s += 120;
    if (inArticle) s += 200;
    return s;
  }

  /* ---------- DOM 部分 ---------- */

  function isNoise(el) {
    const d = (el && el.ownerDocument) || document;
    for (let a = el; a && a !== d.body; a = a.parentElement) {
      if (a.tagName && NOISE_TAGS.has(a.tagName)) return true;
    }
    return false;
  }

  function anchorOf(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) {
      const d0 = el.ownerDocument || document;
      try { if (d0.querySelectorAll('#' + el.id).length === 1) return '#' + el.id; } catch (e) { /* 忽略 */ }
    }
    const parts = [];
    const d1 = el.ownerDocument || document;
    let a = el;
    while (a && a.nodeType === 1 && a !== d1.documentElement && parts.length < 6) {
      const parent = a.parentElement;
      if (!parent) break;
      const idx = Array.prototype.indexOf.call(parent.children, a) + 1;
      parts.unshift(a.tagName.toLowerCase() + ':nth-child(' + idx + ')');
      a = parent;
    }
    return parts.length ? parts.join(' > ') : null;
  }

  /** 取文本一律用 textContent:innerText 会触发布局/重排,逐元素调用会让大页面卡数秒 */
  function textOf(el) {
    if (!el) return '';
    const t = (el.textContent == null ? '' : el.textContent);
    return t.replace(/\s+/g, ' ').trim();
  }

  function linkTextLen(el) {
    let n = 0;
    try { for (const a of el.querySelectorAll('a')) n += (a.textContent || '').length; } catch (e) { /* 忽略 */ }
    return n;
  }

  /** 正文根:分值最高的元素;失败回退 body(可传 doc 以支持同源内嵌框) */
  function mainRoot(doc) {
    const d = doc || document;
    const body = d.body;
    if (!body) return null;
    const bodyText = textOf(body);
    // body 作为默认候选并轻微加权:正文若被拆在多个兄弟容器里(很常见),
    // 只挑「分数最高的子容器」会漏掉大半内容;宁可读全,噪声交给 noise 标记降权。
    let best = body;
    let bestScore = bodyText.length * 1.06;
    let els;
    try { els = body.querySelectorAll('article,main,section,div,td'); } catch (e) { els = []; }
    let n = 0;
    for (const el of els) {
      if (++n > 4000) break;                                  // 大页面保护
      if (el.id === 'lf-panel-host' || el.id === 'lf-img-layer') continue;
      const t = textOf(el);
      if (t.length < 120) continue;
      const s = scoreOf({ textLen: t.length, linkLen: linkTextLen(el), tag: el.tagName, inArticle: false });
      if (s > bestScore) { bestScore = s; best = el; }
    }
    return best || body;
  }

  /** 隐藏元素判定(便宜版:属性 + 内联样式,不做 getComputedStyle —— 大页面逐元素取计算样式会卡数秒)。
   *  为什么要跳过:隐藏元素里有大量"非正文"文案 —— 典型是课程播放器的**口令闸门**
   *  ("This content is protected / please provide the password",display:none)。
   *  它进了资料,模型就会答"页面明确标注受保护,正文未取到" 。 */
  function isHiddenish(el) {
    let a = el;
    for (let i = 0; a && a.nodeType === 1 && i < 6; i++, a = a.parentElement) {
      try {
        if (a.hasAttribute && a.hasAttribute('hidden')) return true;
        const ar = a.getAttribute && a.getAttribute('aria-hidden');
        if (ar === 'true' && a !== el) return true;
        const st = a.style;
        if (st && (st.display === 'none' || st.visibility === 'hidden')) return true;
      } catch (e) { /* 忽略 */ }
    }
    return false;
  }

  function tableToMarkdown(table) {
    const rows = [...table.querySelectorAll('tr')].slice(0, 30);
    if (!rows.length) return '';
    const cells = (tr) => [...tr.children].map((td) => ((td.textContent || '').replace(/\s+/g, ' ').trim()));
    const head = cells(rows[0]);
    const body = rows.slice(1).map(cells);
    const out = ['| ' + head.join(' | ') + ' |', '| ' + head.map(() => '---').join(' | ') + ' |'];
    for (const r of body) out.push('| ' + r.join(' | ') + ' |');
    return out.join('\n');
  }

  /** 收集要读的文档:顶层 + 同源内嵌框(递归,深度/数量有上限)。
   *  跨域框访问 contentDocument 会抛 → 记进 crossOrigin(内容读不到,交给 buildWithFrames 逐帧收集)。 */
  function collectUnits(opts) {
    const units = [];
    const crossOrigin = [];
    const seen = new Set();
    const maxDocs = opts.maxFrames || 8;
    const maxDepth = opts.maxFrameDepth || 3;
    const frameMeta = (cd, f) => {
      let url = '', title = '';
      try { url = cd.location.href || ''; } catch (e) { url = f.src || ''; }
      try { title = cd.title || ''; } catch (e) { title = ''; }
      return { url, title };
    };
    /** 顶层直接看同源框:有没有可见文字、有几张大图/几个画布。
     *  为什么必须顶层自己看:ebook/PDF 阅读器把正文**画成图或 canvas**,DOM 里没有文字 ——
     *  表现为"图片文字翻译能翻到、阅读助手与选中文字却拿不到"。 */
    const carriersOf = (cd) => {
      const out = { text: 0, imgs: 0, canvases: 0 };
      try { out.text = String(cd.body && cd.body.innerText || '').trim().length; } catch (e) { /* 忽略 */ }
      try {
        for (const im of cd.images || []) {
          const w = im.naturalWidth || im.width || 0;
          const h = im.naturalHeight || im.height || 0;
          if (w >= 200 && h >= 200 && im.src) out.imgs++;             // 大图才可能是正文页,小图标不算
        }
      } catch (e) { /* 忽略 */ }
      try { out.canvases = cd.querySelectorAll('canvas').length; } catch (e) { /* 忽略 */ }
      return out;
    };
    const add = (doc, depth, frame) => {
      if (!doc || units.length >= maxDocs || seen.has(doc)) return;
      let root = null;
      try { root = mainRoot(doc) || doc.body; } catch (e) { root = null; }
      if (!root) return;
      seen.add(doc);
      units.push({ doc, root, frame });
      if (depth >= maxDepth) return;
      let frames = [];
      try { frames = allIframes(doc); } catch (e) { frames = []; }
      for (const f of frames) {
        if (units.length >= maxDocs) break;
        let cd = null;
        try { cd = f.contentDocument; } catch (e) { cd = null; }
        if (!cd) { crossOrigin.push({ src: String(f.src || '').slice(0, 200), title: String(f.title || '').slice(0, 80) }); continue; }
        const meta = frameMeta(cd, f);
        try { meta.carriers = carriersOf(cd); } catch (e) { /* 忽略 */ }     // 同源框:顶层自己数载体
        add(cd, depth + 1, meta);
      }
    };
    add(document, 0, null);
    return { units, crossOrigin };
  }

  /** 收集文档里的 iframe,含影子树内的(querySelectorAll 看不到影子根内部) */
  function allIframes(root, budget = 4000) {
    const out = [];
    const scan = (node) => {
      if (budget-- <= 0 || out.length > 40) return;
      const kids = node.children || [];
      for (const el of kids) {
        if (budget-- <= 0) return;
        if (el.tagName === 'IFRAME') out.push(el);
        if (el.shadowRoot) { try { scan(el.shadowRoot); } catch (e) { /* 忽略 */ } }
        scan(el);
      }
    };
    scan(root.documentElement || root.body || root);
    return out;
  }

  function build(opts = {}) {
    const maxChunks = opts.maxChunks || 400;
    const { units, crossOrigin } = collectUnits(opts);

    // 大纲:子帧条目加 [内嵌框] 前缀(锚点只对顶层有效,子帧置 null)
    const outline = [];
    for (const u of units) {
      let hs = [];
      try { hs = [...u.doc.querySelectorAll('h1,h2,h3,h4,h5,h6')]; } catch (e) { hs = []; }
      for (const h of hs) {
        if (outline.length >= 200) break;
        const text = textOf(h);
        if (!text) continue;
        outline.push({
          level: Number(h.tagName.slice(1)) || 1,
          text: (u.frame ? '[内嵌框] ' : '') + text.slice(0, 160),
          anchor: u.frame ? null : anchorOf(h),
        });
      }
    }

    const chunks = [];
    const images = [];
    const tables = [];
    // 节点访问预算:超大页面(几万节点)不能让"打开面板"卡住浏览器(所有文档共享预算)
    let budget = opts.maxNodes || 20000;
    let hiddenCount = 0;                       // 跳过的隐藏节点(如实汇报:这些不是正文)
    for (const u of units) {
      if (chunks.length >= maxChunks || budget <= 0) break;
      const frameUrl = u.frame ? u.frame.url : null;
      const chunksBefore = chunks.length;                       // 用来判断"这个框有没有产出文字"(没有就上可见文本兜底)
      let cur = { text: '', heading: '', anchor: null, noise: false };
      const flush = () => {
        if (chunks.length >= maxChunks) { cur = { text: '', heading: cur.heading, anchor: null, noise: cur.noise }; return; }
        const t = cur.text.replace(/\s+/g, ' ').trim();
        // 子帧放宽阈值:内嵌文档(ebook/文档查看器)常见"短标题+短段落",30 字符会把整段丢掉
        const minChars = opts.minChunkChars || (frameUrl ? 12 : 30);
        if (t.length >= minChars) {
          chunks.push({
            id: chunks.length, text: t,
            heading: (frameUrl ? '[内嵌框] ' : '') + cur.heading,
            anchor: frameUrl ? null : cur.anchor,
            chars: t.length, noise: cur.noise,
            frame: frameUrl || undefined,
          });
        }
        cur = { text: '', heading: cur.heading, anchor: null, noise: cur.noise };
      };
      const walk = (node) => {
        if (chunks.length >= maxChunks || budget <= 0) return;
        for (const child of node.childNodes) {
          if (--budget <= 0) return;
          if (child.nodeType === 3) {
            const t = (child.nodeValue || '').trim();
            if (!t) continue;
            if (!cur.anchor) cur.anchor = anchorOf(child.parentElement);
            cur.noise = cur.noise || (child.parentElement ? isNoise(child.parentElement) : false);
            cur.text += (cur.text ? ' ' : '') + t;
            if (cur.text.length >= MAX_CHUNK) flush();
            continue;
          }
          if (child.nodeType !== 1) continue;
          const tag = child.tagName;
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') continue;
          if (child.id === 'lf-panel-host' || child.id === 'lf-img-layer') continue;
          if (isHiddenish(child)) { hiddenCount++; continue; }        // 隐藏文案(口令闸门等)不算正文
          // 影子 DOM:现代站点(Web Components)正文常挂在 shadowRoot 里,以前完全读不到
          if (child.shadowRoot) {
            try { walk(child.shadowRoot); } catch (e) { /* 关闭的影子根会抛 → 忽略 */ }
          }
          if (/^H[1-6]$/.test(tag)) {
            flush();
            cur.heading = textOf(child).slice(0, 160);
            cur.anchor = anchorOf(child);
            continue;
          }
          if (tag === 'TABLE' || tag === 'PRE') {
            walk(child);
            flush();
            continue;
          }
          walk(child);
        }
      };
      walk(u.root);
      flush();
      // 同源框兜底:框里明确有可见文字(innerText>40 字)却一段都没产出 → 说明被正文过滤丢了。
      // "翻译能翻到、阅读助手读不到"的站内框(ebook 阅读器)就死在这一步,所以这里直接按可见文本分段补上。
      if (frameUrl && u.frame && u.frame.carriers && (u.frame.carriers.text || 0) > 40 && chunks.length === chunksBefore) {
        try {
          const txt = String((u.doc.body && u.doc.body.innerText) || '').replace(/\u00a0/g, ' ');
          const lines = txt.split(/\n+/).map((x) => x.trim()).filter((x) => x.length > 1);
          let cur2 = '';
          for (const ln of lines) {
            cur2 = cur2 ? (cur2 + ' ' + ln) : ln;
            if (cur2.length >= 300) {
              if (chunks.length >= maxChunks) break;
              chunks.push({ id: chunks.length, text: cur2.slice(0, 1200), heading: '[内嵌框] ', anchor: null, chars: cur2.length, noise: false, frame: frameUrl });
              cur2 = '';
            }
          }
          if (cur2 && chunks.length < maxChunks) {
            chunks.push({ id: chunks.length, text: cur2.slice(0, 1200), heading: '[内嵌框] ', anchor: null, chars: cur2.length, noise: false, frame: frameUrl });
          }
        } catch (e) { /* 忽略 */ }
      }

      // 图片(子帧图片的锚点无意义 → 置 null)
      let imgs = [];
      try { imgs = [...u.root.querySelectorAll('img')]; } catch (e) { imgs = []; }
      for (const img of imgs) {
        if (images.length >= 30) break;
        const src = img.currentSrc || img.src;
        if (!src) continue;
        const w = img.naturalWidth || 0, h = img.naturalHeight || 0;
        if (w && h && w < 80 && h < 80) continue;
        images.push({
          id: images.length, src, alt: (img.getAttribute('alt') || '').trim().slice(0, 200),
          anchor: frameUrl ? null : anchorOf(img), w, h, frame: frameUrl || undefined,
        });
      }
      // 表格
      try {
        for (const t of [...u.root.querySelectorAll('table')].slice(0, 5)) {
          const md = tableToMarkdown(t);
          if (md) tables.push({ anchor: frameUrl ? null : anchorOf(t), markdown: md, frame: frameUrl || undefined });
        }
      } catch (e) { /* 忽略 */ }
    }

    const meta = {
      title: document.title || '',
      url: location.href,
      lang: document.documentElement.getAttribute('lang') || '',
      description: (document.querySelector('meta[name="description"]') || {}).content || '',
      // 同源内嵌框清单 + 跨域框(读不到内容,如实告知)
      frames: units.slice(1).map((u) => ({ url: u.frame.url, title: u.frame.title })),
      crossOrigin: crossOrigin.slice(0, 8),
    };

    return {
      meta, outline, chunks, images, tables,
      stats: {
        chars: chunks.reduce((a, c) => a + c.chars, 0),
        chunks: chunks.length, images: images.length, outline: outline.length,
        hidden: hiddenCount,                   // 被跳过的隐藏节点数(含口令闸门这类非正文文案)
        frames: {
          included: units.length - 1,
          crossOrigin: crossOrigin.length,
          total: units.length - 1 + crossOrigin.length,
        },
      },
    };
  }

  /**
   * 带内嵌框的完整读取:同源子帧已由 build() 走 DOM 遍历并入;
   * 跨域子帧内容读不到 → 让后台逐帧问子帧自己的 content script 拼回来。
   * 快速路径:顶层没发现跨域框时完全不发消息(普通页面零额外开销)。
   */
  /**
   * 页面资料 = 顶层自己的内容 + **每个内嵌框自己交上来的那份**(和翻译的覆盖范围一致:
   * 翻译能翻到的框,这里就必须能看到)。顶层 DOM 遍历拿到的框内容只作为"某个框没应答"时的兜底,
   * 并在该框有应答时被替换掉(避免同一份内容算两遍)。
   */
  async function buildWithFrames(opts = {}) {
    const r = build(opts);
    const frames = (r.meta && r.meta.frames) || [];           // 同源框(顶层遍历到的)
    const co = (r.meta && r.meta.crossOrigin) || [];          // 跨域框(顶层读不到)

    // ⚠️ build() 里找框是在"正文根"子树里扫的 —— 而课程播放器这类页面,正文根会被选成侧栏那一小块,
    // 于是**整块 iframe 一个都扫不到**,内嵌框的内容会整个漏掉。这里顶层**独立、全文档**扫一遍,不再依赖正文根。
    const topFrames = (() => {
      const out = [];
      try {
        for (const f of document.querySelectorAll('iframe,frame')) out.push(f);
      } catch (e) { /* 忽略 */ }
      const walkShadow = (root) => {
        try {
          for (const el of root.querySelectorAll('*')) {
            if (!el.shadowRoot) continue;
            try { for (const f2 of el.shadowRoot.querySelectorAll('iframe,frame')) out.push(f2); } catch (e) { /* 忽略 */ }
            walkShadow(el.shadowRoot);
          }
        } catch (e) { /* 忽略 */ }
      };
      try { walkShadow(document); } catch (e) { /* 忽略 */ }
      return out;
    })();
    const carrierOf = (cd) => {
      const o = { text: 0, imgs: 0, canvases: 0 };
      try { o.text = String((cd.body && cd.body.innerText) || '').trim().length; } catch (e) { /* 忽略 */ }
      try {
        for (const im of cd.images || []) {
          const w = im.naturalWidth || im.width || 0, h = im.naturalHeight || im.height || 0;
          if (w >= 200 && h >= 200 && im.src) o.imgs++;
        }
      } catch (e) { /* 忽略 */ }
      try { o.canvases = cd.querySelectorAll('canvas').length; } catch (e) { /* 忽略 */ }
      return o;
    };
    // 顶层能把同源框的内容**直接**并进资料(不等任何应答):文字走可见文本,图片/画布走"图片正文框"
    const topRead = { frames: [], crossOrigin: [], directChunks: 0 };
    for (const f of topFrames) {
      let cd = null;
      try { cd = f.contentDocument; } catch (e) { cd = null; }
      let u = '';
      try { u = (cd && cd.location && cd.location.href) || f.src || ''; } catch (e) { u = f.src || ''; }
      if (!cd) { topRead.crossOrigin.push({ src: String(u).slice(0, 200), title: String(f.title || '').slice(0, 80) }); continue; }
      let c = { text: 0, imgs: 0, canvases: 0 };
      try { c = carrierOf(cd); } catch (e) { /* 忽略 */ }
      topRead.frames.push({ url: String(u || '').slice(0, 300), title: String(cd.title || '').slice(0, 120), carriers: c });
      // 框里有可见文字却一段都没并进来 → 直接按可见文本补(翻译能翻到就说明字确实在)
      const already = r.chunks.some((x) => x.frame && x.frame === u);
      if (!already && (c.text || 0) > 40) {
        try {
          const lines = String((cd.body && cd.body.innerText) || '').split(/\n+/).map((x) => x.trim()).filter((x) => x.length > 1);
          let cur = '';
          for (const ln of lines) {
            cur = cur ? (cur + ' ' + ln) : ln;
            if (cur.length >= 300) { r.chunks.push({ id: r.chunks.length, text: cur.slice(0, 1200), heading: '[内嵌框] ', anchor: null, chars: cur.length, noise: false, frame: String(u) }); cur = ''; topRead.directChunks++; }
          }
          if (cur) { r.chunks.push({ id: r.chunks.length, text: cur.slice(0, 1200), heading: '[内嵌框] ', anchor: null, chars: cur.length, noise: false, frame: String(u) }); topRead.directChunks++; }
        } catch (e) { /* 忽略 */ }
      }
    }
    // 合并进 meta(供后面的图片正文框判定与如实汇报使用)
    try {
      const seenF = new Set(frames.map((x) => x && x.url));
      for (const f of topRead.frames) if (!seenF.has(f.url)) frames.push(f);
      const seenC = new Set(co.map((x) => x && x.src));
      for (const f of topRead.crossOrigin) if (!seenC.has(f.src)) co.push(f);
      r.meta.frames = frames;
      r.meta.crossOrigin = co;
      if (topRead.directChunks) { r.stats.chunks = r.chunks.length; r.stats.chars = r.chunks.reduce((a, c) => a + (c.chars || 0), 0); }
    } catch (e) { /* 忽略 */ }

    if (!frames.length && !co.length) return r;               // 真没有内嵌框 → 零额外开销

    const maxChunks = opts.maxChunks || 400;
    let pieces = [];
    let answered = 0, asked = 0, frameImages = 0;
    try {
      const res = await global.Lib.sendMsg({ type: 'collectFramePieces' }, 8000);
      pieces = (res && res.pieces) || [];
      asked = (res && res.asked) || 0;
      answered = pieces.length;
      frameImages = (res && res.frameImages) || 0;              // 内嵌框里的图片数(用户要求:翻译能覆盖的,助手也要看得见)
    } catch (e) { /* 收集失败不挡路:至少还有顶层内容 */ }

    // 每个框只留"最长的那份应答"(同一个框可能被登记表与小范围试探各问一次)
    const byUrl = new Map();
    const imgOnly = new Map();                                  // 文字取不到、但内容以图片/画布形式存在的框
    for (const pc of pieces) {
      if (!pc || !pc.url) continue;
      // ⚠️ 以前这里"框地址与顶层相同 → 整页重复,丢弃"。但课程播放器(LearnWorlds 等)常把**同一个 URL**
      // 的页面开在 iframe 里、内容却不同(正文在框里、外壳在顶层):一丢就等于"框里有字却一个字都没进来"。
      // 现在改为保留,由下面的**文本级去重**保证不重复(同址又完全无内容的才丢)。
      if (pc.url === (r.meta && r.meta.url) && !(pc.chunks && pc.chunks.length)) continue;
      if (!pc.chunks || !pc.chunks.length) {
        // 没有文字片段:若该帧自报是图片正文(ebook/PDF/画布),不能算"读不到"
        const carriers = Number(pc.carriers || 0) || Number(pc.images || 0);
        if (carriers > 0 || pc.kind === 'canvas' || pc.kind === 'pdf' || pc.kind === 'imageOnly') {
          const cur0 = imgOnly.get(pc.url);
          if (!cur0 || carriers > (Number(cur0.carriers || 0) || Number(cur0.images || 0))) imgOnly.set(pc.url, pc);
        }
        continue;
      }
      const cur = byUrl.get(pc.url);
      if (!cur || pc.chunks.length > cur.chunks.length) byUrl.set(pc.url, pc);
    }
    // 顶层已有文本的归一化指纹:同址框(或框里又嵌整页)的重复段落不再计入
    const sig = (t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 200);

    const covered = new Set([...byUrl.keys(), ...imgOnly.keys()]);   // 图片正文框也算"已覆盖"(内容以图片形式进了视野)
    // ① 框自己给了资料 → 用它(权威),先把顶层遍历里同一框的片段剔掉,再补上
    const kept = r.chunks.filter((c) => !(c.frame && covered.has(c.frame)));
    r.chunks = kept;
    // ⚠️ 去重必须**保守**:顶层只有零星几段时,一命中就等于把框里的真内容全丢(框里有字而资料仍 0 段)。
    // 所以只在顶层本身内容足够多(>=8 段)时才按文本去重,且短文本一律不去重。
    const useDedup = r.chunks.length >= 8;
    const topTexts = new Set(r.chunks.map((c) => sig(c.text)));
    for (const [url, pc] of byUrl) {
      for (const c of pc.chunks) {
        if (r.chunks.length >= maxChunks) break;
        const text = String(c.text || '').slice(0, 1200);
        if (!text) continue;
        if (useDedup && text.length > 80 && topTexts.has(sig(text))) continue;   // 顶层已有同一段 → 不重复计入
        r.chunks.push({
          id: r.chunks.length, text,
          heading: '[内嵌框] ' + String(c.heading || '').slice(0, 120),
          anchor: null, chars: text.length, noise: false, frame: url,
        });
      }
      for (const o of (pc.outline || []).slice(0, 12)) {
        r.outline.push({ level: o.level || 1, text: '[内嵌框] ' + String(o.text || '').slice(0, 120), anchor: null });
      }
    }
    // ①' 同源框:顶层自己发现"没有可见文字、但有整页图/画布"的,直接计入图片正文框。
    //    ⚠️ 必须排在 silent 之前算:这类框不是"读不到文字",被计进 silent 会让面板出现
    //    "含 1 个内嵌框(-1 个有文字 / 1 个正文是图片 / 1 个未读到文字)"这种自相矛盾的数字。
    try {
      const ioTop = [];
      for (const f of frames) {
        const c = f && f.carriers;
        if (!c) continue;
        if ((c.text || 0) > 40) continue;                       // 有可见文字 → 走正常文本路径
        const n = (c.imgs || 0) + (c.canvases || 0);
        // 连图/canvas 都数不到(可能是 CSS 背景图或未知渲染)也算候选:交给"自动截屏"兜底,宁可多截一张
        ioTop.push({ url: String(f.url || '').slice(0, 160),
          kind: n ? (c.canvases && !c.imgs ? 'canvas' : 'imageOnly') : 'blind',
          imgs: n, blind: n === 0, fromTop: true });
      }
      if (ioTop.length) {
        r.stats.frames = r.stats.frames || { included: 0, crossOrigin: 0, total: 0 };
        // 必须先建数组再 push:以前直接 push 到 undefined → TypeError 被 catch 吞掉,整段逻辑等于没跑
        if (!r.stats.frames.imageOnly) r.stats.frames.imageOnly = [];
        const seenIo = new Set(r.stats.frames.imageOnly.map((x) => String(x.url)));
        for (const x of ioTop) if (!seenIo.has(x.url)) r.stats.frames.imageOnly.push(x);
      }
    } catch (e) { /* 忽略 */ }

    // ② 没应答的框:顶层遍历到的内容继续留着(有则留,不会更差),并如实记进统计
    //    已判定为"图片正文框"的框不算 silent(它的内容以图片形式进来了,只是没有文字节点)
    const ioSet = new Set([...imgOnly.keys()].map((u) => String(u))
      .concat(((r.stats.frames && r.stats.frames.imageOnly) || []).map((x) => String(x.url))));
    const isImgOnlyFrame = (u) => { const s = String(u || ''); return ioSet.has(s) || ioSet.has(s.slice(0, 160)); };
    const silent = [];
    const directUrls = new Set(r.chunks.filter((c) => c.frame).map((c) => String(c.frame)));   // 顶层直读已并进文字的框
    for (const f of frames) if (f && f.url && !covered.has(f.url) && !directUrls.has(String(f.url)) && !isImgOnlyFrame(f.url)) silent.push(f.url);
    for (const f of co) if (f && f.src && !covered.has(f.src) && !directUrls.has(String(f.src)) && !isImgOnlyFrame(f.src)) silent.push(String(f.src));

    r.stats.frames = r.stats.frames || { included: 0, crossOrigin: 0, total: 0 };
    r.stats.frames.remote = byUrl.size;                        // 由框自己交上来的框数
    r.stats.frames.silent = silent.length;                     // 没应答的框(读不到,如实告知模型)
    r.stats.frames.silentUrls = silent.slice(0, 5);
    r.stats.frames.readUrls = [...byUrl.keys()].map((u) => String(u).slice(0, 160)).slice(0, 5);
    if (frameImages) {
      r.stats.imagesFrames = frameImages;
      r.stats.imagesTotal = (r.stats.images || 0) + frameImages;   // 资料行按这个显示"总共看得见几张"
    } else {
      r.stats.imagesTotal = r.stats.images || 0;
    }
    r.stats.frames.asked = asked;
    r.stats.frames.answered = answered;

    // 图片正文框:文字取不到,但**翻译能翻到**(翻的是图上的字)。如实记下来,
    // 面板会把框里的整页图当图片附件交给视觉模型 —— 用户要的就是"翻译看得见的,助手也看得见"。
    const remoteIo = [...imgOnly.entries()].map(([url, pc]) => ({
      url: String(url).slice(0, 160), kind: pc.kind || 'imageOnly',
      imgs: Number(pc.carriers || 0) || Number(pc.images || 0),
    }));
    // ⚠️ 这里是**合并**而不是覆写:上面"顶层自己发现的图片正文框"必须保留,
    //    否则 ① 上面那段等于白算 ② 面板不会再自动带整页图/自动截屏兜底。
    const remoteUrls = new Set(remoteIo.map((x) => x.url));
    const topOnly = (r.stats.frames.imageOnly || []).filter((x) => !remoteUrls.has(String(x.url)));
    r.stats.frames.imageOnly = remoteIo.concat(topOnly).slice(0, 6);
    r.stats.frames.imageOnlyCount = r.stats.frames.imageOnly.length;
    r.stats.frames.imageOnlyImgs = r.stats.frames.imageOnly.reduce((a, x) => a + (x.imgs || 0), 0);
    // 只把"顶层才发现、框自己没上报"的那部分图数并进总数:
    // remoteIo 那些框的图数已经在 frameImages 里(来自各帧自报),再累加一次就是重复计数
    // (以前一张 canvas 正文页会被显示成"2 图")。
    const topIoImgs = topOnly.reduce((a, x) => a + (x.imgs || 0), 0);
    if (topIoImgs) {
      r.stats.imagesFrames = (r.stats.imagesFrames || 0) + topIoImgs;
      r.stats.imagesTotal = (r.stats.images || 0) + r.stats.imagesFrames;
    }
    r.stats.chunks = r.chunks.length;
    r.stats.chars = r.chunks.reduce((a, c) => a + (c.chars || 0), 0);
    return r;
  }

  const HL_TIMERS = new WeakMap();      // el -> timer:同一元素连点两次不能把"高亮态"当原始态存下来

  /** 引用跳转:滚动到锚点并短暂高亮 */
  function scrollTo(anchor) {
    if (!anchor) return false;
    let el = null;
    try { el = document.querySelector(anchor); } catch (e) { return false; }
    if (!el) return false;
    try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { try { el.scrollIntoView(); } catch (e2) {} }
    if (!HL_TIMERS.has(el)) {                       // 首次高亮才记录原始态(连点不覆盖)
      const prev = el.style.outline, prev2 = el.style.outlineOffset;
      HL_TIMERS.set(el, { timer: null, prev, prev2 });
    }
    const rec = HL_TIMERS.get(el);
    if (rec.timer) clearTimeout(rec.timer);
    el.style.outline = '2px solid #2563eb';
    el.style.outlineOffset = '2px';
    rec.timer = setTimeout(() => {
      el.style.outline = rec.prev;
      el.style.outlineOffset = rec.prev2;
      HL_TIMERS.delete(el);
    }, 2000);
    return true;
  }

  const api = { build, buildWithFrames, collectUnits, scrollTo, anchorOf, tableToMarkdown, isNoise,
    pure: { linkDensity, scoreOf } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.LFReader = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

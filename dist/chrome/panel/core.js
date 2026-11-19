/* panel/core.js —— 页面 AI 对话的逻辑核心(与承载容器解耦)
 *
 * 容器(inpage / sidepanel)只需实现:render(state) / stream(text) / error(text) / scrollBottom()
 * 上下文策略:
 *   - system 里放「整会话固定」的页面资料(meta+大纲+开篇)→ 命中上游 prompt cache,几乎零成本
 *   - 每一轮只追加「本轮检索到的新片段」(sentIds 去重),token 不随轮数膨胀
 */
'use strict';
(function (global) {
  const MODES = {
    qa: {
      label: '答疑', icon: '💬',
      prompt: '基于页面内容回答用户问题。只依据页面资料,资料里没有的就直说「页面里没有提到」,不要编造。结论要写明依据,并在句末用 [[n]] 标注引用的片段编号。',
    },
    summary: {
      label: '总结', icon: '📌',
      prompt: '用中文总结这个页面:先一句话 TL;DR,再给 3-7 条要点(每条一句),最后一句结论或建议。要点要具体,不要泛泛而谈;引用页面关键信息时用 [[n]] 标注片段编号。',
    },
    notes: {
      label: '笔记', icon: '🗒️',
      prompt: '把这个页面整理成结构化 Markdown 笔记:一级标题用页面主题,分节列出要点;末尾附「术语表」(页面里出现的专有名词 + 一句解释)和「待办/疑问」。引用时用 [[n]]。',
    },
    read: {
      label: '快速阅读', icon: '⚡',
      prompt: '帮用户 30 秒读懂这个页面:一句话结论、3-5 个关键信息(含数字/结论)、以及「谁需要读它」。不要复述原文,要提炼。引用时用 [[n]]。',
    },
    organize: {
      label: '整理大纲', icon: '🗂️',
      prompt: '把这个页面的内容整理成层级大纲(最多三层),每节后面用一句话概括讲了什么,并在最后用 2-3 句说明各节之间的逻辑关系。用 [[n]] 标注依据。',
    },
    translate: {
      label: '翻译选中', icon: '🌐',
      prompt: '翻译用户提供的文本;保留专业术语的通行译法(可参考术语表),只输出译文。',
    },
  };

  const state = {
    open: false, mode: 'qa', busy: false, ready: false,
    reader: null, readerAt: 0, digest: '', history: [], attachments: [], sentIds: new Set(), streamingText: '',
    persistLoaded: false,
    container: null, seq: 0, lastError: '', abort: null, abortCallUser: false,
    frameImgAttached: false,          // 内嵌框"图片正文"的整页图每页只自动收一次(别每问一句都重传)
    frameImgTries: 0,                 // 抓图尝试次数(失败可重试,但有上限 —— 别每问一句都截一次屏)
    frameImgNote: 0,                  // 本次自动收上来几张(资料行要如实显示)
  };

  const SYS_ROLE = '你是嵌入浏览器扩展的网页阅读助手。回答要简洁、具体、用简体中文,可用 Markdown。'
    // 网页正文常有取不到的部分(PDF/画布渲染、口令后异步加载、沙箱框):资料里会如实标注 → 别编造、也别猜我们的实现
    // (⚠️ 这里曾经多写了一个分号:字符串拼接被截断,后面的引用规则整条发不出去 —— 已修)
    + '若资料里标注了某些区域(如内嵌框)没有取到文字,而用户问的正是那里的内容:直接说明"这块没能从页面上取到",并建议用户点「📷」框选该区域截图(视觉模型可直接读图);不要凭空推测,也不要解释扩展的内部实现。'
    + '若资料里说明某个内嵌框的正文是图片/画布渲染(PDF、ebook 阅读器),那么它的内容以**图片**形式提供:能读图就直接读图作答,不要再说"读不到"。'
    + '页面资料只包含页面**可见内容**(隐藏的口令、提示、模板类文案不计入)。'
    + '若某个内嵌框确实没有文字而正文是图片/画布,就按上面说的读图或建议截图,不要猜扩展的实现。'
    + '页面资料以 [片段 n] 形式给出,引用时必须写成 [[n]] 以便跳转。';

  function mount(container) {
    state.container = container;
    return state;
  }

  /** side panel 场景:reader 由页面的 content script 提供(面板页自己没有 DOM) */
  function setReader(reader) {
    if (!reader) return;
    state.reader = reader;
    state.digest = (typeof LFRag !== 'undefined') ? LFRag.buildDigest(reader) : '';
    state.ready = true;
  }

  /* ---------- chatPersist:按网址把对话存本地(设置页那个开关必须真的有用) ---------- */

  function chatStoreKey() {
    try {
      const u = (state.reader && state.reader.meta && state.reader.meta.url)
        || (typeof location !== 'undefined' ? location.href : '');
      return 'lfChat:' + String(u || '').split('#')[0].slice(0, 300);
    } catch (e) { return 'lfChat:unknown'; }
  }

  async function loadPersisted(st) {
    if (!st || !st.chatPersist || state.persistLoaded) return;
    state.persistLoaded = true;
    try {
      // 注意:Lib.storageGet(keys) 返回的是 {key: value} 整个对象(chrome.storage.local.get 语义)
      const key = chatStoreKey();
      const bag = await Lib.storageGet(key);
      const v = bag && typeof bag === 'object' ? bag[key] : null;
      if (v && Array.isArray(v.history) && v.history.length && !state.history.length) {
        state.history = v.history.slice(-40)
          .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string')
          .map((m) => ({ role: m.role, text: m.text.slice(0, 8000) }));
        if (state.container) state.container.render(state);
      }
    } catch (e) { /* 存储不可用 → 忽略 */ }
  }

  function persist(st) {
    if (!st || !st.chatPersist) return;
    try {
      const slim = state.history.slice(-40).map((m) => ({ role: m.role, text: String(m.text || '').slice(0, 8000) }));
      Lib.storageSet({ [chatStoreKey()]: { ts: Date.now(), history: slim } });
    } catch (e) { /* 忽略 */ }
  }

  /** 新建对话时清掉本网址的记录 */
  function clearPersisted() {
    try { Lib.storageSet({ [chatStoreKey()]: { ts: Date.now(), history: [] } }); } catch (e) {}
  }

  async function ensureReader(st, force) {
    // 资料太久(默认 20s)就重建:页面/内嵌框可能是懒加载,面板打开那一刻还没有内容
    // (用户报"阅读助手看不到 iframe"——翻译能翻到、阅读助手看不到,就是这一类)
    const ttl = (st && st.readerTtlMs) ? st.readerTtlMs : 20000;
    if (state.reader && state.ready && state.readerAt && (Date.now() - state.readerAt) > ttl) {
      state.reader = null; state.ready = false;
    }
    if (state.reader && state.ready && !force) { await loadPersisted(st); return state.reader; }
    // buildWithFrames:同源内嵌框已由 DOM 遍历并入,跨域框由后台逐帧收集(没有跨域框时零额外开销)
    state.reader = (typeof LFReader !== 'undefined')
      ? ((LFReader.buildWithFrames ? await LFReader.buildWithFrames() : LFReader.build()))
      : {
      meta: {
        title: (typeof document !== 'undefined' ? document.title : ''),
        url: (typeof location !== 'undefined' ? location.href : ''),
      },
      outline: [], chunks: [], images: [], tables: [], stats: {},
    };
    state.digest = (typeof LFRag !== 'undefined') ? LFRag.buildDigest(state.reader) : '';
    state.readerAt = Date.now();
    state.ready = true;
    // 如实汇报:内嵌框取不到文字是"用户看不到"的主因(PE/ebook 常把正文放在 PDF/画布渲染或口令后才加载的容器里)
    const frs = (state.reader.stats && state.reader.stats.frames) || null;
    state.notice = '';                                      // 每次(重)读先清掉上一次的提示,避免旧文案留在资料行上
    if (frs && frs.silent) {
      state.notice = frs.silent + ' 个内嵌框没取到文字(常见:点开后异步加载,或沙箱框)→ 用 📷 框选那块内容,视觉模型能直接读图';
    } else if (force && frs && (frs.total || frs.remote)) {
      state.notice = '已重读:含 ' + (frs.total || frs.remote) + ' 个内嵌框,本页共 ' + ((state.reader.stats && state.reader.stats.chunks) || 0) + ' 段';
    }
    await loadPersisted(st);                                // 开了「按网址保存」→ 回灌上次的记录
    return state.reader;
  }

  /** 用户主动停止(或新意图让位):与内部失败区分开(否则真错误会被当"用户中止"静默吞掉) */
  function stop() {
    try { if (state.abort) state.abort(); } catch (e) { /* 忽略 */ }
  }

  function setMode(mode) {
    if (MODES[mode]) state.mode = mode;
    return state.mode;
  }

  /** 顶层直接抓**同源框**里的整页图/canvas。
   *  ebook/PDF 阅读器把正文画成图(用户那条"框里文字选不中"就是证据):这类框里没有文字节点,
   *  顶层却能和它同源 → 直接按 src 取图最可靠,不依赖子帧脚本应答。 */
  function topFrameImages(urls) {
    const out = [];
    try {
      if (typeof document === 'undefined') return out;
      const want = new Set((urls || []).map((u) => String(u)));
      for (const f of document.querySelectorAll('iframe,frame')) {
        let cd = null;
        try { cd = f.contentDocument; } catch (e) { cd = null; }
        if (!cd) continue;
        let u = '';
        try { u = (cd.location && cd.location.href) || ''; } catch (e) { u = f.src || ''; }
        if (want.size && !want.has(String(u))) continue;
        try {
          for (const im of cd.images || []) {
            const w = im.naturalWidth || im.width || 0;
            const h = im.naturalHeight || im.height || 0;
            if (w >= 200 && h >= 200 && im.src && /^https?:/i.test(im.src)) out.push({ url: im.src, frameUrl: u, w: w, h: h });
          }
        } catch (e) { /* 忽略 */ }
        try {
          for (const cv of cd.querySelectorAll('canvas')) {
            const w = cv.width || 0, h = cv.height || 0;
            if (w < 200 || h < 200) continue;
            let d = '';
            try { d = cv.toDataURL('image/png'); } catch (e) { d = ''; }        // 跨域污染的画布会抛
            if (d) out.push({ dataUrl: d, frameUrl: u, w: w, h: h, canvas: true });
          }
        } catch (e) { /* 忽略 */ }
      }
    } catch (e) { /* 忽略 */ }
    return out;
  }

  /** 终极兜底:文字取不到、图也抓不到 → **直接把那个框截成图**(等于自动替用户点 📷)。
   *  为什么需要:ebook/PDF 阅读器可能用 canvas、CSS 背景图、或任何我们猜不到的渲染方式;
   *  只要它显示在屏幕上,截图就一定读得到 —— 视觉模型能读图,这条覆盖一切渲染方式。 */
  async function shotFrameRegion(fr) {
    try {
      if (typeof document === 'undefined') return 0;
      const want = new Set((fr.imageOnly || []).map((x) => String(x.url)));
      let target = null;
      for (const f of document.querySelectorAll('iframe,frame')) {
        let cd = null;
        try { cd = f.contentDocument; } catch (e) { cd = null; }
        if (!cd) continue;
        let u = '';
        try { u = (cd.location && cd.location.href) || ''; } catch (e) { u = f.src || ''; }
        if (want.size && !want.has(String(u))) continue;
        const rr = f.getBoundingClientRect();
        if (rr.width >= 300 && rr.height >= 200) { target = f; break; }   // 太小的框多半不是正文,别浪费额度
      }
      if (!target) return 0;
      const needScroll = (() => { const r0 = target.getBoundingClientRect(); return r0.top < 0 || r0.bottom > (window.innerHeight || 0); })();
      const prevY = window.scrollY || 0;
      if (needScroll) {
        try { target.scrollIntoView({ block: 'center' }); } catch (e) { /* 忽略 */ }
        await new Promise((r) => setTimeout(r, 360));
      }
      const r1 = target.getBoundingClientRect();
      // ⚠️ 截的是整个窗口:先把自己的面板/悬浮球收起来,再截,否则正文被自己的面板盖住
      //    (用户实测:自动截图只辨认出零散词句 —— 就是面板挡在正文上)
      const PanelApi = (typeof LFPanel !== 'undefined') ? LFPanel : null;
      const hideUi = !!(PanelApi && PanelApi.setShotUiHidden);
      if (hideUi) { try { PanelApi.setShotUiHidden(true); } catch (e) {} await new Promise((r) => setTimeout(r, 160)); }
      const shot = await Lib.sendMsg({
        type: 'captureTab', format: 'png',
        rect: { x: r1.left, y: r1.top, w: r1.width, h: r1.height }, vw: window.innerWidth || 0, dpr: window.devicePixelRatio || 1,
      }, 15000);
      if (hideUi) { try { PanelApi.setShotUiHidden(false); } catch (e) {} }
      if (needScroll) { try { window.scrollTo(0, prevY); } catch (e) { /* 忽略 */ } }
      if (!shot || !shot.ok || !shot.dataUrl) return 0;
      // 只交"这个框"那块图:整窗截图里正文又小又被门户导航挤,视觉模型读不出来
      // (background 的 captureTab 忽略 rect、裁剪只能在有 DOM 的一侧做 —— 和面板手动 📷 同一条路)
      let outUrl = shot.dataUrl, cropped = false;
      try {
        const cut = await Lib.cropDataUrl(shot.dataUrl, { x: r1.left, y: r1.top, w: r1.width, h: r1.height }, window.innerWidth || 0);
        if (cut && cut.ok && cut.dataUrl) { outUrl = cut.dataUrl; cropped = true; }
      } catch (e) { /* 裁剪失败 → 退回整窗图 */ }
      state.attachments.push({
        kind: 'image', dataUrl: outUrl, auto: true,
        label: cropped ? '内嵌框正文(自动截图)' : '内嵌框正文(自动截屏·整窗,未裁剪)',
      });
      return 1;
    } catch (e) { return 0; }
  }

  /** 内嵌框正文是图片/画布(ebook、PDF 阅读器很常见):把框里的整页图收上来当**图片附件**。
   *  为什么必须自动做:翻译能翻到这些框(翻的就是图上的字),助手却只看到"没有文字" ——
   *  用户的要求是"翻译看得见的,助手也要看得见",所以这里把同一批图交给视觉模型去读。
   *  用户自己带了截图就不加;返回实际收上来的张数。 */
  async function attachFrameImages(st) {
    try {
      if (state.frameImgAttached) return 0;
      // ⚠️ 一次失败不能永久关闭:以前无论抓没抓到图都置 frameImgAttached=true ——
      //    首次因"框还没加载好 / 截图额度被占 / 面板挡住"失败后,整页再也自动带不上图(用户实测的"原先能读、现在读不了")。
      if (state.frameImgTries >= 2) return 0;
      if ((state.attachments || []).some((a) => a && a.dataUrl)) return 0;      // 已有图(用户截图/选择)→ 不重复吃 token
      const fr = (state.reader && state.reader.stats && state.reader.stats.frames) || null;
      if (!fr || !fr.imageOnlyCount) return 0;
      const ioFrames = (fr.imageOnly || []).filter((x) => (x.imgs || 0) > 0);
      state.frameImgTries = (state.frameImgTries || 0) + 1;                      // 真正动手抓图才计数(每次提问最多试 2 次)
      if (!ioFrames.length) {
        // 没有可抓的图/画布 → 直接对那个框截屏(覆盖一切渲染方式)
        const n0 = await shotFrameRegion(fr);
        if (n0) state.frameImgAttached = true;
        state.frameImgNote = n0;
        return n0;
      }
      const max = Math.max(1, Math.min(3, Number(st.imageMaxCount || 4) - (state.attachments || []).length));
      let n = 0;
      // ① 顶层直接抓同源框的整页图/canvas(最可靠,ebook 阅读器走这条)
      const topOnes = topFrameImages(ioFrames.filter((x) => x.fromTop).map((x) => x.url));
      for (const c2 of topOnes) {
        if (n >= max) break;
        let dataUrl = c2.dataUrl || '';
        if (!dataUrl && c2.url) {
          try {
            const fr2 = await Lib.sendMsg({ type: 'fetchImage', url: c2.url }, 8000);   // 后台 fetch:不受页面 CORS 限制
            if (fr2 && fr2.ok && fr2.dataUrl) dataUrl = fr2.dataUrl;
          } catch (e) { /* 忽略 */ }
        }
        if (!dataUrl) continue;
        state.attachments.push({ kind: 'image', dataUrl: dataUrl, label: '内嵌框正文页', auto: true });
        n++;
      }
      // ② 其余(跨域框/子帧自己报的)仍走后台逐帧收集
      const ioUrls = new Set(ioFrames.map((x) => String(x.url || '')));
      const res = await Lib.sendMsg({ type: 'collectFrameImages', max: max }, 8000);
      const all = (res && res.images) || [];
      const imgs = all.filter((im) => im && im.frameUrl && ioUrls.has(String(im.frameUrl)));   // 只认"图片正文框"自己的图
      for (const im of imgs) {
        if (n >= max) break;
        if (!im || !im.dataUrl) continue;
        state.attachments.push({ kind: 'image', dataUrl: im.dataUrl, label: '内嵌框正文(图片/画布渲染)', auto: true });
        n++;
      }
      if (!n) n = await shotFrameRegion(fr);                 // 抓图失败(懒加载/背景图/canvas 污染)→ 退到截屏
      if (n) { state.frameImgAttached = true; }              // 只有真拿到图才算"本页已完成",没拿到留待下次追问时重试
      state.frameImgNote = n;
      return n;
    } catch (e) { return 0; }
  }

  function attach(att) {
    if (!att) return;
    state.attachments.push(att);
    if (att.dataUrl) state.retriedNoImg = false;    // 新图 → 重新允许"去图重试"(否则一次视觉失败后就再也不试)
  }

  function clearAttachments() { state.attachments = []; }

  function reset() {
    state.history = [];
    state.attachments = [];
    state.sentIds = new Set();
    state.persistLoaded = true;                             // 新建对话:不再回灌旧记录
    clearPersisted();
    state.seq++;
    state.lastError = '';
    state.ready = false;
    state.reader = null;
    state.digest = '';
    state.frameImgAttached = false;
    state.frameImgTries = 0;
    state.frameImgNote = 0;
  }

  /** 本轮 user 消息:新片段 + 用户问题 + 文本附件;图片附件以 image_url 分片发送 */
  function buildUserContent(text, fresh, attachments) {
    const parts = [];
    let head = '';
    if (fresh && fresh.length) {
      head += '[本轮相关片段]\n' + fresh.map((c) => '[片段 ' + c.id + (c.heading ? '｜' + c.heading : '') + '] ' + c.text).join('\n') + '\n\n';
    }
    const sel = (attachments || []).filter((a) => a.kind === 'text');
    if (sel.length) head += '[用户选中的页面文本]\n' + sel.map((a) => a.text).join('\n---\n') + '\n\n';
    parts.push({ type: 'text', text: head + text });
    for (const a of (attachments || [])) {
      if (a.dataUrl) parts.push({ type: 'image_url', image_url: { url: a.dataUrl, detail: 'auto' } });
    }
    return parts.length === 1 ? parts[0].text : parts;
  }

  async function ask(text, st) {
    // 早退也要"出声":否则调用方 await 到 {ok:false} 却什么都没显示(用户看到"点了没反应")
    const failEarly = (msg) => {
      state.lastError = msg;
      const cc = state.container;
      if (cc) { try { cc.error(msg); cc.render(state); } catch (e) {} }
      return { ok: false, error: msg };
    };
    if (state.busy) return failEarly('正在回答中,请等待或点停止');
    const q = String(text == null ? '' : text).trim();
    if (!q) return failEarly('请输入问题');
    const c = state.container;
    state.busy = true;

    let usedImages = false;                            // 必须声明在 try 外:try 内早于它的失败会让 catch 抛 ReferenceError
    try {
      await ensureReader(st);
      await attachFrameImages(st);                       // 框内正文是图片/画布 → 自动把整页图带上(视觉模型直接读)
      const mode = MODES[state.mode] || MODES.qa;
      const picked = (typeof LFRag !== 'undefined')
        ? LFRag.pickChunks(state.reader.chunks, q, { k: st.chatTopK || 8, budget: st.chatMaxContext || 12000 })
        : [];
      // 只把"没送过的新片段"补进本轮,避免 token 随轮数膨胀;
      // 但如果检索结果全是送过的(换个角度问同一页),就不能空手 —— 回退送 top2,否则模型没上下文可依。
      let fresh = picked.filter((p) => !state.sentIds.has(p.id));
      if (!fresh.length && picked.length) fresh = picked.slice(0, 2);
      // 内嵌框内容常被检索漏掉(问句与框内文字用词不同)→ 至少带 2 段框内资料,避免模型答"页面里没有提到"
      const fr = (state.reader && state.reader.stats && state.reader.stats.frames) || null;
      if (fr && (fr.included || fr.remote) && !fresh.some((c) => c.frame)) {
        const fromFrames = (state.reader.chunks || []).filter((c) => c.frame && !fresh.some((f) => f.id === c.id)).slice(0, 2);
        if (fromFrames.length) fresh = fresh.concat(fromFrames);
      }
      for (const p of fresh) state.sentIds.add(p.id);

      // 内嵌框清单随资料一起给模型:哪些框并入了文字、哪些没取到 —— 免得它自己去猜我们"只解析主文档"
      const frm = (state.reader && state.reader.stats && state.reader.stats.frames) || null;
      let frameNote = '';
      if (frm && ((frm.total || frm.remote) || frm.silent)) {
        const parts = [];
        if (frm.readUrls && frm.readUrls.length) parts.push('已并入 ' + frm.readUrls.length + ' 个框的文字:' + frm.readUrls.join('、'));
        if (frm.silentUrls && frm.silentUrls.length) parts.push('以下框没有取到文字(可能未解锁/尚未加载/沙箱框):' + frm.silentUrls.join('、'));
        if (frm.imageOnlyCount) {
          const io2 = (frm.imageOnly || []).map((x) => {
            const how = x.kind === 'canvas' ? '画布渲染' : x.kind === 'pdf' ? 'PDF 渲染' : '图片渲染';
            const take = (x.imgs || 0) > 0
              ? (state.frameImgNote ? '(该框内容已作为图片附件提供——整页图或该框区域截图,直接读图作答)' : '(提问时会把该框内容作为图片附件提供:整页图或该框区域截图)')
              : '(取不到图,请提示用户点「📷」框选该区域截图)';
            return x.url + '(' + how + ' ' + (x.imgs || 0) + ' 张)' + take;
          });
          parts.push('以下框的正文不是文字而是图片/画布:' + io2.join('、'));
        }
        if (parts.length) frameNote = '\n\n[内嵌框] ' + parts.join(';');
      }
      const system = SYS_ROLE + '\n\n[页面资料]\n' + state.digest + frameNote
        + '\n\n[本次任务]\n' + mode.prompt
        + (st.systemPromptExtra ? '\n\n[附加要求]\n' + st.systemPromptExtra : '');

      const turns = Math.max(1, st.chatHistoryTurns || 10);
      // 历史:按轮裁剪 + 强制 user/assistant 严格交替。
      // 历史长度可能因失败轮(网络/401/429/中止只压了 user)变奇数,固定偶数切片会以 assistant 开头;
      // 且连续两条 user 会被严格校验的网关(Anthropic 代理/部分 vLLM、OneAPI)直接 400。
      // 历史里**保留**最后一轮带图的内容:截图问完一句后,继续追问不必重新截图(视觉模型看得到)
      const src = state.history.slice(-turns * 2);
      let lastImg = -1;
      // 只在"本次就是因为图片被拒而重试"时关掉历史带图;judge 用一次性开关:
      // 之前用 retriedNoImg 常驻 → 一旦视觉失败过,之后每轮追问都不再带图(问完一句后就再也带不上图)
      if (!state.noHistImgOnce) {
        for (let i = src.length - 1; i >= 0; i--) if (src[i].role === 'user' && src[i].images && src[i].images.length) { lastImg = i; break; }
      }
      let hist = src.map((h, i) => (i === lastImg
        ? { role: 'user', content: [{ type: 'text', text: h.text }].concat(h.images.map((u) => ({ type: 'image_url', image_url: { url: u, detail: 'auto' } }))) }
        : { role: h.role, content: h.text }));
      while (hist.length && hist[0].role !== 'user') hist = hist.slice(1);
      const alt = [];
      for (const m of hist) {
        if (alt.length && alt[alt.length - 1].role === m.role) alt[alt.length - 1] = m;   // 同角色相邻 → 只留最新
        else alt.push(m);
      }
      hist = alt;
      if (hist.length && hist[hist.length - 1].role === 'user') hist = hist.slice(0, -1);  // 末条是 user 会与本次提问重复
      const messages = [{ role: 'system', content: system }]
        .concat(hist)
        .concat([{ role: 'user', content: buildUserContent(q, fresh, state.attachments) }]);

      const turnImgs = (state.attachments || []).filter((a) => a && a.dataUrl).map((a) => a.dataUrl);
      state.history.push({ role: 'user', text: q, images: turnImgs });   // 先入历史:流式期间就能看到自己的提问(带图则记下,供追问)
      if (c) { c.render(state); c.stream(''); }
      let partial = '';
      const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      // 本次调用独立的标记:被 stop()/让位中止 → 属良性,不弹红字;真实失败才弹。
      // 用共享 flag 会跨调用串味:新调用会把上一轮的"用户中止"当成自己的,错误被静默吞掉
      state.abortCallUser = false;
      state.abort = ctrl ? () => { state.abortCallUser = true; try { ctrl.abort(); } catch (e) { /* 忽略 */ } } : null;
      usedImages = state.attachments.some((a) => a && a.dataUrl);            // 清空前记录(清空后 catch 里就查不到了)
      const model = (usedImages && st.visionModel) ? st.visionModel : (st.chatModel || st.model);
      const out = await Lib.chatStream(st.baseUrl, st.apiKey, model, messages, (t) => {
        partial = t;
        state.streamingText = t;
        if (c) c.stream(t);
      }, ctrl ? { signal: ctrl.signal } : {});
      state.streamingText = '';
      const answer = String(out || partial || '');
      state.history.push({ role: 'assistant', text: answer });
      state.attachments = [];
      persist(st);                                          // 开了「按网址保存」就落盘
      state.lastError = '';
      if (c) { c.stream(answer); c.render(state); c.scrollBottom(); }
      return { ok: true, answer, cited: picked.length };
    } catch (e) {
      state.lastError = String((e && (e.message || e.name)) || '请求失败(未返回错误详情)');
      // 带图请求被接口拒(常见:模型不吃图片 / 视觉模型没配) → 去掉图片重试一次,并如实告知
      const hadImg = usedImages;
      if (hadImg && !state.retriedNoImg && /image|image_url|vision|multimodal|模态|图片|unsupported|invalid_content/i.test(state.lastError)) {
        const origErr = state.lastError;                  // 重试仍失败时要能说回真实原因
        state.retriedNoImg = true;
        state.noHistImgOnce = true;                       // 仅本次重试不带历史图(带上必然再被拒)
        let keep = state.attachments;
        try {
          state.attachments = keep.filter((a) => !(a && a.dataUrl));
          // ⚠️ 必须临时放开 busy:ask() 开头会以"正在回答中"早退 → 重试永远发不出去。
          //    以前就是这里被自己挡掉:只发一次请求,还把错误文案换成了"正在回答中"。
          state.busy = false;
          const r2 = await ask(text, st);
          state.noHistImgOnce = false;                    // 一次性开关:成败都要复位,否则之后每轮追问都不再带图
          if (r2 && r2.ok) {
            state.history.push({ role: 'assistant', text: '\n\n> ⚠️ 说明:本次未附带截图 —— 接口拒绝了图片输入(实测该模型不能识别图片,可到设置里把「视觉模型」指向可用的多模态模型)。' });
            state.attachments = keep;
            return r2;
          }
          state.attachments = keep;
          state.lastError = origErr;                      // 重试也没成 → 保留"接口不支持图片"这个真实原因
        } catch (e2) { state.noHistImgOnce = false; state.attachments = keep; state.lastError = origErr; }
      }
      // 只有**用户主动点停止**才算良性中止(保留已生成内容、不弹红字)。
      // 注意:流式看门狗抛的"连接中断"等是**真失败**,以前被这条正则一起吞掉 → 用户看到"点了没反应"。
      if (state.abortCallUser) {
        state.lastError = '';
        if (state.streamingText) state.history.push({ role: 'assistant', text: state.streamingText });
      }
      state.streamingText = '';
      if (c) { c.error(state.lastError); c.render(state); }
      return { ok: false, error: state.lastError };
    } finally {
      state.busy = false;
      if (c) c.render(state);
    }
  }

  const api = {
    // 重读=用户要求重来一次,抓图重试额度也复位
    reread: (st) => { state.frameImgTries = 0; return ensureReader(st, true); },
    MODES, state, mount, setReader, ensureReader, setMode, stop, attach, clearAttachments, reset, ask,
    buildUserContent, chatStoreKey, loadPersisted, persist, clearPersisted };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.LFPanelCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

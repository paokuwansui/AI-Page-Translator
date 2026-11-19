/* lib/common.js —— 跨页面共享工具(content/popup/options/background/panel 共用) */
'use strict';
const Lib = (() => {
  const DEFAULT_BASE = 'https://api.openai.com/v1';
  const storageGet = (keys) => new Promise((r) => chrome.storage.local.get(keys, r));
  /**
   * 调用节流闸门:保证两次调用间隔 ≥minGapMs,且**串行**(并发调用排队,不会同时冲进去)。
   * 用于 chrome.tabs.captureVisibleTab —— 它每秒最多 2 次,超了直接失败(用户"连点几下就失败")。
   * 抽成纯函数便于单测(headless 不强制该额度,e2e 里测不出真问题)。
   */
  function createSpacer(minGapMs, nowFn, sleepFn) {
    const now = nowFn || (() => Date.now());
    const nap = sleepFn || ((ms) => new Promise((r) => setTimeout(r, ms)));
    let last = 0;
    let chain = Promise.resolve();
    return function gate() {
      const run = async () => {
        const gap = minGapMs - (now() - last);
        if (gap > 0) await nap(gap);
        last = now();
      };
      chain = chain.then(run, run);
      return chain;
    };
  }

  /** 打开扩展设置页。两条路都试,避免"点了没反应":
   *  ① 扩展页(侧栏/popup/设置页)里 chrome.runtime.openOptionsPage 可直接用 —— 这是原来一直好用的路径;
   *  ② 内容脚本里没有这个 API → 走后台(tabs.create / 聚焦已开标签)。
   *  只有两条都失败才 reject(附具体原因)。 */
  /** 按选区裁剪截图(Image + canvas)。rect 是 CSS 像素、图是设备像素,用"图宽/视口宽"换算,兼容缩放与 DPR。
   *  ⚠️ 只能跑在有 DOM 的地方(内容脚本/扩展页);MV3 的 service worker 没有 createImageBitmap,别在后台调用。 */
  function cropDataUrl(dataUrl, rect, vw) {
    return new Promise((resolve) => {
      try {
        const img = new Image();
        img.onload = () => {
          try {
            const scale = (img.naturalWidth && vw) ? (img.naturalWidth / vw) : (devicePixelRatio || 1);
            const x = Math.max(0, Math.round(rect.x * scale));
            const y = Math.max(0, Math.round(rect.y * scale));
            const w = Math.max(1, Math.min(img.naturalWidth - x, Math.round(rect.w * scale)));
            const h = Math.max(1, Math.min(img.naturalHeight - y, Math.round(rect.h * scale)));
            const c = document.createElement('canvas');
            c.width = w; c.height = h;
            c.getContext('2d').drawImage(img, x, y, w, h, 0, 0, w, h);
            resolve({ ok: true, dataUrl: c.toDataURL('image/png'), w: w, h: h });
          } catch (e) { resolve({ ok: false, error: String((e && e.message) || e) }); }
        };
        img.onerror = () => resolve({ ok: false, error: '截图解码失败' });
        img.src = dataUrl;
      } catch (e) { resolve({ ok: false, error: String((e && e.message) || e) }); }
    });
  }

  function openOptionsPage() {
    // ⚠️ 侧栏(side panel)里 openOptionsPage 的回调**不会返回** → 必须加超时,否则整条 promise 永挂,
    //    用户看到的就是"点了设置没反应"(侧栏设置按钮会因此打不开)
    const tryDirect = () => new Promise((resolve, reject) => {
      if (typeof chrome === 'undefined' || !chrome.runtime || typeof chrome.runtime.openOptionsPage !== 'function') { reject(new Error('no-direct-api')); return; }
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; reject(new Error('direct-timeout')); } }, 900);
      try {
        chrome.runtime.openOptionsPage(() => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          const e = chrome.runtime.lastError;
          if (e) reject(new Error(e.message)); else resolve({ ok: true, via: 'direct' });
        });
      } catch (e) { if (!done) { done = true; clearTimeout(timer); reject(e); } }
    });
    return tryDirect().catch(() => sendMsg({ type: 'openOptions' }, 6000).then((r) => {
      if (r && r.ok) return { ok: true, via: 'bg' };
      throw new Error((r && r.error) || '扩展没有响应(请刷新页面后重试)');
    }));
  }

  /**
   * 哪些消息必须广播给**所有 frame**、哪些只能给**顶层 frame**。
   * 用错就是回归:把所有消息都加 frameId:0,iframe 里的页面就完全不翻译。
   *  - 广播:实际动页面内容的(每帧各自翻自己那份,子帧收到后 return false 关掉自己的通道,不抢响应)
   *  - 顶层:UI/面板类(面板只建在顶层;若子帧也应答,tabs.sendMessage"先到先得"会拿到错数据)
   */
  const ALL_FRAMES_MSGS = new Set(['translate', 'retryFailed', 'translateImages', 'resetImages', 'restore', 'stop']);
  function frameOptsFor(type) { return ALL_FRAMES_MSGS.has(String(type)) ? {} : { frameId: 0 }; }

  /**
   * 把「给标签页发消息」失败时的底层报错翻译成用户能照做的提示。
   * 两种原因完全不同,必须分开说:
   *  - 无接收端(Receiving end does not exist)= 页面根本没注入脚本:受保护页面(chrome://、
   *    扩展商店、PDF 阅读器、新标签页)、本地 file://(需在扩展详情里开「允许访问文件网址」)、
   *    或该标签页在扩展加载前就打开了 → 换普通网页 / 开文件访问 / 刷新页面。
   *  - 端口关闭(message port closed)= 脚本在,但没回话(扩展更新过、脚本失效/崩溃)→ 刷新页面。
   */
  function friendlyTabError(msg, tabUrl) {
    const m = String(msg || '');
    const where = tabUrl ? '(' + String(tabUrl).slice(0, 80) + ')' : '';
    if (/Receiving end does not exist|could not establish connection/i.test(m)) {
      const isFile = /^file:/i.test(tabUrl || '');
      const isChrome = /^(chrome|edge|about|devtools|view-source):/i.test(tabUrl || '');
      let why = '这个页面没有注入脚本';
      if (isFile) why += ':本地文件需要在扩展详情里打开「允许访问文件网址」';
      else if (isChrome) why += ':浏览器内置页面无法注入';
      else why += ':受保护页面(扩展商店、PDF 阅读器、新标签页),或该标签页在扩展加载前就打开了';
      return why + '。' + (isChrome ? '请换一个普通网页' : '请刷新页面(F5)后重试') + where;
    }
    if (/message port closed before a response/i.test(m)) {
      return '页面脚本没有响应(扩展刚更新过或脚本已失效)。请刷新页面(F5)后重试' + where;
    }
    return (m || '未知错误') + where;
  }

  const storageSet = (obj) => new Promise((r) => chrome.storage.local.set(obj, r));
  /** 和后台通信:必须保证「一定会 resolve」——扩展被重载/后台无响应时 sendMessage 会抛错或永不回调,
   *  调用方若 await 就会永久挂住(例如截图后面板再也回不来)。这里加 try/catch + 静音 lastError + 兜底超时。 */
  const sendMsg = (msg, timeoutMs = 90000) => new Promise((resolve) => {
    let done = false, timer = null;
    const fin = (v) => {
      if (done) return;
      done = true;
      if (timer) { clearTimeout(timer); timer = null; }   // 成功路径别留悬挂定时器(分块翻译时会有成百上千条)
      resolve(v);
    };
    try {
      chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; fin(r); });
    } catch (e) { fin({ ok: false, error: String((e && e.message) || e) }); return; }
    if (timeoutMs > 0) timer = setTimeout(() => fin({ ok: false, error: '后台无响应(超时)' }), timeoutMs);
  });
  const normBase = (base) => { const b = (base || '').trim().replace(/\/+$/, ''); return b || DEFAULT_BASE; };

  const defaultSettings = {
    baseUrl: DEFAULT_BASE, apiKey: '', model: 'gpt-4o-mini',
    sourceLang: 'auto', targetLang: 'zh-CN',

    // 吞吐:批聚合 + 高并发 + 令牌桶限速(参考 kiss batchQueue / 沉浸式 rateLimit)
    chunkSize: 1500, concurrency: 12,
    rateLimit: 8, rateInterval: 1200,
    batchInterval: 400, batchSize: 20, batchLength: 8000,

    // 覆盖范围
    translateOnLoad: false, translateDynamic: true, translateShadow: true,
    translateAttrs: true, translateHead: true, splitLongText: true, splitMax: 600,
    viewportFirst: true, deferIdle: 3500, translateHidden: true, repeatPattern: true,

    // 缓存与术语
    useCache: true, cacheMax: 2000, termPreAnalyze: true,

    // 润色(保留全页统一润色;流水线=与快翻重叠执行)
    polishEnabled: true, polishPipelined: true, polishChunkSize: 3000,
    polishBatchBlocks: 8, polishWindow: 6, polishAvoidReading: true,
    retryWholeChunk: true,

    // 对话面板(Phase 4)
    chatEnabled: true, chatModel: '', visionModel: '',
    chatMaxContext: 12000, chatTopK: 8, chatHistoryTurns: 10,
    imageMaxCount: 4,
    panelMode: 'auto', chatPersist: false, renderMarkdown: true, systemPromptExtra: '',
    panelSide: 'right', panelW: 420, panelH: 560,        // 面板停靠位置与尺寸(可拖拽改,持久化)

    // 图片翻译(Phase 3)
    imageTranslateEnabled: true,
    imageAutoTranslate: false, imageMaxPerPage: 8, imageMinSize: 100,
    imageMaxDimOcr: 1568, imagePaintMode: 'auto',
    bgScanMax: 5000,                     // 背景图扫描元素上限(超大页面可调大)
    imageDedupeSameSrc: true,            // 同一张图多处出现:默认只翻第一处(用户指定;设置里可切回"每处都翻")
  };

  /** 流式对话(SSE):background 经 port 持续推送 partial,返回完整文本
   *  翻译与面板对话共用这一份实现 */
  function chatStream(baseUrl, apiKey, model, messages, onPartial, opts = {}) {
    return new Promise((resolve, reject) => {
      let settled = false, port = null, watchdog = null, onAbort = null;
      const cleanup = () => {
        if (watchdog) { clearTimeout(watchdog); watchdog = null; }
        if (onAbort && opts.signal) { try { opts.signal.removeEventListener('abort', onAbort); } catch (e) {} }
        onAbort = null;
      };
      const finish = (fn, v) => {
        if (settled) return;
        settled = true;
        cleanup();
        try { if (port) port.disconnect(); } catch (e) {}
        fn(v);
      };
      // 停顿看门狗:后台 service worker 被回收 / 上游长时间无数据时,不能永久卡在"翻译中"
      const arm = (ms) => {
        if (watchdog) clearTimeout(watchdog);
        watchdog = setTimeout(() => finish(reject, new Error('流式响应超时(长时间无数据)')), ms);
      };
      try { port = chrome.runtime.connect({ name: 'chatStream' }); } catch (e) { reject(e); return; }
      port.onMessage.addListener((m) => {
        if (!m) return;
        if (m.type === 'partial') { arm(opts.idleTimeoutMs || 120000); try { onPartial && onPartial(m.text); } catch (e) { /* ignore */ } }
        else if (m.type === 'done') finish(resolve, m.text);
        else if (m.type === 'error') finish(reject, new Error(m.error || '流式请求失败'));
      });
      port.onDisconnect.addListener(() => { if (!settled) finish(reject, new Error('连接中断')); });
      if (opts.signal) {
        onAbort = () => finish(reject, new Error('aborted'));
        try { opts.signal.addEventListener('abort', onAbort, { once: true }); } catch (e) {}
      }
      arm(opts.timeoutMs || 300000);            // 首字节等待上限 5 分钟,之后每次 partial 重置为 2 分钟
      try { port.postMessage({ type: 'chat', baseUrl, apiKey, model, messages, maxTokens: opts.maxTokens }); } catch (e) { finish(reject, e); }
    });
  }

  /** 只取「已知设置键」:storage 里还有缓存等大对象(lfCacheV1),不能整包并入设置 */
  const loadSettings = async () => {
    const raw = (await storageGet(null)) || {};
    const out = Object.assign({}, defaultSettings);
    for (const k of Object.keys(defaultSettings)) if (k in raw) out[k] = raw[k];
    return out;
  };
  /** 构建号(打包时 build.sh 写进 manifest.version_name;开发目录则为 dev),设置页用来显示版本。 */
  function buildTag() {
    try {
      const mf = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest) ? chrome.runtime.getManifest() : null;
      return (mf && (mf.version_name || mf.version)) || 'dev';
    } catch (e) { return 'dev'; }
  }

  return { DEFAULT_BASE, buildTag, ALL_FRAMES_MSGS, frameOptsFor, createSpacer, openOptionsPage, cropDataUrl, friendlyTabError, storageGet, storageSet, sendMsg, normBase, defaultSettings, loadSettings, chatStream };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Lib;
else globalThis.Lib = Lib;

/* img/collect.js —— 网页图片来源收集与过滤
 * 覆盖 <img>、<picture><source>、CSS background-image;
 * 过滤:占位图/极小图/视口外(可选)/重复 src;上限由调用方成本闸门控制。
 */
'use strict';
(function (global) {
  const SKIP_SRC = /^data:image\/(gif|svg)/i;

  function rectOf(el) {
    try { return el.getBoundingClientRect(); } catch (e) { return null; }
  }

  /** 从 CSS background-image 里取第一个 url() */
  function bgUrl(el) {
    let bg = '';
    try { bg = getComputedStyle(el).backgroundImage || ''; } catch (e) { return ''; }
    if (!bg || bg === 'none') return '';
    const m = /url\((["']?)([^"')]+)\1\)/.exec(bg);
    return m ? m[2] : '';
  }

  /**
   * 收集候选图片。
   * opts: { viewportOnly=true, minW=100, minH=100, max=40, background=true }
   */
  function collect(opts = {}) {
    const minW = opts.minW || 100;
    const minH = opts.minH || 100;
    const max = opts.max || 40;
    const viewportOnly = opts.viewportOnly !== false;
    // 同 src 多处:默认每处都翻译(OCR 结果按图片摘要缓存,重复处零额外模型成本);
    // 只想翻第一处的话把 dedupeSameSrc 打开。
    const dedupeSameSrc = opts.dedupeSameSrc === true;
    const out = [];
    const seen = new Set();

    const push = (el, src, kind) => {
      if (!src || SKIP_SRC.test(src)) return;
      if (dedupeSameSrc && seen.has(src)) return;
      if (out.length >= max) return;
      const r = rectOf(el);
      if (!r) return;
      if (viewportOnly && (r.bottom < -200 || r.top > innerHeight + 400)) return;
      // 图片本身很小(图标/头像)不值得 OCR;背景图按元素尺寸判定
      const nat = el.tagName === 'IMG' ? { w: el.naturalWidth, h: el.naturalHeight } : { w: r.width, h: r.height };
      if (r.width < 40 || r.height < 40) return;
      // 未解码完(naturalWidth=0:loading=lazy 占位 / 视口外被 Chrome 延迟解码)的 <img>:
      // 第一次见到它不能收(拉回来是空白图,白花一次视觉请求);但如果**同一张图已经有另一处被收录**,
      // 这一处只是同一张图的另一个显示位(OCR 结果直接复用,渲染只依赖元素尺寸) → 必须收下。
      // (用户报"同图只翻第一处",根因就是这行把第二处直接丢掉了)
      const twin = kind === 'img' && seen.has(src);
      if (kind === 'img' && (!nat.w || !nat.h) && !twin) return;
      if (kind === 'img' && nat.w && nat.h && nat.w < minW && nat.h < minH) return;
      seen.add(src);
      out.push({ el, src, kind, w: Math.round(r.width), h: Math.round(r.height), nw: nat.w || 0, nh: nat.h || 0 });
    };

    try {
      for (const img of document.querySelectorAll('img')) {
        const src = img.currentSrc || img.src;
        if (!src) continue;
        if (img.closest && img.closest('#lf-panel-host,#lf-img-layer')) continue;
        push(img, src, 'img');
      }
    } catch (e) { /* 忽略 */ }

    if (opts.background !== false) {
      try {
        // 只看「直接含文字的叶子容器」之外的元素,并限制扫描量:
        // 这里刻意不用 textContent(子树遍历会让大页面 O(n²)),只检查直接子文本节点;
        // 用 TreeWalker 而不是 querySelectorAll('*')(后者会把整页元素先物化成数组,大页面很慢)
        const scanMax = opts.scanMax || 5000;                 // 可配(超大页面靠后的背景图需要更大值)
        let scanned = 0;
        const walker = document.createTreeWalker(document.body, 1, null);
        let el = walker.nextNode();
        for (; el; el = walker.nextNode()) {
          if (++scanned > scanMax) break;                     // 大页面保护
          if (el.children.length > 3) continue;
          let hasDirectText = false;
          for (const c of el.childNodes) {
            if (c.nodeType === 3 && c.nodeValue && c.nodeValue.trim()) { hasDirectText = true; break; }
          }
          if (hasDirectText) continue;
          const u = bgUrl(el);
          if (u) push(el, u, 'bg');
        }
      } catch (e) { /* 忽略 */ }
    }

    return out;
  }

  const api = { collect, bgUrl, SKIP_SRC };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.LFImgCollect = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

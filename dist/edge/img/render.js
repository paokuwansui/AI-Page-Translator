/* img/render.js —— 图片译文覆盖层
 *
 * 做法(参考沉浸式图片翻译的渲染阶段,但用环带取色替代本地 inpainting 模型):
 *   - 每张图一个绝对定位容器,坐标随图片 rect 用 rAF 同步(滚动/缩放不跑位)
 *   - 译文盒按归一化坐标换算,字号按盒高自适应
 *   - 纯色底图片:用文本盒外圈环带像素的「中位数色」填充擦掉原文(近似 inpainting)
 *   - 照片/渐变底:自动退化为半透明覆盖,避免糊图(可用 imagePaintMode 强制)
 */
'use strict';
(function (global) {
  const LAYER_ID = 'lf-img-layer';
  const MAX_FONT = 44, MIN_FONT = 11;
  const byEl = new WeakMap();     // el -> handle(查表用弱引用,不给元素"续命")
  const live = new Set();         // 活跃句柄(可枚举、可清理)
  let layer = null, layerRoot = null;
  let rafPending = false, globalsAttached = false, cleanupTimer = null;

  /* 所有图共用一个 rAF 调度与一组 scroll/resize 监听:
     否则 N 张图就是 N 组监听 × 每次滚动 N 次 rAF(长页面明显掉帧) */
  function schedulePaint() {
    if (rafPending) return;
    rafPending = true;
    const raf = (typeof requestAnimationFrame === 'function') ? requestAnimationFrame : (fn) => setTimeout(fn, 16);
    raf(() => {
      rafPending = false;
      for (const h of [...live]) {
        if (!h || h.dead) { live.delete(h); continue; }
        if (!h.el.isConnected) { h.destroy(); continue; }   // SPA 把图片删了 → 我们跟着收摊
        h.paint();
      }
      if (!live.size) detachGlobals();
    });
  }

  function prune() {                                       // 兜底:定期清掉已脱离文档的句柄
    for (const h of [...live]) if (!h || h.dead || !h.el.isConnected) h.destroy();
    if (!live.size) detachGlobals();
  }

  function attachGlobals() {
    if (globalsAttached) return;
    globalsAttached = true;
    try { addEventListener('scroll', schedulePaint, { passive: true, capture: true }); } catch (e) {}
    try { addEventListener('resize', schedulePaint); } catch (e) {}
    try { cleanupTimer = setInterval(prune, 30000); } catch (e) { cleanupTimer = null; }
  }

  function detachGlobals() {
    if (!globalsAttached) return;
    globalsAttached = false;
    try { removeEventListener('scroll', schedulePaint, true); } catch (e) {}
    try { removeEventListener('resize', schedulePaint); } catch (e) {}
    if (cleanupTimer) { clearInterval(cleanupTimer); cleanupTimer = null; }
  }

  /* 覆盖层放在 Shadow DOM 里:页面 CSS(!important)也改不到我们的盒子 */
  const CSS = `
    .lf-imgbox { position: absolute; pointer-events: none; overflow: hidden; }
    .lf-imgit {
      position: absolute; box-sizing: border-box; display: flex; align-items: center; justify-content: center;
      text-align: center; overflow: hidden; padding: 0 2px; border-radius: 3px;
      color: #111; background: rgba(255,255,255,.86); line-height: 1.15; font-weight: 500;
      font-family: system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
      pointer-events: auto; user-select: text; cursor: text;
      text-shadow: 0 1px 0 rgba(255,255,255,.5);
    }
    /* 覆盖模式:盒子自身是半透明白底 → 文字必须与之相反(黑字)。
       不能写死 color:#fff:白底页面会变成白底白字(不可见)。 */
    .lf-imgit[data-cover="1"] { color: #111827; background: rgba(255,255,255,.9); text-shadow: 0 1px 0 rgba(255,255,255,.7); }
  `;

  function ensureLayer() {
    if (layer && layerRoot && document.documentElement.contains(layer)) return layerRoot;
    layer = document.createElement('div');
    layer.id = LAYER_ID;
    layer.setAttribute('translate', 'no');
    layer.className = 'notranslate';
    layer.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;pointer-events:none;z-index:2147483600;';
    layerRoot = layer.attachShadow({ mode: 'open' });
    const st = document.createElement('style');
    st.textContent = CSS;
    layerRoot.appendChild(st);
    document.documentElement.appendChild(layer);
    return layerRoot;
  }

  /** 环带取色:文本盒外扩 pad 像素的像素中位数 + 标准差(判定是否纯色底) */
  async function ringColors(dataUrl, items, pad = 6) {
    const out = items.map(() => null);
    let bmp = null;
    try {
      const blob = await (await fetch(dataUrl)).blob();
      bmp = await createImageBitmap(blob);
      // 只为了取几圈色带:把采样画布限制在长边 600px,避免为 1568² 的图分配 ~10MB RGBA
      const sw = Math.min(1, 600 / Math.max(bmp.width, bmp.height));
      const W = Math.max(1, Math.round(bmp.width * sw));
      const H = Math.max(1, Math.round(bmp.height * sw));
      const cv = new OffscreenCanvas(W, H);
      const ctx = cv.getContext('2d');
      ctx.drawImage(bmp, 0, 0, W, H);
      const img = ctx.getImageData(0, 0, W, H).data;
      const at = (x, y) => {
        const i = ((y * W) + x) * 4;
        return [img[i], img[i + 1], img[i + 2]];
      };
      items.forEach((it, k) => {
        const x0 = Math.max(0, Math.floor(it.box[0] * W) - pad);
        const y0 = Math.max(0, Math.floor(it.box[1] * H) - pad);
        const x1 = Math.min(W - 1, Math.ceil(it.box[2] * W) + pad);
        const y1 = Math.min(H - 1, Math.ceil(it.box[3] * H) + pad);
        if (x1 <= x0 || y1 <= y0) return;
        const rs = [], gs = [], bs = [], step = 3;
        for (let y = y0; y <= y1; y += step) {
          for (let x = x0; x <= x1; x += step) {
            // 只取环带(盒子内部不采样,避免把文字像素算进去)
            const inside = x > x0 + pad && x < x1 - pad && y > y0 + pad && y < y1 - pad;
            if (inside) continue;
            const [r, g, b] = at(x, y);
            rs.push(r); gs.push(g); bs.push(b);
          }
        }
        if (!rs.length) return;
        const med = (a) => { a.sort((p, q) => p - q); return a[a.length >> 1]; };
        const mean = (a) => a.reduce((p, q) => p + q, 0) / a.length;
        const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((p, q) => p + (q - m) * (q - m), 0) / a.length); };
        out[k] = {
          color: 'rgb(' + med(rs) + ',' + med(gs) + ',' + med(bs) + ')',
          variance: (sd(rs) + sd(gs) + sd(bs)) / 3,
        };
      });
    } catch (e) {
      /* 取色失败 → 全部退化为覆盖模式 */
    } finally {
      try { bmp && bmp.close && bmp.close(); } catch (e) {}
    }
    return out;
  }

  /**
   * 渲染一张图的译文。
   * target: {el, w, h} result: {items:[{box,text,translation}]}
   * opts: { paintMode:'auto'|'fill'|'cover', fills:[{color,variance}] }
   */
  function render(target, result, opts = {}) {
    if (!target || !target.el) return null;
    // 先清旧的:否则「上一次有译文、这一次模型没识别出文字」时,旧译文盒会赖在页面上
    resetImage(target.el);
    if (!result || !result.items || !result.items.length) return null;
    const host = document.createElement('div');
    host.className = 'lf-imgbox';
    host.setAttribute('translate', 'no');
    const mode = opts.paintMode || 'auto';
    result.items.forEach((it, i) => {
      const d = document.createElement('div');
      d.className = 'lf-imgit';
      d.setAttribute('data-lf-idx', String(i));
      d.textContent = it.translation;
      d.title = it.text || '';
      d.setAttribute('translate', 'no');
      const f = opts.fills && opts.fills[i];
      if (f) {
        const solid = f.variance != null && f.variance < 18;
        const useFill = mode === 'fill' || (mode === 'auto' && solid);
        if (useFill) {
          d.style.background = f.color;
          // 底色处理:按填充色亮度定文字色(否则深色底上黑字=看不见),并加描边提升可读性
          const eng = global.LFImgEngine || global.ImgEngine;                  // 模块全局名是 LFImgEngine(约定)
          const tc = (eng && eng.textColorFor)
            ? eng.textColorFor(f.color)
            : { color: '#111', shadow: '0 1px 0 rgba(255,255,255,.45)' };
          d.style.color = tc.color;
          d.style.textShadow = tc.shadow;
          d.setAttribute('data-fill', '1');
        } else {
          // 覆盖模式:不铺采样色,用自带半透明白底 + 黑字(CSS 里定),保证与底色相反、始终看得见
          d.setAttribute('data-cover', '1');
        }
      }
      host.appendChild(d);
    });
    ensureLayer().appendChild(host);

    const paint = () => {
      const r = target.el.getBoundingClientRect();
      if (!r || r.width < 20 || r.height < 20 || r.bottom < -300 || r.top > innerHeight + 400) {
        host.style.display = 'none';
        return;
      }
      host.style.display = 'block';
      host.style.left = r.left + 'px';
      host.style.top = r.top + 'px';
      host.style.width = r.width + 'px';
      host.style.height = r.height + 'px';
      const nodes = host.children;
      for (let i = 0; i < nodes.length && i < result.items.length; i++) {
        // 双保险:旧缓存里可能存着未归一化的框(模型给过像素坐标)→ 这里裁进 0..1,避免盖住整页
        const raw = result.items[i].box || [0, 0, 0, 0];
        const px = raw.map((n) => (Number.isFinite(n) ? (n > 1.02 ? 1 : Math.max(0, n)) : 0));
        const b = [Math.min(px[0], px[2]), Math.min(px[1], px[3]), Math.max(px[0], px[2]), Math.max(px[1], px[3])];
        const n = nodes[i];
        const h = Math.max(6, (b[3] - b[1]) * r.height);
        n.style.left = (b[0] * r.width) + 'px';
        n.style.top = (b[1] * r.height) + 'px';
        n.style.width = ((b[2] - b[0]) * r.width) + 'px';
        n.style.height = h + 'px';
        // 填充模式下四周外扩 1.5px:OCR 框通常贴字很紧,外扩可盖住原文字形边缘(底色处理)
        const grow = (n.getAttribute('data-fill') === '1') ? 1.5 : 0;
        n.style.marginLeft = (-grow) + 'px';
        n.style.marginTop = (-grow) + 'px';
        n.style.paddingLeft = grow + 'px';
        n.style.paddingRight = grow + 'px';
        n.style.width = ((b[2] - b[0]) * r.width + grow * 2) + 'px';
        n.style.height = (h + grow * 2) + 'px';
        // 字号:按框高尽量给大(用户反馈原 0.62 倍太小),再按"能否放下"微缩,避免被 overflow 裁掉
        let fs = Math.max(MIN_FONT, Math.min(h * 0.78, MAX_FONT));
        n.style.fontSize = fs + 'px';
        if (n.getAttribute('data-lf-fs') !== String(fs)) {          // 只在字号变化时测量(避免每次滚动都强制重排)
          n.setAttribute('data-lf-fs', String(fs));
          const cw = n.clientWidth || 0, ch = n.clientHeight || 0;
          if (cw > 2 && ch > 2) {
            const k = Math.max(n.scrollWidth / cw, n.scrollHeight / ch);
            if (k > 1.02) {
              fs = Math.max(MIN_FONT, Math.floor(fs / k * 0.97));
              n.style.fontSize = fs + 'px';
            }
          }
        }
      }
    };

    let ro = null;
    try { ro = new ResizeObserver(schedulePaint); ro.observe(target.el); } catch (e) {}
    attachGlobals();
    paint();

    const handle = {
      el: target.el,
      host,
      paint,
      dead: false,
      destroy() {
        if (handle.dead) return;
        handle.dead = true;
        try { ro && ro.disconnect(); } catch (e) {}
        try { host.remove(); } catch (e) {}
        live.delete(handle);
        byEl.delete(target.el);
        if (!live.size) detachGlobals();
      },
    };
    const prev = byEl.get(target.el);
    if (prev) prev.destroy();
    byEl.set(target.el, handle);
    live.add(handle);
    return handle;
  }

  function resetImage(el) {
    const h = byEl.get(el);
    if (h) { h.destroy(); return true; }
    return false;
  }

  function resetAll() {
    for (const h of [...live]) h.destroy();
    live.clear();
    detachGlobals();
    if (layer) { try { layer.remove(); } catch (e) {} layer = null; layerRoot = null; }
  }

  // 注意:对外只暴露 live(Set,可枚举清理);不要再造 Map 形态的 handles 别名,避免 API 形态不一致
  const api = { LAYER_ID, ensureLayer, ringColors, render, resetImage, resetAll, live, root: () => layerRoot };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.LFImgRender = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

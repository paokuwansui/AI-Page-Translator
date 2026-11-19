/* img/engine.js —— 图片文字识别 + 翻译(视觉模型引擎)
 *
 * 决策 3A:只做视觉模型;模型不支持图片输入 → 整页跳过图片翻译并给出明确提示,
 * 而不是每张图都发一次失败请求。三层能力探测:
 *   ① 模型名特征(免费、覆盖大多数情况)
 *   ② /models 接口的模型清单(未知时不否决)
 *   ③ 首次真实请求失败即「学到」结论并缓存
 */
'use strict';
(function (global) {
  const NO_VISION_HINT = '当前模型不能识别图片(接口已明确拒绝),已跳过图片翻译。请在设置里把「视觉模型」指向你实际可用的多模态模型(留空则用主模型)。';
  /** ⚠️ 只用于"猜一下是否多模态"(界面提示/排序),**不得**用来否决用户配置 —— 模型更新快,名单必然过时 */
  const VISION_HINTS = /(4o|4\.1|4\.5|gpt-5|o[34]|vision|vlm|vl\d|[-_]vl\b|gemini|claude-(3|4|opus|sonnet|haiku)|qwen.*vl|glm-4v|internvl|llava|moondream|pixtral|grok.*vision|step-1v|yi-vision|minicpm-v|cogvlm|llama-?[34]|deepseek-vl)/i;

  const OCR_PROMPT = (targetLang) =>
    '你是 OCR + 翻译引擎。识别图中所有可见文字,并翻译为 ' + targetLang + '。\n' +
    '输出严格 JSON(不要解释、不要代码围栏):\n' +
    '{"items":[{"box":[x0,y0,x1,y1],"text":"原文","translation":"译文"}],"lang":"检测到的源语言"}\n' +
    '规则:box 用相对图片的归一化坐标(0~1,左上为原点,依次为左/上/右/下);逐行输出,不要合并不同行的文字;\n' +
    'logo/装饰性文字也要输出;无法识别的位置不要编造;translation 只填译文本身,不要加标点以外的东西。';

  const SYS = { role: 'system', content: 'You are an OCR and translation engine. Output JSON only.' };

  /** 测试图:64×64 的**有效** PNG(浅灰底 + 中央深色方块),用于"测试能否识别图片"。
   *  ⚠️ 曾用过手写的 1×1 base64,IDAT 校验不过 → 接口回 "unsupported image" → 被误判成"模型不吃图"。
   *  单元测试会对这份 base64 做解码 + CRC 校验,防止再退化。 */
  const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAXElEQVR42u3XMQ0AIAwAwVpgw0H9iyIMmEADU1NyyRu48WPt07oAAAAAAAAAAAAAAAAAAAAAACgFjJlPAQAAAAAAAAAAAAD8A3BkAAAAAAAAAAAAAAAAAAAAAK265S4LaMb3KmYAAAAASUVORK5CYII=';

  /**
   * 真·视觉能力探测:不带任何"已知模型名单",直接拿一张图问模型一嘴(用户明确要求的方式)。
   * 只看**请求有没有被接受**:被接受 = 能吃图片(回复内容不重要);被接口以"不支持图片"拒绝 = 不能吃。
   * 返回 { ok, verdict: 'vision'|'no-vision'|'error', detail }
   */
  async function probeVision(opts) {
    const { baseUrl, apiKey, model, stream } = opts || {};
    if (!model) return { ok: false, verdict: 'error', detail: '未指定模型' };
    if (typeof stream !== 'function') return { ok: false, verdict: 'error', detail: '未提供请求通道' };
    let got = '';
    try {
      await stream(baseUrl, apiKey, model, [{
        role: 'user',
        content: [
          { type: 'text', text: '这是一张图片。只回复两个字:收到' },
          { type: 'image_url', image_url: { url: TINY_PNG } },
        ],
      }], (d) => { got += String(d || ''); }, { maxTokens: 16 });
      return { ok: true, verdict: 'vision', detail: '接口接受了图片输入(模型回复:' + got.slice(0, 24) + ')' };
    } catch (e) {
      const msg = String((e && e.message) || e).slice(0, 180);
      if (isUnsupportedError(e)) return { ok: false, verdict: 'no-vision', detail: '接口明确拒绝图片:' + msg };
      if (/format|valid|decod|格式/.test(msg.toLowerCase())) {
        return { ok: false, verdict: 'error', detail: '探测图被接口判为无效/格式不识别 —— 这是探测图的问题,不代表模型不能识别图片:' + msg };
      }
      return { ok: false, verdict: 'error', detail: '未能确认(可能是网络/权限/额度问题):' + msg };
    }
  }

  /** 解析 #rgb/#rrggbb/rgb()/rgba() → [r,g,b]|null */
  function parseColor(c) {
    const s = String(c || '').trim();
    let m = /^#([0-9a-f]{3})$/i.exec(s);
    if (m) return [parseInt(m[1][0] + m[1][0], 16), parseInt(m[1][1] + m[1][1], 16), parseInt(m[1][2] + m[1][2], 16)];
    m = /^#([0-9a-f]{6})$/i.exec(s);
    if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)];
    m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(s);
    if (m) return [Math.round(+m[1]), Math.round(+m[2]), Math.round(+m[3])];
    return null;
  }

  /**
   * 底色处理:按填充色亮度决定文字色 + 描边,保证"深底不压黑字、浅底不压白字"。
   * 返回 {color, shadow, light} —— 取色失败时回退到深色文字(和默认浅底一致)。
   */
  function textColorFor(bg) {
    const rgb = parseColor(bg);
    if (!rgb) return { color: '#111', shadow: '0 1px 0 rgba(255,255,255,.45)', light: false };
    const lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;   // 相对亮度(够用)
    if (lum > 0.62) return { color: '#111827', shadow: '0 1px 0 rgba(255,255,255,.45)', light: false };
    if (lum > 0.42) return { color: '#1f2937', shadow: '0 1px 1px rgba(0,0,0,.35)', light: false };
    return { color: '#f8fafc', shadow: '0 1px 2px rgba(0,0,0,.65)', light: true };
  }

  function looksVisionCapable(model) { return VISION_HINTS.test(String(model || '')); }

  function isUnsupportedError(e) {
    // 先看 HTTP 状态:429/5xx 是瞬时故障,绝不能被判成「模型不支持图片」 ——
    // 那个结论会被记住,导致该模型+端点的图片翻译被关掉(旧版还会持久化,重开页面都恢复不了)。
    const st = e && (e.status != null ? Number(e.status) : NaN);
    if (st === 429 || (st >= 500 && st < 600)) return false;
    const m = String((e && e.message) || e).toLowerCase();
    if (/\b429\b|\b5\d\d\b/.test(m)) return false;                  // 限流/服务端错误 ≠ 不支持图片
    // ⚠️ 先排除"图片本身有问题"(格式/解码/有效性)—— 这类接口也常回 "unsupported image",
    //    但那是**我们发的图**的问题,判成"模型不吃图"会冤枉模型
    if (/one of the following formats|unsupported (image|format|media)|invalid image|image is (not )?valid|could not (be )?decod|failed to (decode|load).*image|格式|损坏|not a valid/.test(m)) return false;
    // 明确的"模型不具备视觉能力"表述
    if (/does not support image|not support(ing)? (image|vision|multimodal)|image input is not supported|vision is not supported|no vision|not a multimodal|text[- ]only model|不支持(图片|图像|视觉)/.test(m)) return true;
    return /image|vision|multimodal|content.*type|unsupported|invalid.*content|不支持/.test(m);
  }

  function parseLooseJSON(raw) {
    if (typeof raw !== 'string') return null;
    let s = raw.trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) s = fence[1].trim();
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
  }

  /** 降采样:长边 ≤maxDim,JPEG 0.85;体积已足够小则原样返回 */
  async function downscale(dataUrl, maxDim = 1568) {
    try {
      const blob = await (await fetch(dataUrl)).blob();
      const bmp = await createImageBitmap(blob);
      const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
      if (scale === 1 && blob.size < 900 * 1024) { try { bmp.close && bmp.close(); } catch (e) {} return dataUrl; }
      const w = Math.max(1, Math.round(bmp.width * scale));
      const h = Math.max(1, Math.round(bmp.height * scale));
      const cv = new OffscreenCanvas(w, h);
      cv.getContext('2d').drawImage(bmp, 0, 0, w, h);
      try { bmp.close && bmp.close(); } catch (e) {}
      // 截图/透明底用 JPEG 会变黑底 + 压缩伪影 → 按来源 mime 选格式(PNG 过大再退回 JPEG)
      const isPng = /^data:image\/png/i.test(dataUrl) || /image\/png/.test(blob.type || '');
      let out = null;
      if (isPng) {
        try { out = await cv.convertToBlob({ type: 'image/png' }); } catch (e) { out = null; }
        if (out && out.size > 1500 * 1024) out = null;
      }
      if (!out) out = await cv.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
      const res = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(out); });
      return res;
    } catch (e) { return dataUrl; }                                  // 降采样失败 → 原图(≤4MB 闸门已在上游)
  }

  /** 把模型的文字框统一到 0..1 并裁进图内:
   *  - 有的模型直接回像素坐标 → 用「最大坐标」近似图片尺寸后归一化(否则覆盖层会撑出图外盖住整页)
   *  - 越界坐标一律裁剪;退化框(点/细线)直接丢弃 */
  function normalizeBoxes(items, logicalW, logicalH) {
    const list = (items || []).filter((it) => it && Array.isArray(it.box) && it.box.length === 4
      && it.box.every((n) => Number.isFinite(n)));
    if (!list.length) return [];
    let maxX = 0, maxY = 0;
    for (const it of list) { maxX = Math.max(maxX, it.box[2]); maxY = Math.max(maxY, it.box[3]); }
    const pixelish = maxX > 1.02 || maxY > 1.02;
    const W = pixelish ? Math.max(1, logicalW || maxX) : 1;
    const H = pixelish ? Math.max(1, logicalH || maxY) : 1;
    const out = [];
    for (const it of list) {
      let [x0, y0, x1, y1] = it.box;
      if (pixelish) { x0 /= W; x1 /= W; y0 /= H; y1 /= H; }
      if (x1 < x0) { const t = x0; x0 = x1; x1 = t; }
      if (y1 < y0) { const t = y0; y0 = y1; y1 = t; }
      x0 = Math.min(1, Math.max(0, x0)); x1 = Math.min(1, Math.max(0, x1));
      y0 = Math.min(1, Math.max(0, y0)); y1 = Math.min(1, Math.max(0, y1));
      if (x1 - x0 < 0.008 || y1 - y0 < 0.006) continue;      // 退化框 → 丢掉
      out.push(Object.assign({}, it, { box: [x0, y0, x1, y1] }));
    }
    return out;
  }

  /** 单张图 OCR + 翻译 */
  async function ocrTranslate({ dataUrl, targetLang, baseUrl, apiKey, model, stream, logicalW, logicalH }) {
    const messages = [SYS, {
      role: 'user',
      content: [
        { type: 'text', text: OCR_PROMPT(targetLang) },
        { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
      ],
    }];
    const raw = await stream(baseUrl, apiKey, model, messages, () => {});
    const j = parseLooseJSON(raw);
    const items = (j && Array.isArray(j.items) ? j.items : [])
      .filter((it) => it && Array.isArray(it.box) && it.box.length === 4 && it.translation)
      .map((it) => ({
        box: it.box.map(Number),
        text: String(it.text == null ? '' : it.text),
        translation: String(it.translation),
      }))
      .filter((it) => it.box.every((n) => Number.isFinite(n)) && it.box[2] > it.box[0] && it.box[3] > it.box[1]);
    return { items: normalizeBoxes(items, logicalW, logicalH), lang: (j && j.lang) || '' };
  }

  const api = { NO_VISION_HINT, VISION_HINTS, OCR_PROMPT, looksVisionCapable, TINY_PNG, probeVision, parseColor, textColorFor, isUnsupportedError, parseLooseJSON, normalizeBoxes, downscale, ocrTranslate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.LFImgEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* options/options.js */
'use strict';
const $ = (id) => document.getElementById(id);

const NUM_FIELDS = ['chunkSize', 'concurrency', 'rateLimit', 'rateInterval', 'batchSize', 'batchLength',
  'batchInterval', 'deferIdle', 'polishBatchBlocks', 'cacheMax',
  'imageMaxPerPage', 'imageMinSize', 'imageMaxDimOcr', 'bgScanMax',
  'chatMaxContext', 'chatTopK', 'chatHistoryTurns', 'imageMaxCount'];
const TEXT_FIELDS = ['visionModel', 'chatModel', 'systemPromptExtra'];
const SELECT_FIELDS = ['imagePaintMode', 'panelMode', 'imageDedupeSameSrc'];
const BOOL_FIELDS = ['translateOnLoad', 'translateDynamic', 'polishEnabled', 'viewportFirst', 'useCache',
  'termPreAnalyze', 'polishPipelined', 'polishAvoidReading', 'retryWholeChunk', 'repeatPattern',
  'translateAttrs', 'translateShadow', 'translateHidden', 'splitLongText',
  'imageTranslateEnabled', 'imageAutoTranslate',
  'chatEnabled', 'renderMarkdown', 'chatPersist'];

/** 「对话模型」「视觉模型」留空时,把"实际会用的模型"写进 placeholder:
 *  否则空输入框看起来像"没配好",而实际是回退到主模型。 */

async function init() {
  const st = await Lib.loadSettings();
  $('baseUrl').value = st.baseUrl; $('apiKey').value = st.apiKey; $('model').value = st.model;
  $('sourceLang').value = st.sourceLang; $('targetLang').value = st.targetLang;
  for (const f of NUM_FIELDS) if ($(f)) $(f).value = st[f];
  for (const f of TEXT_FIELDS) if ($(f)) $(f).value = st[f] || '';
  for (const f of SELECT_FIELDS) {
    const el = $(f);
    if (!el) continue;
    const v = st[f];
    // 默认值是布尔的 select(如"同图只翻第一处"):回填 1/0,否则直接回填字符串
    el.value = (typeof v === 'boolean') ? (v ? '1' : '0') : (v || el.options[0].value);
  }
  for (const f of BOOL_FIELDS) if ($(f)) $(f).checked = !!st[f];
  // 显示版本 + 构建时间:方便确认"我加载的是不是最新代码"(改完代码忘记重新加载是很常见的事故源)
  try {
    const mf = chrome.runtime.getManifest();
    const el = $('buildInfo');
    if (el) el.textContent = '版本 ' + (mf.version || '?') + (mf.version_name ? ' · 构建 ' + mf.version_name : ' · 开发目录(未打包)');
  } catch (e) { /* 忽略 */ }
  $('status').textContent = '已加载配置';
}

function collect() {
  const st = {
    baseUrl: $('baseUrl').value.trim(), apiKey: $('apiKey').value.trim(), model: $('model').value.trim(),
    sourceLang: $('sourceLang').value, targetLang: $('targetLang').value,
    chunkSize: Math.max(200, Number($('chunkSize').value) || 1500),
    concurrency: Math.min(Math.max(Number($('concurrency').value) || 12, 1), 50),
    rateLimit: Math.min(Math.max(Number($('rateLimit').value) || 8, 1), 60),
    rateInterval: Math.max(100, Number($('rateInterval').value) || 1200),
    batchSize: Math.min(Math.max(Number($('batchSize').value) || 20, 1), 100),
    batchLength: Math.max(500, Number($('batchLength').value) || 8000),
    batchInterval: Math.max(0, Number($('batchInterval').value) || 400),
    deferIdle: Math.max(0, Number($('deferIdle').value) || 3500),
    polishBatchBlocks: Math.min(Math.max(Number($('polishBatchBlocks').value) || 8, 1), 40),
    cacheMax: Math.max(100, Number($('cacheMax').value) || 2000),
    imageMaxPerPage: Math.min(Math.max(Number($('imageMaxPerPage').value) || 8, 1), 30),
    imageMinSize: Math.max(40, Number($('imageMinSize').value) || 100),
    imageMaxDimOcr: Math.max(512, Number($('imageMaxDimOcr').value) || 1568),
    visionModel: $('visionModel').value.trim(),
    imagePaintMode: $('imagePaintMode').value,
    chatModel: $('chatModel').value.trim(),
    systemPromptExtra: $('systemPromptExtra').value.trim(),
    panelMode: $('panelMode').value,
    imageDedupeSameSrc: $('imageDedupeSameSrc').value === '1',      // select 存的是 "1"/"0" → 归一成布尔(否则代码里的 === true 永不成立)
    bgScanMax: Math.min(Math.max(Number($('bgScanMax').value) || 5000, 200), 200000),
    chatMaxContext: Math.max(1000, Number($('chatMaxContext').value) || 12000),
    chatTopK: Math.min(Math.max(Number($('chatTopK').value) || 8, 1), 30),
    chatHistoryTurns: Math.min(Math.max(Number($('chatHistoryTurns').value) || 10, 1), 50),
    imageMaxCount: Math.min(Math.max(Number($('imageMaxCount').value) || 4, 1), 8),
  };
  for (const f of BOOL_FIELDS) if ($(f)) st[f] = $(f).checked;
  return st;
}

async function save() {
  const st = collect();
  if (!st.model) { $('status').textContent = '请填写模型名称'; return; }
  await Lib.storageSet(st);
  $('status').textContent = '已保存 ✓';
}

/** 一键应用推荐配置(老配置里 concurrency 3 / 串行润色 会显得慢) */
async function applyRecommended() {
  const st = collect();
  Object.assign(st, {
    concurrency: 12, rateLimit: 8, rateInterval: 1200,
    batchSize: 20, batchLength: 8000, batchInterval: 400,
    chunkSize: Math.max(1200, st.chunkSize || 1500), deferIdle: 3500,
    viewportFirst: true, useCache: true, termPreAnalyze: true,
    polishEnabled: true, polishPipelined: true, polishAvoidReading: true,
    retryWholeChunk: true, repeatPattern: true,
    translateAttrs: true, translateShadow: true, translateHidden: true, splitLongText: true,
    imageTranslateEnabled: true, imagePaintMode: 'auto', imageMaxPerPage: 8, imageMaxDimOcr: 1568,
  });
  await Lib.storageSet(st);
  await init();
  $('status').textContent = '已应用推荐配置 ✓ 建议点「测试连接」确认可用';
}

async function fetchModels() {
  const baseUrl = $('baseUrl').value.trim(), apiKey = $('apiKey').value.trim();
  $('status').textContent = '获取模型列表中…';
  const r = await Lib.sendMsg({ type: 'fetchModels', baseUrl, apiKey });
  const sel = $('modelList'); sel.innerHTML = '';
  if (r && r.ok) {
    $('baseUrl').value = r.base; // 回填规范化后的 base
    if (!r.models.length) { $('status').textContent = '接口返回空模型列表'; return; }
    const dl = $('visionModels');
    if (dl) dl.innerHTML = '';
    const looksVision = (m) => (typeof LFImgEngine !== 'undefined' && LFImgEngine.looksVisionCapable) ? LFImgEngine.looksVisionCapable(m) : false;
    for (const m of r.models) {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m + (looksVision(m) ? '  ·可能支持图片' : '');
      if (m === $('model').value) opt.selected = true;
      sel.appendChild(opt);
      // 「视觉模型」的候选:**全部**模型都放(不按名字过滤 —— 名字只是提示,能不能吃图以实测为准)
      if (dl) { const o2 = document.createElement('option'); o2.value = m; o2.label = m + (looksVision(m) ? ' ·可能支持图片' : ''); dl.appendChild(o2); }
    }
    sel.hidden = false;
    $('status').textContent = '共 ' + r.models.length + ' 个模型(带 ·可能支持图片 的只是名字像,能不能识别图片请点「测试能否识别图片」实测)';
  } else {
    sel.hidden = true;
    $('status').textContent = '获取失败: ' + (r && r.error ? r.error : '未知错误');
  }
}

/** "能不能吃图片"实测:真发一张 1×1 图问模型 —— 不按模型名单猜(用户明确要求) */
async function probeVisionNow() {
  const baseUrl = $('baseUrl').value.trim(), apiKey = $('apiKey').value.trim();
  const model = ($('visionModel').value.trim() || $('model').value.trim());
  const out = $('visionProbe');
  if (!model) { out.textContent = '请先填「视觉模型」或「模型名称」'; return; }
  out.textContent = '正在问模型(' + model + ')能否处理图片…';
  const eng = (typeof LFImgEngine !== 'undefined') ? LFImgEngine : null;
  if (!eng || !eng.probeVision) { out.textContent = '探测模块未加载,请刷新设置页'; return; }
  const r = await eng.probeVision({ baseUrl, apiKey, model, stream: Lib.chatStream });
  const label = r.verdict === 'vision' ? '✅ 能识别图片' : (r.verdict === 'no-vision' ? '❌ 不能识别图片' : '⚠️ 没测出来');
  const detail = String(r.detail || '').replace(/\s+/g, ' ').slice(0, 70);
  out.textContent = label + ' · ' + model + (detail ? ' · ' + detail : '');
  return r;
}

async function testConn() {
  const baseUrl = $('baseUrl').value.trim(), apiKey = $('apiKey').value.trim(), model = $('model').value.trim();
  $('status').textContent = '测试中…';
  const r = await Lib.sendMsg({ type: 'chat', baseUrl, apiKey, model,
    messages: [{ role: 'user', content: 'Reply with exactly: OK' }] });
  $('status').textContent = r && r.ok ? ('连通 ✓ 返回: ' + r.text.slice(0, 80)) : ('失败: ' + (r && r.error ? r.error : '未知错误'));
}

document.addEventListener('DOMContentLoaded', () => {
  init();
  $('saveBtn').addEventListener('click', save);
  $('fetchModelsBtn').addEventListener('click', fetchModels);
  $('testBtn').addEventListener('click', testConn);
  if ($('probeVisionBtn')) $('probeVisionBtn').addEventListener('click', () => { probeVisionNow(); });
  if ($('recommendBtn')) $('recommendBtn').addEventListener('click', applyRecommended);
  // 选模型同步到输入框。change 只在选中值“变化”时触发——若点击的模型恰好是当前
  // 选中项(如列表第一项被隐式选中)则无 change 事件,表现为“选不上”,故再挂
  // click/focus 兜底:打开下拉或聚焦的瞬间即同步当前选中值,值未变也能选中。
  const syncModel = (e) => { $('model').value = e.target.value; };
  $('modelList').addEventListener('change', syncModel);
  $('modelList').addEventListener('click', syncModel);
  $('modelList').addEventListener('focus', syncModel);
});

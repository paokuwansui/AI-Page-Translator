/* options/options.js */
'use strict';
const $ = (id) => document.getElementById(id);

async function init() {
  const st = await Lib.loadSettings();
  $('baseUrl').value = st.baseUrl; $('apiKey').value = st.apiKey; $('model').value = st.model;
  $('sourceLang').value = st.sourceLang; $('targetLang').value = st.targetLang;
  $('chunkSize').value = st.chunkSize; $('concurrency').value = st.concurrency;
  $('translateOnLoad').checked = st.translateOnLoad;
  $('translateDynamic').checked = st.translateDynamic;
  $('polishEnabled').checked = st.polishEnabled;
  $('status').textContent = '已加载配置';
}

async function save() {
  const st = {
    baseUrl: $('baseUrl').value.trim(), apiKey: $('apiKey').value.trim(), model: $('model').value.trim(),
    sourceLang: $('sourceLang').value, targetLang: $('targetLang').value,
    chunkSize: Math.max(200, Number($('chunkSize').value) || 1500),
    concurrency: Math.min(Math.max(Number($('concurrency').value) || 3, 1), 8),
    translateOnLoad: $('translateOnLoad').checked,
    translateDynamic: $('translateDynamic').checked,
    polishEnabled: $('polishEnabled').checked
  };
  if (!st.model) { $('status').textContent = '请填写模型名称'; return; }
  await Lib.storageSet(st);
  $('status').textContent = '已保存 ✓';
}

async function fetchModels() {
  const baseUrl = $('baseUrl').value.trim(), apiKey = $('apiKey').value.trim();
  $('status').textContent = '获取模型列表中…';
  const r = await Lib.sendMsg({ type: 'fetchModels', baseUrl, apiKey });
  const sel = $('modelList'); sel.innerHTML = '';
  if (r && r.ok) {
    $('baseUrl').value = r.base; // 回填规范化后的 base
    if (!r.models.length) { $('status').textContent = '接口返回空模型列表'; return; }
    for (const m of r.models) {
      const opt = document.createElement('option');
      opt.value = m; opt.textContent = m;
      if (m === $('model').value) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.hidden = false;
    $('status').textContent = '共 ' + r.models.length + ' 个模型，请选择';
  } else {
    sel.hidden = true;
    $('status').textContent = '获取失败: ' + (r && r.error ? r.error : '未知错误');
  }
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
  // 选模型同步到输入框。change 只在选中值“变化”时触发——若点击的模型恰好是当前
  // 选中项(如列表第一项被隐式选中)则无 change 事件,表现为“选不上”,故再挂
  // click/focus 兜底:打开下拉或聚焦的瞬间即同步当前选中值,值未变也能选中。
  const syncModel = (e) => { $('model').value = e.target.value; };
  $('modelList').addEventListener('change', syncModel);
  $('modelList').addEventListener('click', syncModel);
  $('modelList').addEventListener('focus', syncModel);
});

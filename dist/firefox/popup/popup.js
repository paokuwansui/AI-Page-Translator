/* popup/popup.js —— 注意：必须定向发给活动标签页的 content script */
'use strict';
const $ = (id) => document.getElementById(id);

async function sendToActiveTab(msg) {
  const [tab] = await new Promise((r) => chrome.tabs.query({ active: true, currentWindow: true }, r));
  if (!tab || tab.id == null) throw new Error('未找到活动标签页');
  return new Promise((r) => chrome.tabs.sendMessage(tab.id, msg, r));
}

async function refreshStatus() {
  const st = await Lib.storageGet(['targetLang', 'lastProgress']);
  if (st.targetLang) $('targetLang').value = st.targetLang;
  const p = st.lastProgress || {};
  const now = Date.now();
  const fresh = (p.ts && now - p.ts < 5000) || 0; // 进行中的进度只看 5 秒内的
  const doneRecently = p.ts && now - p.ts < 60000; // 完成态保留 60 秒
  if (p.total && fresh && p.pct < 100) {
    const stage = p.stage === 'polish' ? '润色中' : '翻译中';
    const pct = Math.round((p.done / p.total) * 100);
    $('status').textContent = stage + ' ' + pct + '% (' + p.done + '/' + p.total + ')';
    $('bar').style.width = pct + '%';
  } else if (p.total && doneRecently && p.pct >= 100) {
    $('status').textContent = '完成';
    $('bar').style.width = '100%';
  }
  // 其他情况(过期进度/已恢复/就绪):保持现状,不显示旧百分比
}

document.addEventListener('DOMContentLoaded', () => {
  refreshStatus();
  $('translateBtn').addEventListener('click', async () => {
    $('status').textContent = '翻译中…';
    try {
      const r = await sendToActiveTab({ type: 'translate' });
      if (r && r.ok) {
        if (r.skipped) $('status').textContent = '没有新的可翻译内容';
        else $('status').textContent = r.polished ? '完成(已润色)' : ('完成 ' + (r.translated || 0) + ' 块');
      } else {
        $('status').textContent = r && r.error ? r.error : '失败';
      }
    } catch (e) { $('status').textContent = '失败: ' + e.message; }
  });
  $('restoreBtn').addEventListener('click', async () => {
    try { await sendToActiveTab({ type: 'restore' }); $('status').textContent = '已恢复原文'; $('bar').style.width = '0%'; } catch (e) { /* ignore */ }
  });
  $('stopBtn').addEventListener('click', () => sendToActiveTab({ type: 'stop' }));
  $('targetLang').addEventListener('change', async (e) => { await Lib.storageSet({ targetLang: e.target.value }); });
  $('optionsLink').addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });
  setInterval(refreshStatus, 800);
});

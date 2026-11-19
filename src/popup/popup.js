/* popup/popup.js —— 注意：必须定向发给活动标签页的 content script */
'use strict';
const $ = (id) => document.getElementById(id);

/** 把 Chrome 的底层报错翻译成用户能照做的提示 */
// 报错文案在 lib/common.js 的 friendlyTabError(可单测):按「有无接收端」区分原因并带上页面地址

async function sendToActiveTab(msg) {
  const [tab] = await new Promise((r) => chrome.tabs.query({ active: true, currentWindow: true }, r));
  if (!tab || tab.id == null) throw new Error('未找到活动标签页');
  return new Promise((res, rej) => {
    try {
      // 帧范围由 Lib.frameOptsFor 决定:分帧翻译类要广播到所有 frame(否则 iframe 里不翻译),
      // UI/面板类只发顶层。子帧收到翻译类消息后会 return false 关掉自己的通道,不会挂住发送方。
      chrome.tabs.sendMessage(tab.id, msg, Lib.frameOptsFor(msg && msg.type), (r) => {
        const err = chrome.runtime.lastError;
        if (err) { rej(new Error(Lib.friendlyTabError(err.message, tab.url))); return; }
        res(r);
      });
    } catch (e) { rej(e); }
  });
}

async function refreshStatus() {
  const st = await Lib.storageGet(['targetLang', 'lastProgress']);
  if (st.targetLang) $('targetLang').value = st.targetLang;
  const tab = await new Promise((r) => chrome.tabs.query({ active: true, currentWindow: true }, (ts) => r(ts && ts[0])));
  const p = st.lastProgress || {};
  if (p.tabId != null && tab && tab.id != null && p.tabId !== tab.id) return;   // 别显示其它标签页的进度
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
  $('chatBtn').addEventListener('click', async () => {
    $('status').textContent = '打开 AI 助手…';
    try {
      const r = await sendToActiveTab({ type: 'toggleChat' });
      if (r && r.mode === 'sidepanel') $('status').textContent = '已打开侧栏';
      else if (r && r.mode === 'inpage') $('status').textContent = '已打开页内面板';
      else $('status').textContent = (r && r.error) || '打不开面板(受保护页面?)';
      if (r && r.mode) setTimeout(() => window.close(), 700);
    } catch (e) { $('status').textContent = '打不开面板: ' + e.message; }
  });
  $('chatSumBtn').addEventListener('click', async () => {
    $('status').textContent = '总结中…（在面板里查看）';
    try {
      const r = await sendToActiveTab({ type: 'askPage', question: '请总结这个页面。' });
      $('status').textContent = (r && r.ok) ? '已在面板中生成总结' : ((r && r.error) || '失败');
      if (r && r.ok) setTimeout(() => window.close(), 900);
    } catch (e) { $('status').textContent = '失败: ' + e.message; }
  });
  $('chatShotBtn').addEventListener('click', async () => {
    $('status').textContent = '截图中…（在面板里查看）';
    try {
      const r = await sendToActiveTab({ type: 'askWithShot', translate: true });   // 弹窗这个按钮就是"截图并翻译"
      $('status').textContent = (r && r.ok) ? '已截图(已加入面板)' : ((r && r.error) || '截图失败');
    } catch (e) { $('status').textContent = '失败: ' + e.message; }
  });
  $('translateBtn').addEventListener('click', async () => {
    $('status').textContent = '翻译中…';
    $('retryBtn').hidden = true;
    try {
      const r = await sendToActiveTab({ type: 'translate' });
      if (r && r.ok) {
        if (r.skipped) $('status').textContent = '没有新的可翻译内容';
        else if (r.aborted) $('status').textContent = '已停止(未翻完的段落可再点翻译继续)';
        else {
          let msg = r.polished ? '完成(已润色)' : ('完成 ' + (r.translated || 0) + ' 块');
          if (r.ms) msg += ' · ' + (r.ms / 1000).toFixed(1) + 's';
          if (r.req) msg += ' · ' + r.req + ' 请求';
          if (r.cacheHits) msg += ' · 缓存 ' + r.cacheHits + ' 段';
          if (r.failed) { msg += ' · ' + r.failed + ' 段未翻译'; $('retryBtn').hidden = false; }
          $('status').textContent = msg;
        }
      } else {
        $('status').textContent = r && r.error ? r.error : '失败';
      }
    } catch (e) { $('status').textContent = '失败: ' + e.message; }
  });
  $('retryBtn').addEventListener('click', async () => {
    $('status').textContent = '重试中…';
    try {
      const r = await sendToActiveTab({ type: 'retryFailed' });
      if (r && r.ok) {
        if (r.note) $('status').textContent = r.note;                       // 例如"没有需要重试的段落"
        else if (r.failed) $('status').textContent = '仍有 ' + r.failed + ' 段未翻译(可再点一次)';
        else $('status').textContent = '重试完成 ✓ 已补翻 ' + (r.retried || 0) + ' 段';
        $('retryBtn').hidden = !r.failed;
      } else $('status').textContent = r && r.error ? r.error : '重试失败';
    } catch (e) { $('status').textContent = '重试失败: ' + e.message; }
  });
  $('imgBtn').addEventListener('click', async () => {
    $('status').textContent = '图片翻译中…（首次会提示视觉模型是否可用）';
    try {
      const r = await sendToActiveTab({ type: 'translateImages' });
      if (r && r.ok) {
        // 内嵌框里的图由各帧自己翻(r.framesImages 是它们汇总上来的),不能说"本页没有图片"
        const inFrames = r.framesImages || 0;      // 内嵌框各帧实翻张数(含缓存命中)
        const frameNote = inFrames ? '(含内嵌框 ' + inFrames + ' 张)' : '';
        if ((r.images || 0) === 0 && !inFrames) {
          $('status').textContent = '本页没有可翻译的图片';
        } else if ((r.images || 0) === 0 && inFrames) {
          $('status').textContent = '本页 0 张,内嵌框里翻了 ' + inFrames + ' 张 · ' + ((r.frames || []).reduce((a, f) => a + (f.items || 0), 0)) + ' 段';
        } else {
          $('status').textContent = '图片完成 · ' + (r.images || 0) + ' 张 ' + frameNote + ' · ' + (r.items || 0) + ' 段' + (r.cached ? ' · 缓存 ' + r.cached + ' 张' : '');
        }
      } else {
        $('status').textContent = (r && r.error) ? r.error : '图片翻译失败';
      }
    } catch (e) { $('status').textContent = '图片翻译失败: ' + e.message; }
  });
  $('imgResetBtn').addEventListener('click', async () => {
    try { await sendToActiveTab({ type: 'resetImages' }); $('status').textContent = '已还原图片'; } catch (e) { /* ignore */ }
  });
  $('restoreBtn').addEventListener('click', async () => {
    try { await sendToActiveTab({ type: 'restore' }); $('status').textContent = '已恢复原文'; $('bar').style.width = '0%'; } catch (e) { /* ignore */ }
  });
  $('stopBtn').addEventListener('click', () => sendToActiveTab({ type: 'stop' }));
  $('targetLang').addEventListener('change', async (e) => { await Lib.storageSet({ targetLang: e.target.value }); });
  $('optionsLink').addEventListener('click', async (e) => {
    e.preventDefault();
    try { await Lib.openOptionsPage(); window.close(); }
    catch (err) { $('status').textContent = '打不开设置页: ' + (err && err.message ? err.message : err); }
  });
  setInterval(refreshStatus, 800);
});

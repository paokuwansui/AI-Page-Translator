/* panel/sidepanel.js —— Chrome 原生侧栏容器(面板逻辑复用 panel/core.js)
 *
 * 侧栏是独立扩展页:自己没有页面 DOM,因此:
 *   - 通过 tabs.sendMessage({type:'readerDump'}) 让 content script 提供页面资料
 *   - 引用 chip 点击 → {type:'scrollToChunk'} 让 content script 滚动到对应片段
 */
'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  let tabId = null;
  let streaming = null, timer = null;
  let st = null;

  const ui = {
    render(state) {
      $('model').textContent = (st && (st.chatModel || st.model)) || '';
      for (const b of $('modes').children) b.setAttribute('aria-selected', String(b.getAttribute('data-mode') === state.mode));
      const stats = (state.reader && state.reader.stats) || {};
      $('ctx').textContent = state.ready
        ? ('已读 ' + (stats.chunks || 0) + ' 段 / ' + (stats.images || 0) + ' 图'
          + (stats.frames && (stats.frames.total || stats.frames.remote) ? ' · 含 ' + (stats.frames.total || stats.frames.remote) + ' 个内嵌框' : '')
          + (stats.frames && stats.frames.crossOrigin ? '(另有 ' + stats.frames.crossOrigin + ' 个跨域框读不到)' : '')
          + (state.sentIds.size ? ' · 已用 ' + state.sentIds.size + ' 段' : ''))
        : '正在读取页面…';
      const btn = $('mdToggle');
      if (btn) {
        btn.setAttribute('aria-pressed', String(mdOn()));
        btn.textContent = mdOn() ? 'M↓' : 'M';
        btn.title = mdOn() ? '当前:渲染 Markdown(点击切换为纯文本)' : '当前:纯文本(点击切换为 Markdown)';
      }
      $('send').disabled = !!state.busy;
      $('stop').hidden = !state.busy;
      $('msgs').textContent = '';
      for (const m of state.history) appendMsg(m.role, m.text);
      if (streaming !== null) appendMsg('assistant', streaming);
      if (state.lastError) appendMsg('err', state.lastError);
      $('chips').textContent = '';
      state.attachments.forEach((a, i) => {
        const chip = document.createElement('span');
        chip.className = 'att';
        if (a.dataUrl) { const img = document.createElement('img'); img.src = a.dataUrl; img.alt = '附件'; chip.appendChild(img); }
        const t = document.createElement('span'); t.textContent = a.label || '附件'; chip.appendChild(t);
        const x = document.createElement('button'); x.type = 'button'; x.textContent = '✕';
        x.setAttribute('aria-label', '移除附件');
        x.style.cssText = 'border:none;background:none;cursor:pointer;color:inherit';
        x.addEventListener('click', () => { state.attachments.splice(i, 1); ui.render(state); });
        chip.appendChild(x);
        $('chips').appendChild(chip);
      });
      $('msgs').scrollTop = $('msgs').scrollHeight;
    },
    stream(text) {
      streaming = text;
      if (timer) return;
      timer = setTimeout(() => { timer = null; ui.render(LFPanelCore.state); }, 80);
    },
    error(text) { LFPanelCore.state.lastError = text; ui.render(LFPanelCore.state); },
    scrollBottom() { $('msgs').scrollTop = $('msgs').scrollHeight; },
  };

  const mdOn = () => !st || st.renderMarkdown !== false;

  function appendMsg(role, text) {
    const div = document.createElement('div');
    div.className = 'msg ' + (role === 'user' ? 'user' : role === 'err' ? 'err' : 'assistant');
    if (role === 'user' || role === 'err' || !mdOn()) {
      div.textContent = String(text || '');                    // 纯文本模式:不解析 Markdown
      if (role !== 'user') div.style.whiteSpace = 'pre-wrap';
    } else {
      div.innerHTML = LFMarkdown.mdToHtml(text || '');
    }
    $('msgs').appendChild(div);
  }

  async function activeTab() {
    const ts = await new Promise((r) => chrome.tabs.query({ active: true, currentWindow: true }, r));
    return ts && ts[0] ? ts[0] : null;
  }
  const toTab = async (msg) => {
    const t = await activeTab();                          // 每次都用当前活动标签,避免切页后发错对象
    if (t && t.id != null) tabId = t.id;
    if (tabId == null) return { ok: false, error: '没有活动标签页' };
    return new Promise((r) => {
      try {
        chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }, (v) => { void chrome.runtime.lastError; r(v || { ok: false }); });
      } catch (e) { r({ ok: false, error: String(e) }); }
    });
  };

  async function loadContext(force) {
    const tab = await activeTab();
    if (!tab) { $('ctx').textContent = '没有活动标签页'; return; }
    tabId = tab.id;
    const dump = await toTab({ type: 'readerDump', maxChunks: 60, force: !!force });   // force:点开内容后再点「重读页面」要真重读
    if (dump && dump.ok) {
      LFPanelCore.setReader({
        meta: dump.meta, outline: dump.outline || [], chunks: dump.chunks || [],
        images: dump.images || [], tables: [], stats: dump.stats || {},
      });
    } else {
      $('ctx').textContent = '无法读取该页面(受保护页面或权限不足)';
    }
    if (force || !streaming) ui.render(LFPanelCore.state);
  }

  async function send(text) {
    const q = String(text == null ? '' : text).trim();
    if (!q) return;
    streaming = '';
    ui.render(LFPanelCore.state);
    const r = await LFPanelCore.ask(q, st);
    streaming = null;
    ui.render(LFPanelCore.state);
    return r;
  }

  document.addEventListener('DOMContentLoaded', async () => {
    st = await Lib.loadSettings();
    LFPanelCore.mount(ui);
    for (const key of Object.keys(LFPanelCore.MODES)) {
      const b = document.createElement('button');
      b.className = 'chip'; b.type = 'button'; b.setAttribute('role', 'tab');
      b.setAttribute('data-mode', key);
      b.textContent = LFPanelCore.MODES[key].label;
      b.addEventListener('click', () => {
        LFPanelCore.setMode(key);
        ui.render(LFPanelCore.state);
        const preset = { summary: '请总结这个页面。', notes: '请把这个页面整理成笔记。', read: '快速告诉我这个页面讲了什么。', organize: '请把这个页面整理成大纲。' }[key];
        // 回答中只切模式、不抢发(与页内面板 inpage.js 的 !busy 判断对齐):
        // 否则 send → Core.ask 会以"正在回答中"早退,面板弹一条红字
        if (preset && !LFPanelCore.state.busy) send(preset);
      });
      $('modes').appendChild(b);
    }
    $('msgs').addEventListener('click', async (e) => {
      const b = e.target && e.target.closest ? e.target.closest('.lf-cite, .cite') : null;
      if (!b) return;
      await toTab({ type: 'scrollToChunk', id: Number(b.getAttribute('data-cite')) });
    });
    $('send').addEventListener('click', () => { const v = $('input').value; $('input').value = ''; send(v); });
    $('stop').addEventListener('click', () => { LFPanelCore.stop(); });
    $('input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (LFPanelCore.state.busy) return;               // 回答中:不清空输入(避免用户输入白丢)
        const v = $('input').value; $('input').value = ''; send(v);
      }
    });
    $('newChat').addEventListener('click', () => { LFPanelCore.reset(); streaming = null; loadContext(true); });
    $('mdToggle').addEventListener('click', () => {
      const on = !mdOn();
      st.renderMarkdown = on;
      try { chrome.storage.local.set({ renderMarkdown: on }); } catch (e) {}
      ui.render(LFPanelCore.state);
    });
    $('reload').addEventListener('click', () => loadContext(true));
    $('settings').addEventListener('click', () => {
      // 侧栏里以前根本没有设置入口(用户反馈"点不到设置")→ 走统一入口,失败要出声
      Lib.openOptionsPage().catch((e) => ui.error('打不开设置页: ' + ((e && e.message) || e)));
    });
    $('sel').addEventListener('click', async () => {
      const r = await toTab({ type: 'getSelection' });
      if (r && r.ok && r.text) { LFPanelCore.attach({ kind: 'text', text: r.text.slice(0, 4000), label: '选中文本' }); ui.render(LFPanelCore.state); }
      else ui.error('请先在页面上选中文本');
    });
    $('shot').addEventListener('click', async () => {
      // 侧栏覆盖不到网页 → 先请**页面**上出来框选遮罩(拖动选区;单击=整屏;Esc 取消)
      const pick = await toTab({ type: 'pickRegionShot' }, 120000);
      if (pick && pick.cancelled) return;                        // 用户取消:什么都不做
      if (!pick || pick.ok === false) {                          // ⚠️ 没有响应 = 页面里跑的还是旧脚本(重载扩展后没刷新页面)
        ui.error(!pick ? '页面上没有出现框选:页面脚本可能是旧版本 —— 请在 chrome://extensions 重载扩展,然后按 F5 刷新页面'
          : (pick.error === 'not-top-or-no-panel' ? '无法在页面上框选(请刷新页面后重试)' : (pick.error || '框选失败')));
        return;
      }
      const r = await Lib.sendMsg({ type: 'captureTab', format: 'png' }, 15000);
      if (!r || !r.ok) { ui.error((r && r.error) || '截图失败'); return; }
      let dataUrl = r.dataUrl;
      if (pick.rect && !pick.whole) {                            // 按选区裁剪(带 dpr 换算)
        const cut = await Lib.cropDataUrl(dataUrl, pick.rect, pick.vw || 0);
        if (cut.ok) dataUrl = cut.dataUrl;
        else ui.error('选区裁剪失败,已按整屏处理');
      }
      LFPanelCore.attach({ kind: 'image', dataUrl: dataUrl, label: '屏幕截图' });
      ui.render(LFPanelCore.state);
    });
    // 侧栏跨标签存活:切标签页/页面导航后必须重新取上下文,否则一直发给旧标签
    try {
      chrome.tabs.onActivated.addListener(() => { loadContext(true); });
      chrome.tabs.onUpdated.addListener((id, info) => { if (info.status === 'complete' && id === tabId) loadContext(true); });
    } catch (e) { /* 忽略 */ }
    // 设置页改动(模型/Key/Markdown 开关)在面板打开时立即生效
    try {
      chrome.storage.onChanged.addListener((changes) => {
        const keys = Object.keys(changes || {});
        // lastProgress 每翻完一块就写一次 → 不过滤会让面板每次进度都全量重渲染(开着面板翻译时明显掉帧)
        if (!keys.length || keys.indexOf('lfCacheV1') >= 0 || keys.indexOf('lastProgress') >= 0) return;
        Lib.loadSettings().then((v) => { st = v; ui.render(LFPanelCore.state); });
      });
    } catch (e) { /* 忽略 */ }
    await loadContext(false);
  });
})();

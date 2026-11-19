/* panel/inpage.js —— 页内 AI 对话面板(Shadow DOM 承载)
 *
 * 容器隔离:宿主 div 挂 documentElement(z-index 上限、all:initial),样式进 shadow root,
 * 页面 CSS(!important)也影响不到;宿主带 translate="no" 且被 chunker 跳过,不会被翻译。
 */
'use strict';
(function (global) {
  const HOST_ID = 'lf-panel-host';
  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .lf-launcher {
      position: fixed; right: 16px; bottom: 16px; width: 44px; height: 44px; border-radius: 50%;
      background: linear-gradient(135deg, #2563eb, #1d4ed8); color: #fff; display: flex;
      align-items: center; justify-content: center; font: 600 14px/1 system-ui, sans-serif;
      box-shadow: 0 6px 18px rgba(37,99,235,.45); cursor: pointer; user-select: none;
      border: none; padding: 0;
    }
    .lf-launcher:focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; }
    .lf-modal {
      position: fixed; right: 16px; bottom: 16px; width: 420px; max-width: calc(100vw - 24px);
      height: 560px; max-height: calc(100vh - 32px); display: flex; flex-direction: column;
      background: #fff; color: #0f172a; border: 1px solid #e2e8f0; border-radius: 14px;
      box-shadow: 0 20px 60px rgba(15,23,42,.28); overflow: hidden;
      font: 400 13.5px/1.55 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
    }
    .lf-modal[hidden] { display: none; }
    /* 停靠位置:左 / 右(尺寸由内联样式给,可拖拽改) */
    .lf-modal.side-left { right: auto; left: 16px; }
    .lf-modal.side-right { left: auto; right: 16px; }
    /* 拖拽手柄:内缘竖条改宽、上缘横条改高(面板贴底,往上拖=变高) */
    .lf-rs { position: absolute; z-index: 3; }
    /* ⚠️ 手柄必须放在面板**内侧**边缘:modal 是 overflow:hidden,放到外侧会被裁掉、点不到 */
    .lf-rs.side { top: 12px; bottom: 12px; width: 7px; cursor: ew-resize; }
    .lf-modal.side-right .lf-rs.side { left: 0; }
    .lf-modal.side-left .lf-rs.side { right: 0; }
    .lf-rs.top { left: 14px; right: 14px; top: 0; height: 7px; cursor: ns-resize; }
    .lf-rs.grip {
      width: 13px; height: 13px; left: 1px; top: 1px; border-radius: 3px; cursor: nwse-resize; z-index: 4;
      background: linear-gradient(135deg, #cbd5e1 0 3px, transparent 3px 100%);
    }
    .lf-modal.side-left .lf-rs.grip { left: auto; right: 1px; cursor: nesw-resize; }
    .lf-rs:hover { background-color: rgba(37,99,235,.12); }
    header { display: flex; align-items: center; gap: 6px; padding: 10px 12px; border-bottom: 1px solid #e2e8f0; background: #f8fafc; }
    .lf-title { font-weight: 600; font-size: 13.5px; }
    .lf-model { color: #64748b; font-size: 11.5px; }
    .lf-spacer { flex: 1; }
    .ic {
      width: 26px; height: 26px; border-radius: 7px; border: 1px solid #e2e8f0; background: #fff;
      color: #334155; cursor: pointer; font-size: 13px; line-height: 1; display: inline-flex;
      align-items: center; justify-content: center; padding: 0;
    }
    .ic:hover { background: #f1f5f9; }
    .ic:focus-visible { outline: 2px solid #2563eb; outline-offset: 1px; }
    .modes { display: flex; gap: 6px; padding: 8px 12px 0; flex-wrap: wrap; }
    .chip-mode {
      border: 1px solid #e2e8f0; background: #fff; color: #334155; border-radius: 999px;
      padding: 4px 10px; font-size: 12px; cursor: pointer;
    }
    .chip-mode[aria-selected="true"] { background: #eff6ff; border-color: #2563eb; color: #1d4ed8; font-weight: 600; }
    .ctx { padding: 6px 12px; color: #64748b; font-size: 11.5px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .ctx button { border: none; background: none; color: #2563eb; cursor: pointer; font-size: 11.5px; padding: 0; }
    .ctx button:hover { text-decoration: underline; }
    .msgs { flex: 1; overflow-y: auto; padding: 4px 12px 8px; }
    .msg { margin: 8px 0; padding: 9px 11px; border-radius: 10px; word-break: break-word; }
    .msg.user { background: #eff6ff; border: 1px solid #dbeafe; }
    .msg.assistant { background: #f8fafc; border: 1px solid #eef2f7; }
    .msg.err { background: #fef2f2; border: 1px solid #fecaca; color: #b91c1c; }
    .msg p { margin: 4px 0; }
    .msg h1,.msg h2,.msg h3 { margin: 8px 0 4px; font-size: 14px; }
    .msg ul,.msg ol { margin: 4px 0 4px 18px; padding: 0; }
    .msg code { background: #eef2f7; border-radius: 4px; padding: 0 3px; font-family: ui-monospace, monospace; font-size: 12px; }
    .msg pre { background: #0f172a; color: #e2e8f0; padding: 8px; border-radius: 8px; overflow-x: auto; }
    .msg pre code { background: none; color: inherit; }
    .msg blockquote { margin: 4px 0; padding-left: 8px; border-left: 3px solid #cbd5e1; color: #475569; }
    .msg table { border-collapse: collapse; margin: 6px 0; font-size: 12.5px; max-width: 100%; }
    .msg th, .msg td { border: 1px solid #e2e8f0; padding: 3px 6px; text-align: left; }
    .msg th { background: #f1f5f9; }
    .lf-cite {
      border: none; background: #e0e7ff; color: #3730a3; border-radius: 5px; cursor: pointer;
      font-size: 11px; padding: 0 4px; margin: 0 1px; vertical-align: 1px;
    }
    .lf-cite:hover { background: #c7d2fe; }
    .chips { display: flex; gap: 6px; padding: 0 12px 6px; flex-wrap: wrap; }
    .chip-att { background: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 999px; padding: 2px 8px; font-size: 11.5px; display: inline-flex; gap: 5px; align-items: center; }
    .chip-att img { width: 20px; height: 20px; object-fit: cover; border-radius: 4px; }
    .chip-att button { border: none; background: none; cursor: pointer; color: #64748b; font-size: 11px; padding: 0; }
    .composer { border-top: 1px solid #e2e8f0; padding: 8px 12px 10px; background: #fff; }
    textarea {
      width: 100%; height: 62px; resize: none; border: 1px solid #e2e8f0; border-radius: 9px;
      padding: 8px 10px; font: inherit; color: inherit; outline: none;
    }
    textarea:focus { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,.14); }
    .comp-acts { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 6px; min-width: 0; }
    /* 截图框选覆盖层 */
    .lf-shotsel { position: fixed; inset: 0; z-index: 2147483647; cursor: crosshair; background: rgba(15,23,42,.35); pointer-events: auto; }
    .lf-shotsel .box { position: absolute; border: 2px dashed #38bdf8; background: rgba(56,189,248,.16); border-radius: 2px; }
    .lf-shotsel .tip { position: fixed; left: 50%; top: 22px; transform: translateX(-50%); background: rgba(15,23,42,.92);
      color: #e2e8f0; padding: 6px 12px; border-radius: 9px; font-size: 12.5px; white-space: nowrap;
      font-family: system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif; }
    .comp-acts .grow { flex: 1; }
    .btn { border: 1px solid #e2e8f0; background: #fff; color: #334155; border-radius: 8px; padding: 6px 12px; font: inherit; cursor: pointer; }
    .btn:hover { background: #f1f5f9; }
    .btn.primary { background: linear-gradient(135deg, #2563eb, #1d4ed8); color: #fff; border: none; }
    .btn[disabled] { opacity: .55; cursor: not-allowed; }
    .hint { color: #94a3b8; font-size: 11px; }
    @media (prefers-color-scheme: dark) {
      .lf-modal { background: #0f172a; color: #e2e8f0; border-color: #334155; }
      header { background: #1e293b; border-color: #334155; }
      .ic { background: #1e293b; color: #cbd5e1; border-color: #334155; }
      .chip-mode { background: #1e293b; color: #cbd5e1; border-color: #334155; }
      .chip-mode[aria-selected="true"] { background: #1e3a8a; color: #dbeafe; }
      .msg.user { background: #1e3a8a; border-color: #1e40af; }
      .msg.assistant { background: #1e293b; border-color: #334155; }
      .msg code { background: #334155; }
      .composer { background: #0f172a; border-color: #334155; }
      textarea { background: #1e293b; border-color: #334155; color: #e2e8f0; }
      .btn { background: #1e293b; color: #cbd5e1; border-color: #334155; }
    }
  `;

  let host = null, root = null, el = {}, ctxData = { st: null, chunks: [] };
  let streaming = null, streamTimer = null, userScrolledUp = false;
  let renderedSig = '';                                   // 历史签名:流式期间只在"尾部气泡"上增量更新,不整表重建
  const pending = [];
  const MAX_IMAGE = 4;

  const Core = () => (typeof LFPanelCore !== 'undefined' ? LFPanelCore : null);
  const MD = () => (typeof LFMarkdown !== 'undefined' ? LFMarkdown : null);

  function h(tag, attrs, kids) {
    const n = document.createElement(tag);
    for (const k in (attrs || {})) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'text') n.textContent = attrs[k];
      else if (k.startsWith('on') && typeof attrs[k] === 'function') n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined) n.setAttribute(k, attrs[k]);
    }
    for (const kid of (kids || [])) if (kid) n.appendChild(kid);
    return n;
  }

  function build() {
    if (host) return;
    host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('translate', 'no');
    host.className = 'notranslate';
    host.style.cssText = 'all:initial;position:static;';
    root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);

    el.launcher = h('button', { class: 'lf-launcher', type: 'button', 'aria-label': '打开 AI 阅读助手', title: 'AI 阅读助手', text: 'AI' });
    el.msgs = h('div', { class: 'msgs', role: 'log', 'aria-live': 'polite', 'aria-label': '对话内容' });
    el.ctx = h('div', { class: 'ctx', 'aria-live': 'polite' });
    el.modes = h('div', { class: 'modes', role: 'tablist', 'aria-label': '任务模式' });
    el.chips = h('div', { class: 'chips' });
    el.model = h('span', { class: 'lf-model' });
    el.input = h('textarea', { 'aria-label': '输入问题', placeholder: '问点什么…（Enter 发送 / Shift+Enter 换行）' });
    el.send = h('button', { class: 'btn primary', type: 'button', text: '发送' });
    el.stop = h('button', { class: 'btn', type: 'button', text: '停止', hidden: 'hidden' });
    el.modal = h('div', { class: 'lf-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': '网页 AI 阅读助手', hidden: 'hidden' }, [
      h('header', null, [
        h('span', { class: 'lf-title', text: 'AI 阅读助手' }),
        el.model,
        h('span', { class: 'lf-spacer' }),
        h('button', { class: 'ic', type: 'button', 'aria-label': '新建对话', title: '新建对话', text: '＋', onclick: () => { Core().reset(); render(); el.input.focus(); } }),
        (el.mdToggle = h('button', { class: 'ic', type: 'button', 'aria-label': '切换 Markdown 渲染', title: '当前:渲染 Markdown(点击切换为纯文本)', text: 'M↓', onclick: () => toggleMarkdown() })),
        (el.dockBtn = h('button', { class: 'ic', type: 'button', 'aria-label': '面板位置', title: '面板位置:右侧(点击切到左侧)', text: '⇤', onclick: () => toggleSide() })),
        h('button', { class: 'ic', type: 'button', 'aria-label': '打开设置', title: '设置', text: '⚙', onclick: () => openOptionsFromPanel() }),
        h('button', { class: 'ic', type: 'button', 'aria-label': '关闭面板', title: '关闭', text: '✕', onclick: () => closePanel() }),
      ]),
      el.modes,
      el.ctx,
      el.msgs,
      el.chips,
      h('div', { class: 'composer' }, [
        el.input,
        h('div', { class: 'comp-acts' }, [
          h('button', { class: 'btn', type: 'button', 'aria-label': '读取页面图片', title: '读取页面图片', text: '🖼', onclick: () => safeCall('读取图片', () => attachImages()) }),
          h('button', { class: 'btn', type: 'button', 'aria-label': '截图翻译', title: '截图翻译(先框选区域 → 加入面板 → 按当前模式处理)', text: '📷', onclick: () => safeCall('截图', () => attachShot()) }),
          h('button', { class: 'btn', type: 'button', 'aria-label': '加入选中的文本', title: '加入选中文本', text: '✂', onclick: () => safeCall('加入选中文本', () => attachSelection()) }),
          h('span', { class: 'grow' }),
          el.stop, el.send,
        ]),
        h('div', { class: 'hint', text: 'Enter 发送 · Shift+Enter 换行 · Esc 关闭' }),
      ]),
    ]);
    el.rsSide = h('div', { class: 'lf-rs side', title: '拖动改宽度' });
    el.rsTop = h('div', { class: 'lf-rs top', title: '拖动改高度' });
    el.rsGrip = h('div', { class: 'lf-rs grip', title: '拖动改大小' });
    el.modal.appendChild(el.rsSide);
    el.modal.appendChild(el.rsTop);
    el.modal.appendChild(el.rsGrip);
    el.shotSel = h('div', { class: 'lf-shotsel' }, [
      h('div', { class: 'box' }),
      h('div', { class: 'tip', text: '拖动选择要翻译的区域 · 单击=整屏 · Esc 取消' }),
    ]);
    el.shotSel.hidden = true;
    el.shotSel.querySelector('.box').hidden = true;
    root.appendChild(el.launcher);
    root.appendChild(el.modal);
    root.appendChild(el.shotSel);

    bindResize();          // 拖拽改大小(内缘改宽 / 上缘改高 / 角标两者都改)
    applyLayout();         // 先按默认值摆好,设置读回来后再校正

    // 模式 chips
    const modes = Core().MODES;
    Object.keys(modes).forEach((key) => {
      const b = h('button', { class: 'chip-mode', type: 'button', role: 'tab', 'data-mode': key, text: modes[key].label });
      b.addEventListener('click', () => {
        Core().setMode(key);
        render();
        if (key !== 'translate' && !Core().state.busy) {
          const preset = { summary: '请总结这个页面。', notes: '请把这个页面整理成笔记。', read: '快速告诉我这个页面讲了什么。', organize: '请把这个页面整理成大纲。' }[key];
          if (preset) send(preset);
        }
        el.input.focus();
      });
      el.modes.appendChild(b);
    });

    el.launcher.addEventListener('click', () => openPanel());
    el.send.addEventListener('click', () => {
      if (Core().state.busy) return;                       // 回答中:保留输入内容,别清空
      const v = el.input.value; el.input.value = ''; send(v);
    });
    el.stop.addEventListener('click', () => { Core().stop(); });
    el.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (Core().state.busy) return;                     // 回答中:不清空输入
        const v = el.input.value; el.input.value = ''; send(v);
      }
    });
    // Esc 关闭:面板提示里承诺了,必须真的能关(输入框里按 Esc 也关,和主流聊天面板一致)
    el.onKeyDown = (e) => {
      if (e.key !== 'Escape') return;
      if (!el.modal || el.modal.hidden) return;
      try { e.stopPropagation(); } catch (err) {}
      closePanel();
    };
    if (!el.esBound) { el.esBound = true; try { addEventListener('keydown', el.onKeyDown, true); } catch (e) {} }
    el.msgs.addEventListener('scroll', () => {
      userScrolledUp = el.msgs.scrollTop + el.msgs.clientHeight < el.msgs.scrollHeight - 24;
    });
    el.msgs.addEventListener('click', (e) => {
      const b = e.target && e.target.closest ? e.target.closest('.lf-cite') : null;
      if (!b) return;
      const id = Number(b.getAttribute('data-cite'));
      const c = ctxData.chunks.find((x) => x.id === id);
      if (c && c.anchor && typeof LFReader !== 'undefined') LFReader.scrollTo(c.anchor);
    });
    document.documentElement.appendChild(host);

    // 面板开着时改设置(模型/Key/Markdown)立即生效
    try {
      chrome.storage.onChanged.addListener((changes) => {
        const keys = Object.keys(changes || {});
        // 缓存写入、进度写入(lfCacheV1 / lastProgress)不触发重渲染 —— 进度每块都写一次,否则整页面板会一直重排
        if (!keys.length || keys.indexOf('lfCacheV1') >= 0 || keys.indexOf('lastProgress') >= 0) return;
        Lib.loadSettings().then((v) => { ctxData.st = v; loadLayout(v); render(); });
      });
    } catch (e) { /* 忽略 */ }
  }

  /* ---------- 容器接口 ---------- */

  function render() {
    const st = ctxData.st || {};
    if (!host) return;
    const s = Core().state;
    el.model.textContent = (st.chatModel || st.model || '') + (st.visionModel ? ' · 视觉:' + st.visionModel : '');
    for (const b of el.modes.children) b.setAttribute('aria-selected', String(b.getAttribute('data-mode') === s.mode));
    el.ctx.textContent = '';
    const stats = (s.reader && s.reader.stats) || {};
    const fr = stats.frames || null;
    const frTotal = (fr && (fr.total || fr.remote)) || 0;
    const frSilent = (fr && fr.silent) || 0;
    const frImg = (fr && fr.imageOnlyCount) || 0;                 // 正文是图片/画布渲染的框(内容在,只是没有文字节点)
    el.ctx.appendChild(h('span', { text: '已读 ' + (stats.chunks || 0) + ' 段 / ' + (stats.imagesTotal || stats.images || 0) + ' 图'
      + (frTotal ? ' · 含 ' + frTotal + ' 个内嵌框' + ((frSilent || frImg) ? '(' + Math.max(0, frTotal - frSilent - frImg) + ' 个有文字' + (frImg ? ' / ' + frImg + ' 个正文是图片' : '') + (frSilent ? ' / ' + frSilent + ' 个未读到文字' : '') + ')' : '') : '')
      + (fr && fr.crossOrigin ? '(另有 ' + fr.crossOrigin + ' 个跨域框读不到)' : '')
      + (s.sentIds.size ? ' · 已用 ' + s.sentIds.size + ' 段' : '') }));
    if (frTotal && frSilent && frSilent >= frTotal) {
      el.ctx.appendChild(h('span', { class: 'hint', text: '部分内嵌内容没有可取到的文字:可先点开/滚动让其加载后按 ↻ 重读,或点 📷 框选该区域由视觉模型识别' }));
    }
    if (s.notice) el.ctx.appendChild(h('span', { class: 'hint', text: s.notice }));
    if (!s.ready) el.ctx.appendChild(h('button', { type: 'button', text: '立即读取页面', onclick: () => ensureCtx() }));
    // 重读:内容若是"点开/滚动后才加载"的(PE、ebook 阅读器常见),先点开再点这里
    else el.ctx.appendChild(h('button', {
      type: 'button', class: 'mini', text: '↻ 重读', title: '重新读取页面与内嵌框(内容点开后才加载的,先点开再重读)',
      onclick: () => safeCall('重读页面', async () => { const st2 = await Lib.loadSettings(); await Core().reread(st2); render(); }),
    }));
    el.send.disabled = !!s.busy;
    el.stop.hidden = !s.busy;

    // 消息:历史未变时只更新尾部流式气泡(避免每次 tick 重排整段对话)
    if (el.mdToggle) {
      el.mdToggle.setAttribute('aria-pressed', String(mdOn()));
      el.mdToggle.textContent = mdOn() ? 'M↓' : 'M';
      el.mdToggle.title = mdOn() ? '当前:渲染 Markdown(点击切换为纯文本)' : '当前:纯文本(点击切换为 Markdown)';
    }
    const sig = s.seq + '|' + s.history.length + '|' + (s.history.length ? s.history[s.history.length - 1].text.length : 0)
      + '|' + s.lastError + '|' + mdOn() + '|' + (s.attachments ? s.attachments.length : 0);
    const keep = el.msgs.scrollTop;
    const tail = el.msgs.lastElementChild;
    if (sig === renderedSig && tail && tail.getAttribute('data-streaming') === '1' && streaming !== null) {
      fillMsg(tail, 'assistant', streaming);               // 只改尾部流式气泡
    } else {
      renderedSig = sig;
      el.msgs.textContent = '';
      for (const m of s.history) appendMsg(m.role, m.text, false);
      if (streaming !== null) appendMsg('assistant', streaming, true);
      if (s.lastError) appendMsg('err', s.lastError, false);
    }
    if (userScrolledUp) el.msgs.scrollTop = keep; else scrollBottom();

    // 附件 chips
    el.chips.textContent = '';
    s.attachments.forEach((a, i) => {
      const chip = h('span', { class: 'chip-att' });
      if (a.dataUrl) chip.appendChild(h('img', { src: a.dataUrl, alt: a.label || '附件' }));
      chip.appendChild(h('span', { text: a.label || (a.kind === 'text' ? '选中文本' : '图片') }));
      chip.appendChild(h('button', { type: 'button', 'aria-label': '移除附件', text: '✕', onclick: () => { s.attachments.splice(i, 1); render(); } }));
      el.chips.appendChild(chip);
    });
  }

  function mdOn() { return !ctxData.st || ctxData.st.renderMarkdown !== false; }

  function toggleMarkdown() {
    const on = !mdOn();
    if (ctxData.st) ctxData.st.renderMarkdown = on;
    try { chrome.storage.local.set({ renderMarkdown: on }); } catch (e) {}
    render();
  }

  function fillMsg(div, role, text) {
    const useMd = mdOn() && role !== 'user' && role !== 'err';
    if (useMd) {
      const html = MD() ? MD().mdToHtml(text || '') : String(text || '');
      div.innerHTML = html;
      div.style.whiteSpace = '';
    } else {
      div.textContent = String(text || '');           // 纯文本模式:不解析 Markdown,原样显示
      if (role !== 'user') div.style.whiteSpace = 'pre-wrap';
    }
    return div;
  }

  function appendMsg(role, text, isStream) {
    const div = h('div', { class: 'msg ' + (role === 'user' ? 'user' : role === 'err' ? 'err' : 'assistant') });
    fillMsg(div, role, text);
    if (isStream) div.setAttribute('data-streaming', '1');
    el.msgs.appendChild(div);
    return div;
  }

  function stream(text) {
    streaming = text;
    if (streamTimer) return;
    streamTimer = setTimeout(() => { streamTimer = null; render(); }, 80);
  }

  /** 短暂提示:显示在资料行几秒 —— 用户可点的动作都必须有可见反馈(设置按钮反复被报"打不开") */
  let noticeTimer = null;
  function notice(text) {
    try {
      Core().state.notice = String(text || '');
      render();
      if (noticeTimer) clearTimeout(noticeTimer);
      noticeTimer = setTimeout(() => { Core().state.notice = ''; render(); }, 8000);
    } catch (e) { /* 忽略 */ }
  }

  function error(text) { ctxData.st && (Core().state.lastError = text); render(); }

  /** 按钮处理器一律经它调用:async 异常绝不能只丢在控制台(用户看到的就是"点了一下没反应") */
  function safeCall(label, fn) {
    try {
      const r = fn();
      if (r && typeof r.catch === 'function') r.catch((e) => error(label + '失败: ' + ((e && e.message) || e)));
      return r;
    } catch (e) {
      error(label + '失败: ' + ((e && e.message) || e));
      return null;
    }
  }

  function scrollBottom() {
    try { el.msgs.scrollTop = el.msgs.scrollHeight; } catch (e) {}
  }

  /* ---------- 打开/关闭 ---------- */

  async function openPanel() {
    build();
    const st = await Lib.loadSettings();
    ctxData.st = st;
    loadLayout(st);                    // 面板位置(左/右)与尺寸
    Core().mount({ render, stream, error, scrollBottom });
    el.launcher.hidden = true;
    el.modal.hidden = false;
    el.input.focus();
    Core().state.open = true;
    ensureCtx();
    render();
  }
  /** 打开设置页:走统一入口(后台确定性新建/聚焦标签),失败时明说原因而不是静默没反应 */
  function openOptionsFromPanel() {
    // 点了必须有反馈:先"正在打开…",再结果或真实原因
    notice('正在打开设置页…');
    Lib.openOptionsPage().then(() => {
      notice('设置页已打开 ✓(没看到的话可能在另一个窗口;也可点浏览器工具栏的扩展图标 → 设置)');
    }).catch((e) => {
      error('打不开设置页: ' + ((e && e.message) || e) + ' —— 请刷新页面后重试,或点工具栏扩展图标 → 设置');
    });
  }

  /* ---------- 面板停靠位置与尺寸(左/右 + 拖拽改大小,持久化) ---------- */

  const PANEL_MIN_W = 320, PANEL_MIN_H = 300;
  let layout = { side: 'right', w: 420, h: 560 };

  /** 应用布局:位置类 + 宽高(内联样式,受 viewport 限制) */
  function applyLayout() {
    if (!el.modal) return;
    const vw = innerWidth, vh = innerHeight;
    const w = Math.max(PANEL_MIN_W, Math.min(layout.w || 420, vw - 24));
    const h = Math.max(PANEL_MIN_H, Math.min(layout.h || 560, vh - 32));
    layout.w = w; layout.h = h;
    el.modal.style.width = w + 'px';
    el.modal.style.height = h + 'px';
    el.modal.classList.toggle('side-left', layout.side === 'left');
    el.modal.classList.toggle('side-right', layout.side !== 'left');
    if (el.dockBtn) {
      const right = layout.side !== 'left';
      el.dockBtn.textContent = right ? '⇤' : '⇥';
      el.dockBtn.title = right ? '面板位置:右侧(点击切到左侧)' : '面板位置:左侧(点击切到右侧)';
    }
  }

  /** 读设置里的布局(打开面板时调用) */
  function loadLayout(st) {
    const s2 = st || {};
    layout.side = (s2.panelSide === 'left') ? 'left' : 'right';
    layout.w = Number(s2.panelW) || 420;
    layout.h = Number(s2.panelH) || 560;
    applyLayout();
  }

  function persistLayout() {
    try { Lib.storageSet({ panelSide: layout.side, panelW: Math.round(layout.w), panelH: Math.round(layout.h) }); } catch (e) { /* 忽略 */ }
  }

  function toggleSide() {
    layout.side = (layout.side === 'left') ? 'right' : 'left';
    applyLayout();
    persistLayout();
    render();
  }

  /** 拖拽改大小:side 手柄改宽(方向随停靠侧),top 手柄改高(面板贴底 → 往上拖变高),grip 两者都改 */
  function bindResize() {
    const start = (el2, e, both) => {
      e.preventDefault(); e.stopPropagation();
      const x0 = e.clientX, y0 = e.clientY, w0 = layout.w, h0 = layout.h;
      const dir = (layout.side === 'left') ? 1 : -1;          // 左停靠:往右拖变宽;右停靠:往左拖变宽
      const move = (ev) => {
        const dw = (ev.clientX - x0) * dir;
        const dh = (y0 - ev.clientY);                          // 贴底:往上拖=变高
        if (el2 !== el.rsTop) layout.w = Math.max(PANEL_MIN_W, Math.min(w0 + dw, innerWidth - 24));
        if (el2 !== el.rsSide) layout.h = Math.max(PANEL_MIN_H, Math.min(h0 + dh, innerHeight - 32));
        applyLayout();
      };
      const up = () => {
        try { el2.releasePointerCapture(pid); } catch (e2) { /* 忽略 */ }
        window.removeEventListener('pointermove', move, true);
        window.removeEventListener('pointerup', up, true);
        persistLayout();
      };
      const pid = e.pointerId;
      try { el2.setPointerCapture(pid); } catch (e2) { /* 忽略 */ }
      window.addEventListener('pointermove', move, true);
      window.addEventListener('pointerup', up, true);
    };
    el.rsSide.addEventListener('pointerdown', (e) => start(el.rsSide, e, false));
    el.rsTop.addEventListener('pointerdown', (e) => start(el.rsTop, e, false));
    el.rsGrip.addEventListener('pointerdown', (e) => start(el.rsGrip, e, true));
  }

  /** 自动截图(阅读助手的兜底链路)期间临时收起面板 UI。
   *  ⚠️ 必须收:截的是整个窗口,面板/悬浮球会盖在正文上 —— 用户实测"截图只辨认出零散词句,被面板遮挡"。 */
  let shotUiWasOpen = false;
  function setShotUiHidden(on) {
    if (!host) return;
    try {
      if (on) {
        shotUiWasOpen = !!(el.modal && !el.modal.hidden);
        el.modal.hidden = true;
        el.launcher.hidden = true;
      } else {
        el.modal.hidden = !shotUiWasOpen;
        el.launcher.hidden = !!(Core() && Core().state && Core().state.open);   // 面板开着→悬浮球保持隐藏
      }
    } catch (e) { /* 忽略 */ }
  }

  function closePanel() {
    if (!host) return;
    el.modal.hidden = true;
    el.launcher.hidden = false;
    Core().state.open = false;                           // Esc 监听常驻(build 时注册),关闭态下是空操作
  }
  function togglePanel() { if (host && !el.modal.hidden) closePanel(); else openPanel(); }
  function isOpen() { return !!(host && el.modal && !el.modal.hidden); }

  async function ensureCtx() {
    build();
    const st = await Lib.loadSettings();      // 每次都用最新设置:面板开着时改配置也能立即生效
    ctxData.st = st;
    await Core().ensureReader(st);
    ctxData.chunks = Core().state.reader.chunks || [];
    render();
  }

  /* ---------- 附件 ---------- */

  function addTextAttachment(text, label) {
    if (!text || !text.trim()) return;
    Core().attach({ kind: 'text', text: String(text).slice(0, 4000), label: label || '选中文本' });
    render();
  }

  async function attachSelection() {
    try {
      let sel = String(window.getSelection ? window.getSelection().toString() : '');
      let where = '';
      if (!sel.trim()) {                                   // 顶层没有 → 可能选在内嵌框里(顶层选择是空的)
        try {
          const r = await Lib.sendMsg({ type: 'collectFrameSelection' }, 4000);
          if (r && r.ok && r.text) { sel = String(r.text); where = '内嵌框'; }
        } catch (e) { /* 忽略:下面的报错会说明 */ }
      }
      if (!sel.trim()) { error('当前没有选中文本,请先在页面上选中内容'); return; }
      addTextAttachment(sel, (where ? '选中文本(内嵌框) ' : '选中文本 ') + sel.length + ' 字');
    } catch (e) { /* 忽略 */ }
  }

  async function attachImages() {
    if (typeof LFImgCollect === 'undefined' || typeof LFImgEngine === 'undefined') return;
    const st = await Lib.loadSettings();      // 每次都用最新设置:面板开着时改配置也能立即生效
    ctxData.st = st;
    const cap = Math.max(MAX_IMAGE, st.imageMaxCount || 4);
    const list = LFImgCollect.collect({ minW: st.imageMinSize || 100, minH: st.imageMinSize || 100, max: cap, viewportOnly: false });
    // 内嵌框里的图顶层读不到 → 逐帧问一遍(跨域框也能拿到)
    let fromFrames = [];
    try {
      const fr = await Lib.sendMsg({ type: 'collectFrameImages', max: cap }, 12000);
      fromFrames = (fr && fr.images) || [];
    } catch (e) { /* 忽略:至少还有本页的图 */ }
    if (!list.length && !fromFrames.length) { error('本页和内嵌框里都没有可用的图片'); return; }
    const seenUrl = new Set(list.map((c) => c.src));
    const picked = list.slice(0, st.imageMaxCount || MAX_IMAGE);
    for (const c of picked) {
      try {
        const fr = await Lib.sendMsg({ type: 'fetchImage', url: c.src });
        if (!fr || !fr.ok) continue;
        const small = await LFImgEngine.downscale(fr.dataUrl, st.imageMaxDimOcr || 1024);   // 与设置页字段一致
        Core().attach({ kind: 'image', dataUrl: small, label: (c.el.alt || '图片').slice(0, 12) + ' ' + c.w + 'x' + c.h });
      } catch (e) { /* 跳过该图 */ }
    }
    // 内嵌框来的图:各帧已经取好 dataUrl,直接加入(按 url 去重)
    let addedFrames = 0;
    for (const im of fromFrames) {
      if (!im || !im.dataUrl || seenUrl.has(im.url)) continue;
      seenUrl.add(im.url);
      try {
        const small = await LFImgEngine.downscale(im.dataUrl, st.imageMaxDimOcr || 1024);
        Core().attach({ kind: 'image', dataUrl: small, label: '内嵌框图片 ' + (im.w || 0) + 'x' + (im.h || 0) });
        addedFrames++;
      } catch (e) { /* 跳过该图 */ }
    }
    if (addedFrames) notice('已加入内嵌框里的 ' + addedFrames + ' 张图片');
    render();
  }

  /** 「截图翻译」的既定流程:① 创建截图 → ② 把截图加入面板(附件可见可删)→ ③ 切到翻译模式并提问。
   *  注意顺序:面板必须在截图后**立刻**恢复可见(否则整段回答都在隐藏状态里跑完,用户什么也看不到)。 */
  const SHOT_QUESTION = '翻译这张截图里的文字;有排版结构(分段/列表/表格)就保留,术语沿用页面里的通行译法。';
  /** 框选截图区域:拖动选区,单击=整屏,Esc 取消。返回 {rect,vw,dpr} 或 {cancelled:true} */
  let pendingPick = null;          // 上一次没完成的框选
  function pickRegion() {
    return new Promise((resolve) => {
      // 新框选开始 → 取消上一个未完成的(否则它会一直挂着,事后补一次整屏截图,顶掉新的结果)
      if (pendingPick) { try { pendingPick({ cancelled: true }); } catch (e) { /* 忽略 */ } pendingPick = null; }
      pendingPick = resolve;
      const ov = el.shotSel;
      if (!ov) {                                   // 面板脚本较旧(没建选框元素)→ 必须说清楚,别静默改按整屏
        pendingPick = null;
        error('截图框选不可用:面板脚本是旧版本 —— 请重载扩展并刷新页面');
        resolve(null);
        return;
      }
      const box = ov.querySelector('.box');
      let sx = 0, sy = 0, dragging = false, done = false;
      const cleanup = () => {
        ov.hidden = true; box.hidden = true;
        window.removeEventListener('keydown', onKey, true);
        ov.removeEventListener('mousedown', onDown, true);
        window.removeEventListener('mousemove', onMove, true);
        window.removeEventListener('mouseup', onUp, true);
      };
      const finish = (r) => { if (done) return; done = true; if (pendingPick === resolve) pendingPick = null; cleanup(); resolve(r); };
      const onDown = (e) => {
        dragging = true; sx = e.clientX; sy = e.clientY;
        box.hidden = false;
        box.style.left = sx + 'px'; box.style.top = sy + 'px'; box.style.width = '0px'; box.style.height = '0px';
        e.preventDefault(); e.stopPropagation();
      };
      const onMove = (e) => {
        if (!dragging) return;
        box.style.left = Math.min(e.clientX, sx) + 'px';
        box.style.top = Math.min(e.clientY, sy) + 'px';
        box.style.width = Math.abs(e.clientX - sx) + 'px';
        box.style.height = Math.abs(e.clientY - sy) + 'px';
        e.preventDefault();
      };
      const onUp = (e) => {
        if (!dragging) return;
        dragging = false;
        const w = Math.abs(e.clientX - sx), h = Math.abs(e.clientY - sy);
        const vw = innerWidth;
        if (w < 8 || h < 8) {                 // 单击/极小拖动 = 整屏(保留原行为)
          finish({ ok: true, whole: true, rect: { x: 0, y: 0, w: vw, h: innerHeight }, vw: vw, dpr: devicePixelRatio || 1 });
          return;
        }
        finish({ ok: true, rect: { x: Math.min(e.clientX, sx), y: Math.min(e.clientY, sy), w: w, h: h }, vw: vw, dpr: devicePixelRatio || 1 });
      };
      const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish({ cancelled: true }); } };
      ov.hidden = false;
      ov.addEventListener('mousedown', onDown, true);
      window.addEventListener('mousemove', onMove, true);
      window.addEventListener('mouseup', onUp, true);
      window.addEventListener('keydown', onKey, true);
    });
  }

  async function attachShot(opts) {
    const o = opts || {};
    const wasOpen = isOpen();
    // ① 先框选要截的区域(单击=整屏,Esc 取消)—— 选框期间收起面板,才好看到整页
    let region = null;
    try { if (host) host.removeAttribute('data-shot-crop'); } catch (e) { /* 忽略 */ }
    if (o.region !== false) {
      if (wasOpen) { el.modal.hidden = true; el.launcher.hidden = true; }
      region = await pickRegion();
      if (region && region.cancelled) {
        if (wasOpen) { el.modal.hidden = false; el.launcher.hidden = true; }
        render();
        return { ok: false, cancelled: true };
      }
    }
    let shot = null;
    try {
      if (wasOpen) { el.modal.hidden = true; el.launcher.hidden = true; }   // ② 别把自己截进去(含悬浮球)
      await new Promise((r) => setTimeout(r, 140));
      shot = await Promise.race([
        Lib.sendMsg({                                  // PNG 无损:给模型读截图里的文字更准
          type: 'captureTab', format: 'png',
          rect: region && region.rect,                 // 选区(CSS 像素)→ 后台按 dpr 换算裁剪
          vw: region && region.vw, dpr: region && region.dpr,
        }, 15000),
        new Promise((res) => setTimeout(() => res({ ok: false, error: '截图超时' }), 15000)),
      ]);
    } catch (e) {
      shot = { ok: false, error: '截图失败: ' + ((e && e.message) || e) };
    } finally {
      if (wasOpen) { el.modal.hidden = false; el.launcher.hidden = true; }  // 面板必须回来(悬浮球保持隐藏)
      render();
    }
    // 按选区裁剪(单击=整屏时 region.whole 为真,跳过)
    if (shot && shot.ok && shot.dataUrl && region && region.rect && !region.whole && region.rect.w >= 8 && region.rect.h >= 8) {
      const cut = await Lib.cropDataUrl(shot.dataUrl, region.rect, region.vw || innerWidth);
      if (cut.ok) {
        shot = { ok: true, dataUrl: cut.dataUrl, cropped: true, w: cut.w, h: cut.h };
        try { host.setAttribute('data-shot-crop', cut.w + 'x' + cut.h); } catch (e) { /* 忽略 */ }
      } else {
        notice('选区裁剪失败,已按整屏处理');       // 不挡路
        try { host.setAttribute('data-shot-crop', 'failed'); } catch (e) { /* 忽略 */ }
      }
    }
    if (!shot || !shot.ok) {                                    // 失败:给真实原因,不再笼统甩锅给页面
      if (shot && shot.error) error(shot.error);
      else error('截图没有成功:页面脚本与扩展失去联系(扩展刚更新过或脚本已失效),请刷新页面后重试');
      return { ok: false };
    }
    Core().attach({ kind: 'image', dataUrl: shot.dataUrl, label: '屏幕截图' });   // ② 加入面板
    render();
    if (o.translate === false) return { ok: true };             // 调用方只要截图,自己去提问
    // ③ 跟着**当前选中的标签**走(用户:截完图不该默认走翻译,我可能想问图片内容)
    //    只有「当前就在翻译模式」或调用方明确给了问题,才自动发问;否则只把图放进附件,让用户自己问。
    const modeNow = Core().state.mode;
    const explicit = !!(o.question && String(o.question).trim()) || o.translate === true;
    if (!explicit && modeNow !== 'translate') {
      const label = ((Core().MODES || {})[modeNow] || {}).label || modeNow;
      notice('截图已加入(当前「' + label + '」模式)—— 直接输入你想问的,或切到「翻译」再点 📷 翻这张图');
      try { if (el.input && !el.input.hidden) el.input.focus(); } catch (e) { /* 忽略 */ }
      render();
      return { ok: true, attached: true, asked: false, mode: modeNow };
    }
    if (modeNow !== 'translate') { Core().setMode('translate'); render(); }   // 显式问题:按翻译模式语义走
    await ensureIdle(2500);                                     // 上一轮还在流式 → 先中止,别让本次被 busy 丢掉
    try {
      const sr = await send(o.question || SHOT_QUESTION);
      if (sr && sr.ok === false) error('截图后的翻译没成功: ' + (sr.error || Core().state.lastError || '请求失败(未返回错误详情)'));
    } catch (e) {                                               // 双保险:send 已兜底,这里再兜一次
      error('截图后的翻译失败: ' + ((e && e.message) || e));
      return { ok: false, error: String((e && e.message) || e) };
    }
    return { ok: true, asked: true };
  }

  /* ---------- 提问 ---------- */

  /** 面板正忙(上一轮还在流式)时:中止它并等收尾。
   *  没有这一步,"点 📷 时上一轮还没答完"会让整个截图流程被 ask 的 busy 早退静默丢弃
   *  (用户看到的就是"闪了一下就结束了")。*/
  async function ensureIdle(maxMs) {
    if (!Core().state.busy) return true;
    try { Core().stop(); } catch (e) { /* 忽略 */ }
    const t0 = Date.now();
    while (Core().state.busy && Date.now() - t0 < (maxMs || 2500)) {
      await new Promise((r) => setTimeout(r, 80));
    }
    return !Core().state.busy;
  }

  async function send(text) {
    const st = await Lib.loadSettings();      // 每次都用最新设置:面板开着时改配置也能立即生效
    ctxData.st = st;
    try {
      if (!Core().state.ready) await ensureCtx();
      Core().state.lastError = '';
      streaming = '';
      render();
      const r = await Core().ask(text, st);
      streaming = null;
      // ask 用返回值报错(不抛异常):不看返回值就会出现"点了没反应、面板里什么都没有"
      if (r && r.ok === false && !Core().state.lastError) error('请求失败: ' + (r.error || '未知错误'));
      render();
      return r;
    } catch (e) {
      // 关键:不能把异常丢给调用方 —— 调用方(截图链路等)await 到 reject 就是"点了没反应"
      streaming = null;
      error('请求失败: ' + ((e && e.message) || e));
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  const api = { build, openPanel, closePanel, togglePanel, isOpen, setShotUiHidden, render, stream, error, send,
    attachSelection, attachImages, attachShot, addTextAttachment, toggleMarkdown,
    mdOn, hostRef: () => host };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.LFPanel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

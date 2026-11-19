/* lib/markdown.js —— 极简安全 Markdown → HTML
 *
 * 安全边界:先转义所有文本,再由我们自己插入白名单标签;链接只允许 http(s)/mailto。
 * 模型输出可能包含任意 HTML/脚本,因此绝不能把原始输出直接 innerHTML。
 * 额外能力:[[3]] 引用标记 → 可点击 chip(点击跳转到页面片段)。
 */
'use strict';
(function (global) {
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
  const SAFE_URL = /^(https?:|mailto:)/i;

  function inline(s) {
    let out = esc(s);
    out = out.replace(/\[\[(\d+)\]\]/g, (m, n) => '<button type="button" class="lf-cite" data-cite="' + n + '" title="跳转到片段 ' + n + '">' + n + '</button>');
    out = out.replace(/`([^`]+)`/g, (m, a) => '<code>' + a + '</code>');
    out = out.replace(/\*\*([^*]+)\*\*/g, (m, a) => '<strong>' + a + '</strong>');
    out = out.replace(/(^|[\s(])\*([^*\n]+)\*/g, (m, p, a) => p + '<em>' + a + '</em>');
    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, url) =>
      (SAFE_URL.test(url) ? '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + text + '</a>' : text));
    return out;
  }

  function mdToHtml(src) {
    const lines = String(src == null ? '' : src).replace(/\r/g, '').split('\n');
    const out = [];
    let inCode = false, list = null, para = [], quote = false;

    const flushPara = () => { if (para.length) { out.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; } };
    const closeList = () => { if (list) { out.push('</' + list + '>'); list = null; } };
    const closeQuote = () => { if (quote) { out.push('</blockquote>'); quote = false; } };

    for (let li = 0; li < lines.length; li++) {
      const raw = lines[li];
      if (/^\s*```/.test(raw)) {
        flushPara(); closeList(); closeQuote();
        if (inCode) { out.push('</code></pre>'); inCode = false; } else { out.push('<pre><code>'); inCode = true; }
        continue;
      }
      if (inCode) { out.push(esc(raw) + '\n'); continue; }
      if (!raw.trim()) { flushPara(); closeList(); closeQuote(); continue; }

      const h = /^(#{1,6})\s+(.*)$/.exec(raw);
      if (h) {
        flushPara(); closeList(); closeQuote();
        const n = h[1].length;
        out.push('<h' + n + '>' + inline(h[2]) + '</h' + n + '>');
        continue;
      }
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(raw)) { flushPara(); closeList(); closeQuote(); out.push('<hr>'); continue; }

      // 表格:连续两行以 | 开头,且第二行是分隔行
      if (/^\s*\|.*\|\s*$/.test(raw)) {
        const next = lines[li + 1] || '';
        if (/^\s*\|[\s:|-]+\|\s*$/.test(next)) {
          flushPara(); closeList(); closeQuote();
          const cells = (row) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
          const head = cells(raw);
          const body = [];
          let j = li + 2;
          while (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j])) { body.push(cells(lines[j])); j++; }
          li = j - 1;
          out.push('<table><thead><tr>' + head.map((c) => '<th>' + inline(c) + '</th>').join('') + '</tr></thead><tbody>'
            + body.map((r) => '<tr>' + r.map((c) => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('')
            + '</tbody></table>');
          continue;
        }
      }

      const ul = /^\s*[-*+]\s+(.*)$/.exec(raw);
      const ol = /^\s*\d+[.)]\s+(.*)$/.exec(raw);
      if (ul || ol) {
        flushPara(); closeQuote();
        const want = ul ? 'ul' : 'ol';
        if (list !== want) { closeList(); out.push('<' + want + '>'); list = want; }
        out.push('<li>' + inline((ul || ol)[1]) + '</li>');
        continue;
      }

      const bq = /^\s*>\s?(.*)$/.exec(raw);
      if (bq) {
        flushPara(); closeList();
        if (!quote) { out.push('<blockquote>'); quote = true; }
        out.push('<p>' + inline(bq[1]) + '</p>');
        continue;
      }

      para.push(raw.trim());
    }
    flushPara(); closeList(); closeQuote();
    if (inCode) out.push('</code></pre>');
    return out.join('\n');
  }

  /** 纯文本预览(复制/导出用):只去掉「成对的标记」,绝不误删正文里的 * 与 ` */
  function stripMd(src) {
    return String(src == null ? '' : src)
      .replace(/```[\s\S]*?```/g, (m) => m.replace(/```[^\n]*\n?/g, ''))   // 围栏:语言标签任意
      .replace(/\[\[(\d+)\]\]/g, '[$1]')                                  // 引用 chip → [n]
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1($2)')                   // 链接保留 URL
      .replace(/`([^`\n]+)`/g, '$1')                                         // 行内代码:成对才去
      .replace(/\*\*([^*]+)\*\*/g, '$1')                                   // 粗体:成对才去
      .replace(/__([^_]+)__/g, '$1')
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1$2')                          // 斜体:*x*(不碰 2*3*4)
      .replace(/^#{1,6}\s+/gm, '');
  }

  const api = { mdToHtml, inline, stripMd, esc };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.LFMarkdown = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

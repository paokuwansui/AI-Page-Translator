/* tests/verify-ui.mjs —— 扩展 UI 页面加载与样式验证(headless Chromium)
   前置: 无(mock server 非必需,页面不调 API)
   用法: node tests/verify-ui.mjs
*/
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const EXT = new URL('../src/', import.meta.url).pathname;
const CDP_PORT = 9235;
const PROFILE = `/tmp/ai-trans-ui-${Date.now()}`;

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); }
    };
  }
  async open() { if (this.ws.readyState === 0) await new Promise((r) => this.ws.onopen = r); }
  async call(method, params = {}) {
    const id = ++this.id;
    const p = new Promise((r) => this.pending.set(id, r));
    this.ws.send(JSON.stringify({ id, method, params }));
    const m = await p;
    if (m.error) throw new Error(method + ': ' + JSON.stringify(m.error));
    return m.result;
  }
}

async function getTargets() {
  return (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
}

async function waitFor(fn, timeoutMs, step = 300) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await sleep(step);
  }
  throw new Error('waitFor timeout');
}

const chrome = spawn('chromium', [
  '--headless=new', '--no-sandbox', '--disable-gpu',
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${PROFILE}`,
  `--disable-extensions-except=${EXT}`,
  `--load-extension=${EXT}`,
  'about:blank'
], { stdio: 'ignore' });

let failures = 0;
const check = (name, cond) => { console.log((cond ? '✔' : '✖') + ' ' + name); if (!cond) failures++; };

try {
  await waitFor(async () => {
    try { await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); return true; } catch { return false; }
  }, 15000);

  const swTarget = await waitFor(async () => {
    const ts = await getTargets();
    return ts.find((t) => t.type === 'service_worker');
  }, 20000);
  const extId = new URL(swTarget.url).host;

  const pageTarget = await waitFor(async () => {
    const ts = await getTargets();
    return ts.find((t) => t.type === 'page');
  }, 10000);
  const page = new CDP(pageTarget.webSocketDebuggerUrl);
  await page.open();
  await page.call('Page.enable');
  await page.call('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__errors=[]; window.addEventListener('error', (e) => window.__errors.push(String(e.message)));`
  });

  // ---------- options 页 ----------
  await page.call('Page.navigate', { url: `chrome-extension://${extId}/options/options.html` });
  // 等 3 张卡片渲染 + CSS 生效(避免样式加载竞态)
  await waitFor(async () => {
    const r = await page.call('Runtime.evaluate', {
      expression: `document.querySelectorAll('.card').length === 3 && getComputedStyle(document.getElementById('saveBtn')).backgroundImage.includes('gradient')`,
      returnByValue: true
    });
    return r.result.value === true;
  }, 10000);
  await waitFor(async () => {
    const r = await page.call('Runtime.evaluate', { expression: `document.getElementById('status').textContent`, returnByValue: true });
    return r.result.value === '已加载配置'; // init() 执行完成
  }, 5000);

  const opt = (await page.call('Runtime.evaluate', {
    expression: `(() => {
      const ids = ['baseUrl','apiKey','model','fetchModelsBtn','modelList','sourceLang','targetLang','chunkSize','concurrency','translateOnLoad','translateDynamic','polishEnabled','saveBtn','testBtn','status'];
      const missing = ids.filter((i) => !document.getElementById(i));
      const labelOk = [...document.querySelectorAll('label[for]')].every((l) => document.getElementById(l.htmlFor));
      const cards = document.querySelectorAll('.card').length;
      const btnBg = getComputedStyle(document.getElementById('saveBtn')).backgroundImage;
      const cardRadius = getComputedStyle(document.querySelector('.card')).borderRadius;
      const bodyBg = getComputedStyle(document.body).backgroundColor;
      return JSON.stringify({ missing, labelOk, cards, btnBg, cardRadius, bodyBg, status: document.getElementById('status').textContent, errors: window.__errors });
    })()`,
    returnByValue: true
  })).result.value;
  const o = JSON.parse(opt);
  check('options: 3 张分组卡片', o.cards === 3);
  check('options: 关键元素齐全', o.missing.length === 0);
  check('options: label[for] 全部有匹配元素', o.labelOk === true);
  check('options: 保存按钮渐变样式生效', o.btnBg.includes('gradient'));
  check('options: 卡片圆角生效', parseFloat(o.cardRadius) > 0);
  check('options: 页面背景已应用主题色', o.bodyBg !== 'rgba(0, 0, 0, 0)');
  check('options: init 已执行(status=已加载配置)', o.status === '已加载配置');
  check('options: 无 JS 错误', o.errors.length === 0);

  // ---------- popup 页 ----------
  await page.call('Page.navigate', { url: `chrome-extension://${extId}/popup/popup.html` });
  // 等主按钮渐变样式生效(避免样式加载竞态)
  await waitFor(async () => {
    const r = await page.call('Runtime.evaluate', {
      expression: `getComputedStyle(document.getElementById('translateBtn')).backgroundImage.includes('gradient')`,
      returnByValue: true
    });
    return r.result.value === true;
  }, 10000);

  const pop = (await page.call('Runtime.evaluate', {
    expression: `(() => {
      const ids = ['translateBtn','restoreBtn','stopBtn','targetLang','bar','status','optionsLink'];
      const missing = ids.filter((i) => !document.getElementById(i));
      const labelOk = !!document.querySelector('label[for="targetLang"]');
      const btnBg = getComputedStyle(document.getElementById('translateBtn')).backgroundImage;
      const logoBg = getComputedStyle(document.querySelector('.logo')).backgroundImage;
      const width = document.body.offsetWidth;
      return JSON.stringify({ missing, labelOk, btnBg, logoBg, width, errors: window.__errors });
    })()`,
    returnByValue: true
  })).result.value;
  const p = JSON.parse(pop);
  check('popup: 关键元素齐全', p.missing.length === 0);
  check('popup: label[for=targetLang] 存在', p.labelOk === true);
  check('popup: 主按钮渐变样式生效', p.btnBg.includes('gradient'));
  check('popup: logo 渐变样式生效', p.logoBg.includes('gradient'));
  check('popup: 宽度 280px 布局', p.width === 280);
  check('popup: 无 JS 错误', p.errors.length === 0);
} catch (e) {
  console.log('✖ UI 验证异常:', e.message);
  failures++;
} finally {
  chrome.kill();
  console.log(failures === 0 ? '\nUI 验证全部通过' : `\nUI 验证失败 ${failures} 项`);
  process.exit(failures === 0 ? 0 : 1);
}

/* tests/e2e.mjs —— headless Chromium 端到端验证（真实扩展 + mock server 全流程）
   前置: mock server 已在 18080 运行（python3 tests/mock_server.py 18080）
   用法: node tests/e2e.mjs
*/
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const EXT = new URL('../src/', import.meta.url).pathname;
const CDP_PORT = 9233;
const TEST_URL = 'http://127.0.0.1:18080/';
const PROFILE = `/tmp/ai-trans-e2e-${Date.now()}`;

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
  const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
  return r.json();
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
  // 1. 等 CDP 端口就绪
  await waitFor(async () => {
    try { await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); return true; } catch { return false; }
  }, 15000);

  // 2. 等扩展 service worker 出现
  const swTarget = await waitFor(async () => {
    const ts = await getTargets();
    return ts.find((t) => t.type === 'service_worker' && t.url.includes('background.js'));
  }, 20000);
  const sw = new CDP(swTarget.webSocketDebuggerUrl);
  await sw.open();

  // 3. 写入配置:指向 mock server + 开启自动翻译
  const cfg = { baseUrl: 'http://127.0.0.1:18080/v1', apiKey: 'sk-test', model: 'mock-mini',
    targetLang: 'zh-CN', translateOnLoad: true, chunkSize: 1500, concurrency: 3 };
  await sw.call('Runtime.evaluate', {
    expression: `chrome.storage.local.set(${JSON.stringify(cfg)})`, awaitPromise: true, returnByValue: true
  });
  console.log('✔ storage 已写入(mock 配置 + 自动翻译)');

  // 4. 打开测试页(触发 content script 自动翻译)
  const pageTarget = await waitFor(async () => {
    const ts = await getTargets();
    return ts.find((t) => t.type === 'page');
  }, 10000);
  const page = new CDP(pageTarget.webSocketDebuggerUrl);
  await page.open();
  await page.call('Page.enable');
  await page.call('Page.navigate', { url: TEST_URL });

  // 5. 等快翻+润色完成(静态内容应显示为"润:译:xxx"——二次替换已发生)
  const innerText = await waitFor(async () => {
    const r = await page.call('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true });
    const t = (r.result && r.result.value) || '';
    return t.includes('润:译:Hello World') ? t : null;
  }, 25000, 500);

  check('快翻后润色二次替换(润:译:Hello World)', innerText.includes('润:译:Hello World'));
  check('段落被替换', innerText.includes('译:This is a test paragraph in English.'));
  check('链接文本被替换', innerText.includes('译:A link with some text'));
  check('translate=no 段落保持原样', innerText.includes('Do not translate this.') && !innerText.includes('译:Do not'));

  const href = (await page.call('Runtime.evaluate', { expression: 'document.querySelector("a").href', returnByValue: true })).result.value;
  check('链接 href 保留', href === 'https://example.com/');

  // iframe 内文本也被翻译(同源 iframe,主世界经 contentDocument 读取)
  const iframeText = await waitFor(async () => {
    const r = await page.call('Runtime.evaluate', {
      expression: `document.querySelector('iframe') && document.querySelector('iframe').contentDocument ? document.querySelector('iframe').contentDocument.body.innerText : ''`,
      returnByValue: true
    });
    const t = (r.result && r.result.value) || '';
    return t.includes('译:Text inside the iframe.') ? t : null;
  }, 15000, 500);
  check('iframe 内文本被翻译', !!iframeText);

  // 动态插入的内容(测试页 1.5s 后 appendChild)被 MutationObserver 捕获翻译
  const dynText = await waitFor(async () => {
    const r = await page.call('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true });
    const t = (r.result && r.result.value) || '';
    return t.includes('译:Dynamic content appears here.') ? t : null;
  }, 20000, 500);
  check('动态插入的内容被翻译', !!dynText);

  // 幂等:再次点击翻译,已翻译过的应全部跳过
  const second = await sw.call('Runtime.evaluate', {
    expression: `(async () => { const ts = await chrome.tabs.query({ url: 'http://127.0.0.1:18080/*' }); if (!ts.length) return null; return chrome.tabs.sendMessage(ts[0].id, { type: 'translate' }); })()`,
    awaitPromise: true, returnByValue: true
  });
  check('重复翻译:已翻译内容跳过(skipped=true)', !!(second.result && second.result.value && second.result.value.skipped === true));

  // 确认走了 SSE 流式(而非仅非流式路径)
  const stats = (await sw.call('Runtime.evaluate', {
    expression: `(async () => (await fetch('http://127.0.0.1:18080/stats')).json())()`,
    awaitPromise: true, returnByValue: true
  })).result.value;
  check('翻译请求走 SSE 流式(stream 计数 > 0)', !!(stats && stats.stream > 0));

  // 6. 恢复原文(从 SW 向测试页 content script 发 restore)
  await sw.call('Runtime.evaluate', {
    expression: `(async () => { const ts = await chrome.tabs.query({ url: 'http://127.0.0.1:18080/*' }); for (const t of ts) await chrome.tabs.sendMessage(t.id, { type: 'restore' }); return true; })()`,
    awaitPromise: true, returnByValue: true
  });
  await sleep(500);
  const restored = (await page.call('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true })).result.value;
  check('恢复原文生效(含动态内容,无译/润残留)', restored.includes('Hello World') && restored.includes('Dynamic content appears here.') && !restored.includes('译:') && !restored.includes('润:'));

  // 7. 模型列表接口
  const models = (await sw.call('Runtime.evaluate', {
    expression: `(async () => { const j = await (await fetch('http://127.0.0.1:18080/v1/models')).json(); return j.data.map((m) => m.id); })()`,
    awaitPromise: true, returnByValue: true
  })).result.value;
  check('模型列表接口返回 mock 模型', JSON.stringify(models) === JSON.stringify(['mock-mini', 'mock-large', 'mock-translate']));
} catch (e) {
  console.log('✖ E2E 异常:', e.message);
  failures++;
} finally {
  chrome.kill();
  console.log(failures === 0 ? '\nE2E 全部通过' : `\nE2E 失败 ${failures} 项`);
  process.exit(failures === 0 ? 0 : 1);
}

/* tests/diag-badge.mjs —— 诊断:翻译完成后 badge / lastProgress 的实际状态
   前置: mock server 在 18080
   用法: node tests/diag-badge.mjs [chunkSize]
*/
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const EXT = new URL('../src/', import.meta.url).pathname;
const CDP_PORT = 9236;
const TEST_URL = 'http://127.0.0.1:18080/';
const CHUNK = Number(process.argv[2]) || 2000;
const PROFILE = `/tmp/ai-trans-diag-${Date.now()}`;

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

try {
  await waitFor(async () => {
    try { await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); return true; } catch { return false; }
  }, 15000);
  const swTarget = await waitFor(async () => {
    const ts = await getTargets();
    return ts.find((t) => t.type === 'service_worker');
  }, 20000);
  const sw = new CDP(swTarget.webSocketDebuggerUrl);
  await sw.open();

  const cfg = { baseUrl: 'http://127.0.0.1:18080/v1', apiKey: 'sk-test', model: 'mock-mini',
    targetLang: 'zh-CN', translateOnLoad: true, chunkSize: CHUNK, concurrency: 3,
    translateDynamic: true, polishEnabled: true, polishChunkSize: 3000 };
  await sw.call('Runtime.evaluate', {
    expression: `chrome.storage.local.set(${JSON.stringify(cfg)})`, awaitPromise: true, returnByValue: true
  });

  const pageTarget = await waitFor(async () => {
    const ts = await getTargets();
    return ts.find((t) => t.type === 'page');
  }, 10000);
  const page = new CDP(pageTarget.webSocketDebuggerUrl);
  await page.open();
  await page.call('Page.enable');
  await page.call('Page.navigate', { url: TEST_URL });

  // 等翻译+润色完成
  await waitFor(async () => {
    const r = await page.call('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true });
    return ((r.result && r.result.value) || '').includes('润:译:Hello World');
  }, 25000, 500);

  const snap = async (label) => {
    const r = await sw.call('Runtime.evaluate', {
      expression: `(async () => {
        const ts = await chrome.tabs.query({ url: 'http://127.0.0.1:18080/*' });
        const t = ts[0];
        let badge = '';
        try { badge = await chrome.action.getBadgeText({ tabId: t.id }); } catch (e) { badge = 'ERR:' + e.message; }
        const prog = await chrome.storage.local.get('lastProgress');
        return { label: '${label}', badge, lastProgress: prog.lastProgress || null };
      })()`,
      awaitPromise: true, returnByValue: true
    });
    return r.result.value;
  };

  console.log('chunkSize =', CHUNK);
  console.log('T+0s (翻译+润色完成后):', JSON.stringify(await snap('t0'), null, 2));
  await sleep(6000);
  console.log('T+6s (进度时效过期后):', JSON.stringify(await snap('t6'), null, 2));

  // 再点一次翻译(应 skipped),观察 badge 变化
  const second = await sw.call('Runtime.evaluate', {
    expression: `(async () => { const ts = await chrome.tabs.query({ url: 'http://127.0.0.1:18080/*' }); return chrome.tabs.sendMessage(ts[0].id, { type: 'translate' }); })()`,
    awaitPromise: true, returnByValue: true
  });
  console.log('二次翻译响应:', JSON.stringify(second.result.value));
  await sleep(1000);
  console.log('T+二次翻译后:', JSON.stringify(await snap('after-2nd'), null, 2));
} catch (e) {
  console.log('诊断异常:', e.message);
} finally {
  chrome.kill();
  process.exit(0);
}

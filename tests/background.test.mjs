import { createRequire } from 'module';
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { spawn } from 'node:child_process';
const { fetchModels, chatCompletion, chatCompletionStream } = createRequire(import.meta.url)('../src/background.js');

const BASE = 'http://127.0.0.1:18080/v1';
let srv;

before(async () => {
  // 若已有实例在跑则直接复用，否则起一个
  try {
    const r = await fetch(BASE + '/models');
    if (r.ok) return;
  } catch (e) { /* fallthrough */ }
  srv = spawn('python3', ['tests/mock_server.py', '18080', '0.05'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 500));
});
after(() => srv && srv.kill());

test('fetchModels 拉取模型列表', async () => {
  const r = await fetchModels(BASE, 'sk-test');
  assert.equal(r.ok, true);
  assert.deepEqual(r.models, ['mock-mini', 'mock-large', 'mock-translate']);
});

test('chatCompletion 返回带哨兵译文', async () => {
  const text = await chatCompletion(BASE, 'sk-test', 'mock-mini',
    [{ role: 'user', content: '\u27e60\u27e7Hello\u27e61\u27e7world' }]);
  assert.equal(text, '\u27e60\u27e7译:Hello\u27e61\u27e7译:world');
});

test('chatCompletionStream SSE 流式:多次 partial 且最终内容完整', async () => {
  let partials = 0;
  const text = await chatCompletionStream(BASE, 'sk-test', 'mock-mini',
    [{ role: 'user', content: '\u27e60\u27e7Hello\u27e61\u27e7world' }], () => { partials++; });
  assert.equal(text, '\u27e60\u27e7译:Hello\u27e61\u27e7译:world');
  assert.ok(partials > 3, '应收到多次 partial 推送');
});

test('fetchModels 401 映射为 key 无效', async () => {
  const r = await fetchModels('http://127.0.0.1:19999/v1', 'sk-test'); // 无监听端口 -> 网络错误
  assert.equal(r.ok, false);
  assert.match(r.error, /网络错误|无法获取/);
});

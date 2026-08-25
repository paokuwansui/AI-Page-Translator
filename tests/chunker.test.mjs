import { createRequire } from 'module';
import assert from 'node:assert/strict';
import { test } from 'node:test';
const { buildChunks, makeChunkText, parseChunkText, extractCompleteSegs } = createRequire(import.meta.url)('../src/content/chunker.js');

test('buildChunks 按预算切片', () => {
  const nodes = [{ nodeValue: 'a'.repeat(900) }, { nodeValue: 'b'.repeat(900) }, { nodeValue: 'c'.repeat(100) }];
  const chunks = buildChunks([{ nodes }], 1500);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].length, 1);
  assert.equal(chunks[1].length, 2);
});

test('makeChunkText / parseChunkText 往返', () => {
  const nodes = [{ nodeValue: 'Hello' }, { nodeValue: 'world' }];
  const text = makeChunkText(nodes);
  assert.deepEqual(parseChunkText(text.replace('Hello', '你好').replace('world', '世界')), ['你好', '世界']);
});

test('parseChunkText 拒绝格式错误', () => {
  assert.equal(parseChunkText('没有哨兵'), null);
  assert.equal(parseChunkText('开头多余\u27E60\u27E7hi'), null);  // 前缀非法
  assert.equal(parseChunkText('\u27E60\u27E7hi\u27E61\u27E7'), null);  // 以完整哨兵结尾 = 丢段
  assert.equal(parseChunkText('\u27E60\u27E7'), null);            // 空译文段
});

test('parseChunkText 返回段数组(段数由调用方比对)', () => {
  assert.deepEqual(parseChunkText('\u27E60\u27E7只有一段'), ['只有一段']);
});

test('extractCompleteSegs 流式增量:只返回已完整段', () => {
  // 仅一段文本,流未结束(尾部无新哨兵) -> 保守不返回
  assert.deepEqual(extractCompleteSegs('\u27E60\u27E7你好'), []);
  // 段0完整(段1已开始,尾部是新哨兵)
  assert.deepEqual(extractCompleteSegs('\u27E60\u27E7你好\u27E61\u27E7世'), [{ idx: 0, text: '你好' }]);
  // 两段都闭合但最后一段后无新哨兵 -> 只返回段0,段1等流结束
  assert.deepEqual(extractCompleteSegs('\u27E60\u27E7你好\u27E61\u27E7世界'), [{ idx: 0, text: '你好' }]);
  // 新段刚出现(⟦2⟧ 无文本) -> 段2 未完成,只返回前两段
  assert.deepEqual(extractCompleteSegs('\u27E60\u27E7你好\u27E61\u27E7世界\u27E62\u27E7'),
    [{ idx: 0, text: '你好' }, { idx: 1, text: '世界' }]);
  assert.deepEqual(extractCompleteSegs(''), []);
});

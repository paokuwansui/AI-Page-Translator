import { createRequire } from 'module';
import assert from 'node:assert/strict';
import { test } from 'node:test';
const { normBase, defaultSettings } = createRequire(import.meta.url)('../src/lib/common.js');

test('normBase 去尾部斜杠、空值回退默认', () => {
  assert.equal(normBase('https://api.deepseek.com/'), 'https://api.deepseek.com');
  assert.equal(normBase('  '), defaultSettings.baseUrl);
});

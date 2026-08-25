/* lib/common.js —— 跨页面共享工具（content/popup/options/background 共用） */
'use strict';
const Lib = (() => {
  const DEFAULT_BASE = 'https://api.openai.com/v1';
  const storageGet = (keys) => new Promise((r) => chrome.storage.local.get(keys, r));
  const storageSet = (obj) => new Promise((r) => chrome.storage.local.set(obj, r));
  const sendMsg = (msg) => new Promise((r) => chrome.runtime.sendMessage(msg, r));
  const normBase = (base) => { const b = (base || '').trim().replace(/\/+$/, ''); return b || DEFAULT_BASE; };
  const defaultSettings = {
    baseUrl: DEFAULT_BASE, apiKey: '', model: 'gpt-4o-mini',
    sourceLang: 'auto', targetLang: 'zh-CN',
    chunkSize: 2000, concurrency: 3, translateOnLoad: false,
    translateDynamic: true, polishEnabled: true, polishChunkSize: 3000
  };
  const loadSettings = async () => Object.assign({}, defaultSettings, await storageGet(null));
  return { DEFAULT_BASE, storageGet, storageSet, sendMsg, normBase, defaultSettings, loadSettings };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Lib;
else globalThis.Lib = Lib;

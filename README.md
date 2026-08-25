# LinguaFlow — AI 整页翻译浏览器扩展

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

基于 OpenAI 兼容 API 的整页翻译扩展:**SSE 流式快翻 + 统一润色**,把网页文本就地替换为目标语言(如中文),保留页面结构、链接与样式。一套代码兼容 Chrome / Edge / Firefox(Manifest V3)。

## 特性

- **两阶段翻译**:快翻阶段分块并发 + SSE 流式输出,译文边生成边逐段显示;完成后自动进入润色阶段,全部译文合批交给 AI 统一措辞,二次替换,popup 状态栏实时显示「翻译中 / 润色中」
- **直接替换页面文本**:只改文本节点,不破坏 DOM 结构 / 链接 / 样式,支持一键恢复原文
- **幂等**:重复点击「翻译此页」只翻译新增内容,已翻译的自动跳过
- **动态内容**:页面后续加载/插入的文本(MutationObserver)自动翻译,适配 SPA
- **同源 iframe** 内容同步翻译
- **自定义 API**:API Key / Base URL / 模型名称均可配置,模型列表一键自动获取(`GET {base}/models`)
- **Base URL 容错**:不含 `/v1` 自动补试;Key 留空时不携带 Authorization(适配 Ollama 等本地服务)
- **跳过不翻译**:`code/pre/script/style`、隐藏元素、`translate="no"`、`.notranslate`、输入控件
- **隐私**:API Key 仅存浏览器本地 storage(不同步云端),请求只发往你填写的 Base URL

## 安装(开发模式)

- **Chrome / Edge**:`chrome://extensions`(或 `edge://extensions`)→ 开启「开发者模式」→「加载已解压的扩展程序」→ 选择 `src/` 目录
- **Firefox**:`about:debugging#/runtime/this-firefox` →「临时载入附加组件」→ 选择 `src/manifest.json`

## 配置

打开扩展设置页(popup 底部「打开设置」):

| 配置 | 说明与示例 |
|---|---|
| Base URL | OpenAI: `https://api.openai.com/v1`<br>DeepSeek: `https://api.deepseek.com`(自动补 /v1)<br>Moonshot: `https://api.moonshot.cn/v1`<br>通义千问: `https://dashscope.aliyuncs.com/compatible-mode/v1`<br>Ollama(本地): `http://127.0.0.1:11434/v1`(Key 留空)<br>one-api 等中转: 你的网关地址 |
| API Key | 对应服务密钥;Ollama 等本地服务留空 |
| 模型名称 | 手动输入,或点「获取模型列表」自动拉取后选择 |
| 每请求字符数 | 默认 2000,一般无需调整 |
| 并发请求数 | 默认 3,可调 1-8(注意服务端限流) |
| 翻译后统一润色 | 默认开启;关闭可省一轮请求 |

填好后点「测试连接」验证,再「保存」。

## 使用

1. 打开任意网页,点工具栏 LinguaFlow 图标 →「翻译此页」
2. 进度显示在工具栏 badge 与 popup(「翻译中 x%」→「润色中 x%」→「完成」)
3. 「恢复原文」还原;「停止」中止(已翻译部分保留)
4. 设置里可开启「页面加载后自动翻译」与「翻译动态加载的内容」

## 技术架构

```
┌─────────────┐  runtime 消息  ┌──────────────┐   fetch(SSE)   ┌──────────────────┐
│ content.js  │ ◄────────────► │ background.js│ ◄────────────► │ OpenAI 兼容 API  │
│ 抽文本/回填  │  Port 流式推送  │  API 调用层    │                │ /models /chat    │
└─────────────┘                └──────────────┘                └──────────────────┘
┌──────────────────────────────────────────────────────────────────────────────┐
│ popup(翻译/恢复/停止/状态)  options(API 配置/模型列表)  chrome.storage.local │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **哨兵分块**:文本节点按字符预算分块,块内节点用 `⟦i⟧` 哨兵拼接为一次请求;模型须原样保留哨兵,响应按哨兵切回逐节点回填
- **流式渲染**:`stream: true` + SSE,后台按段边界推送 partial,内容端「段完整即显示」
- **容错**:格式不符自动降级(未覆盖节点并发单请求);润色失败保留现有译文
- **多浏览器**:MV3 单 manifest(`browser_specific_settings` 仅 Firefox 读取,Chromium 忽略),统一使用 `chrome.*` API

## 本地开发

```bash
node --test 'tests/*.test.mjs'        # 单元测试(chunker/common/background)
node tests/e2e.mjs                    # 端到端:headless Chromium 真实加载扩展 + mock server 全流程
node tests/verify-ui.mjs              # UI 页面验证:元素/a11y/样式/无 JS 错误
node tests/diag-badge.mjs 2000        # 诊断:翻译完成后 badge / 进度字段状态
python3 tests/mock_server.py 18080    # OpenAI 兼容 mock server(不消耗真实额度)
./build.sh                            # 打包 dist/{chrome,edge,firefox}.zip
```

mock server 地址 `http://127.0.0.1:18080/v1`、Key 任意、模型 `mock-mini`,配合 `http://127.0.0.1:18080/` 测试页可完整联调(含流式/润色/动态内容)。

## 已知限制

- 同源 iframe 支持翻译;跨域 iframe 受浏览器安全策略限制无法注入
- `chrome://`、浏览器商店等受保护页面无法注入
- 动态内容的恢复依赖节点仍在页面中;被框架完全重绘的节点按新内容重新翻译
- 超大页面消耗较多 token;遇限流(429)会提示稍后重试

## License

[MIT](LICENSE)

#!/usr/bin/env python3
"""OpenAI 兼容 mock API server —— 本地联调用。
用法: python3 tests/mock_server.py [port=18080] [delay=0.3]
行为:
  GET  /                         -> 英文测试页（供浏览器 e2e）
  GET  /v1/models                -> 模型列表
  POST /v1/chat/completions      -> 在每个哨兵段文本前插 "译:" 原样返回（保留 ⟦i⟧ 哨兵）
"""
import json, re, sys, time
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 18080
DELAY = float(sys.argv[2]) if len(sys.argv) > 2 else 0.3
MODELS = ["mock-mini", "mock-large", "mock-translate"]
COUNTERS = {"stream": 0, "plain": 0}

TEST_PAGE = """<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Mock Test Page</title></head>
<body>
  <h1>Hello World</h1>
  <p>This is a test paragraph in English.</p>
  <div><a href="https://example.com">A link with some text</a></div>
  <p translate="no">Do not translate this.</p>
  <p>Another sentence here. And one more sentence for good measure.</p>
  <iframe src="/frame.html" style="width:400px;height:120px"></iframe>
  <script>
    setTimeout(function () {
      var p = document.createElement('p');
      p.textContent = 'Dynamic content appears here.';
      document.body.appendChild(p);
    }, 1500);
  </script>
</body>
</html>
"""

FRAME_PAGE = """<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Frame Page</title></head>
<body>
  <p>Text inside the iframe.</p>
</body>
</html>
"""


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, ctype, body):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code, obj):
        self._send(code, "application/json", json.dumps(obj).encode())

    def do_GET(self):
        p = self.path.rstrip("/")
        if p == "" or p == "/":
            self._send(200, "text/html; charset=utf-8", TEST_PAGE.encode())
        elif p == "/frame.html":
            self._send(200, "text/html; charset=utf-8", FRAME_PAGE.encode())
        elif p == "/stats":
            self._json(200, COUNTERS)
        elif p.endswith("/models"):
            self._json(200, {"object": "list", "data": [{"id": m} for m in MODELS]})
        else:
            self._json(404, {"error": {"message": "not found"}})

    def do_POST(self):
        if not self.path.rstrip("/").endswith("/chat/completions"):
            return self._json(404, {"error": {"message": "not found"}})
        time.sleep(DELAY)
        n = int(self.headers.get("Content-Length", 0))
        req = json.loads(self.rfile.read(n) or b"{}")
        msgs = req.get("messages", [])
        user = msgs[-1].get("content", "") if msgs else ""
        # 模拟真实模型:只处理数据区(prompt 之后的部分),每个哨兵段前插前缀(翻译"译:"/润色"润:"),保留哨兵
        data = user.rsplit("\n\n", 1)[1] if "\n\n" in user else user
        prefix = "润:" if "polish" in user.lower() else "译:"
        out = re.sub(r"(\u27e6\d+\u27e7)([^\u27e6]*)",
                     lambda m: m.group(1) + prefix + m.group(2), data)
        if "\u27e6" not in out:
            out = prefix + user
        stream = bool(req.get("stream"))
        if stream:
            # SSE 流式:逐字符分片推送(模拟真实流式输出)
            COUNTERS["stream"] += 1
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self.end_headers()
            for ch in out:
                frame = {"choices": [{"delta": {"content": ch}}]}
                self.wfile.write(("data: " + json.dumps(frame, ensure_ascii=False) + "\n\n").encode("utf-8"))
                self.wfile.flush()
                time.sleep(0.001)
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
            self.close_connection = True
        else:
            COUNTERS["plain"] += 1
            self._json(200, {"id": "mock", "object": "chat.completion",
                             "choices": [{"index": 0, "message": {"role": "assistant", "content": out},
                                          "finish_reason": "stop"}]})


if __name__ == "__main__":
    print(f"mock OpenAI server on :{PORT} (delay={DELAY}s)")
    HTTPServer(("127.0.0.1", PORT), H).serve_forever()

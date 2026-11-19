#!/usr/bin/env bash
# 打包 Chrome/Edge/Firefox 三份 zip（MV3 单 manifest 兼容，内容一致）
set -euo pipefail
cd "$(dirname "$0")"
rm -rf dist && mkdir -p dist
BUILD_STAMP="$(date +%Y%m%d-%H%M)"       # 构建标记:面板/设置页显示,方便确认"我加载的是不是最新代码"
for t in chrome edge firefox; do
  mkdir -p "dist/$t"
  cp -r src/. "dist/$t/"
  python3 - "$t" "$BUILD_STAMP" <<'PY'
import json, sys
p = "dist/%s/manifest.json" % sys.argv[1]
d = json.load(open(p, encoding="utf-8"))
d["version_name"] = sys.argv[2]
json.dump(d, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
open(p, "a", encoding="utf-8").write("\n")
PY
  if [ "$t" = "firefox" ]; then
    # Firefox 没有 sidePanel API:剔掉权限与 side_panel 键,避免"未知权限"警告(代码里有能力探测自动回退页内面板)
    python3 - "$t" <<'PY'
import json, sys
p = "dist/%s/manifest.json" % sys.argv[1]
d = json.load(open(p, encoding="utf-8"))
d["permissions"] = [x for x in d.get("permissions", []) if x != "sidePanel"]
d.pop("side_panel", None)
json.dump(d, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
open(p, "a", encoding="utf-8").write("\n")
PY
  fi
  (cd "dist/$t" && zip -qr "../$t.zip" .)
  echo "dist/$t.zip done"
done

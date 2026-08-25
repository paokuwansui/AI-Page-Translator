#!/usr/bin/env bash
# 打包 Chrome/Edge/Firefox 三份 zip（MV3 单 manifest 兼容，内容一致）
set -euo pipefail
cd "$(dirname "$0")"
rm -rf dist && mkdir -p dist
for t in chrome edge firefox; do
  mkdir -p "dist/$t"
  cp -r src/. "dist/$t/"
  (cd "dist/$t" && zip -qr "../$t.zip" .)
  echo "dist/$t.zip done"
done

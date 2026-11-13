#!/usr/bin/env bash
# 完整打包：先构建前端，再用 Tauri 打包桌面应用（macOS .app / .dmg）
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v cargo >/dev/null 2>&1; then
  echo "错误：未找到 cargo，请先安装 Rust" >&2
  exit 1
fi

if ! command -v npx >/dev/null 2>&1; then
  echo "错误：未找到 npx，请先安装 Node.js" >&2
  exit 1
fi

echo "=== ReadingBook：完整打包 ==="
echo "步骤 1/2：构建前端"
npx vite build

echo "步骤 2/2：Tauri 打包桌面应用"
npx tauri build

echo "打包完成：src-tauri/target/release/bundle/"

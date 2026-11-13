#!/usr/bin/env bash
# 开发模式启动：前端 Vite + Tauri 后端，带热重载
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

echo "=== ReadingBook：开发模式启动 ==="
echo "前端：http://localhost:5173"
echo ""

npx tauri dev

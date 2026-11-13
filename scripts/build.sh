#!/usr/bin/env bash
# 仅编译前端（Vite 生产构建），输出到 dist/
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v npx >/dev/null 2>&1; then
  echo "错误：未找到 npx，请先安装 Node.js" >&2
  exit 1
fi

echo "=== ReadingBook：前端构建 ==="
npx vite build
echo "构建完成：dist/"

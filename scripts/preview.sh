#!/usr/bin/env bash
# 本地预览已构建的前端产物（dist/），用于上线前检查
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v npx >/dev/null 2>&1; then
  echo "错误：未找到 npx，请先安装 Node.js" >&2
  exit 1
fi

if [ ! -d "dist" ]; then
  echo "dist/ 不存在，先运行 ./scripts/build.sh 构建" >&2
  exit 1
fi

echo "=== ReadingBook：预览构建产物 ==="
npx vite preview

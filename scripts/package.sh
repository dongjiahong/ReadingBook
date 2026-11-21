#!/usr/bin/env bash
# 完整打包：先构建前端，用 Tauri 生成 .app，再用 hdiutil 直接打只读压缩 .dmg（避免 Finder/AppleScript 弹窗卡住）
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

VERSION=$(node -p "require('./package.json').version")
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
  ARCH="aarch64"
fi

echo "=== ReadingBook v${VERSION}：完整打包 ==="
echo "步骤 1/3：构建前端"
npx vite build

echo "步骤 2/3：Tauri 构建 .app"
npx tauri build --bundles app

echo "步骤 3/3：使用 hdiutil 生成只读压缩 .dmg"
APP_PATH="src-tauri/target/release/bundle/macos/ReadingBook.app"
DMG_DIR="src-tauri/target/release/bundle/dmg"
DMG_PATH="${DMG_DIR}/ReadingBook_${VERSION}_${ARCH}.dmg"

mkdir -p "$DMG_DIR"
STAGING=$(mktemp -d)
trap 'rm -rf "$STAGING"' EXIT

cp -R "$APP_PATH" "$STAGING/"
ln -s /Applications "$STAGING/Applications"
hdiutil create -volname "ReadingBook" -srcfolder "$STAGING" -ov -format UDZO "$DMG_PATH"

echo "打包完成：${DMG_PATH}"

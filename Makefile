.DEFAULT_GOAL := help

SHELL := /usr/bin/env bash
.SHELLFLAGS := -euo pipefail -c

export PATH := $(HOME)/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$(PATH)

# Version input: supports v=0.4.3, v=v0.4.3, V=0.4.3, VERSION=0.4.3
RAW_VER := $(or $(v),$(V),$(VERSION))
VER := $(patsubst v%,%,$(RAW_VER))

# Current version from package.json
CUR_VER := $(shell sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' package.json 2>/dev/null | head -n 1)

# Host architecture (matches scripts/package.sh)
UNAME_M := $(shell uname -m)
ARCH := $(if $(filter arm64,$(UNAME_M)),aarch64,$(UNAME_M))

# Release options
ANDROID ?= 1
NOTES ?=
ADB ?=

APP_BUNDLE := src-tauri/target/release/bundle/macos/ReadingBook.app
DMG_DIR := src-tauri/target/release/bundle/dmg
APP_ZIP := /tmp/ReadingBook.app.zip

.PHONY: help version dev check build preview mac dmg android android-install package bump release clean clean-all

help: ## 显示可用命令与示例
	@echo "ReadingBook Makefile (当前版本: v$(CUR_VER))"
	@echo ""
	@echo "常用命令:"
	@grep -E '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "示例:"
	@echo "  make dev                                # 启动桌面开发模式"
	@echo "  make check                              # 前端 TS + Rust 编译检查"
	@echo "  make mac                                # 打包 macOS .dmg 与 .app.zip"
	@echo "  make android                            # 打包并签名 Android Release APK"
	@echo "  make android-install                    # 打包并安装到已连接 ADB 设备"
	@echo "  make android-install ADB=192.168.1.50:5555"
	@echo "  make bump v=0.4.3                       # 仅同步三处版本号"
	@echo "  make release v=0.4.3                    # 一键发版（macOS + Android + Tag + GitHub Release）"
	@echo "  make release v=0.4.3 ANDROID=0          # 一键发版（仅 macOS，跳过 Android）"
	@echo "  make release v=0.4.3 NOTES=notes.md     # 使用自定义 Release 说明发版"

version: ## 查看当前各文件版本号与最新 Git 标签
	@echo "package.json              : $$(node -p "require('./package.json').version")"
	@echo "src-tauri/tauri.conf.json : $$(node -p "require('./src-tauri/tauri.conf.json').version")"
	@echo "src-tauri/Cargo.toml      : $$(sed -n '/^\[package\]/,/^\[/{s/^version *= *"\([^"]*\)".*/\1/p;}' src-tauri/Cargo.toml | head -n 1)"
	@echo "Latest git tag            : $$(git describe --tags --abbrev=0 2>/dev/null || echo 'none')"

dev: ## 启动桌面开发模式（Vite + Tauri 热重载）
	@./scripts/dev.sh

check: ## 运行 TypeScript 类型检查与 Rust cargo check
	@echo "=== TypeScript 检查 ==="
	@npx tsc -b
	@echo "=== Rust cargo check ==="
	@cargo check --manifest-path src-tauri/Cargo.toml

build: ## 前端类型检查并构建 dist/
	@npx tsc -b
	@npm run build

preview: ## 本地预览已构建的前端产物
	@./scripts/preview.sh

mac: dmg ## 打包 macOS .app、.dmg 及 /tmp/ReadingBook.app.zip

dmg: ## 打包 macOS .app、.dmg（hdiutil）并生成 .app.zip
	@./scripts/package.sh
	@rm -f "$(APP_ZIP)"
	@echo "=== 压缩 macOS .app -> $(APP_ZIP) ==="
	@ditto -c -k --keepParent "$(APP_BUNDLE)" "$(APP_ZIP)"
	@echo "完成："
	@echo "  - $(DMG_DIR)/ReadingBook_$$(node -p "require('./package.json').version")_$(ARCH).dmg"
	@echo "  - $(APP_ZIP)"

android: ## 打包并签名 Android arm64 Release APK
	@./scripts/build-android.sh

android-install: ## 打包签名 Android Release APK 并通过 ADB 安装启动（可选 ADB=ip:port）
	@if [[ -n "$(ADB)" ]]; then \
		./scripts/build-android.sh --install "$(ADB)"; \
	else \
		./scripts/build-android.sh --install; \
	fi

package: mac android ## 同时打包 macOS 与 Android 安装包（不提交、不发版）

bump: ## 同步更新三处版本号（用法: make bump v=0.4.3）
	@if [[ -z "$(VER)" ]]; then \
		echo "错误：请指定版本号，例如：make bump v=0.4.3" >&2; \
		exit 1; \
	fi
	@if [[ ! "$(VER)" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.]+)?$$ ]]; then \
		echo "错误：版本号格式不正确：$(VER)（示例：0.4.3）" >&2; \
		exit 1; \
	fi
	@node -e ' \
		const fs = require("fs"); \
		const v = process.argv[1]; \
		for (const f of ["package.json", "src-tauri/tauri.conf.json"]) { \
			const raw = fs.readFileSync(f, "utf8"); \
			const next = raw.replace(/"version"\s*:\s*"[^"]+"/, `"version": "$${v}"`); \
			if (next === raw && !raw.includes(`"version": "$${v}"`)) { \
				throw new Error(`无法更新 $${f} 中的版本号`); \
			} \
			fs.writeFileSync(f, next); \
		} \
		const cargoPath = "src-tauri/Cargo.toml"; \
		const cargo = fs.readFileSync(cargoPath, "utf8"); \
		const nextCargo = cargo.replace(/(\[package\][\s\S]*?\nversion\s*=\s*")[^"]+(")/, `$$1$${v}$$2`); \
		const escaped = v.replace(/[.*+?^$${}()|[\]\\]/g, "\\$$&"); \
		if (nextCargo === cargo && !new RegExp(`\\[package\\][\\s\\S]*?\\nversion\\s*=\\s*"$${escaped}"`).test(cargo)) { \
			throw new Error("无法更新 src-tauri/Cargo.toml 中的版本号"); \
		} \
		fs.writeFileSync(cargoPath, nextCargo); \
	' "$(VER)"
	@echo "已将三处版本号更新为 $(VER)："
	@$(MAKE) --no-print-directory version

release: ## 一键发版（用法: make release v=0.4.3 [ANDROID=0] [NOTES=notes.md]）
	@if [[ -z "$(VER)" ]]; then \
		echo "错误：请指定版本号，例如：make release v=0.4.3" >&2; \
		exit 1; \
	fi
	@if [[ ! "$(VER)" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.]+)?$$ ]]; then \
		echo "错误：版本号格式不正确：$(VER)（示例：0.4.3）" >&2; \
		exit 1; \
	fi
	@if ! command -v gh >/dev/null 2>&1; then \
		echo "错误：未找到 gh CLI，请先安装 GitHub CLI（brew install gh）" >&2; \
		exit 1; \
	fi
	@if [[ -n "$$(git status --porcelain)" ]]; then \
		echo "错误：当前 git 工作区有未提交改动，请先提交或暂存后再发版。" >&2; \
		git status -sb >&2; \
		exit 1; \
	fi
	@if git rev-parse -q --verify "refs/tags/v$(VER)" >/dev/null; then \
		echo "错误：Git 标签 v$(VER) 已存在。" >&2; \
		exit 1; \
	fi
	@if [[ -n "$(NOTES)" && ! -f "$(NOTES)" ]]; then \
		echo "错误：指定的 NOTES 文件不存在：$(NOTES)" >&2; \
		exit 1; \
	fi
	@PREV_TAG=$$(git describe --tags --abbrev=0 2>/dev/null || true); \
	echo "=== [1/6] 同步三处版本号 -> $(VER) ==="; \
	$(MAKE) --no-print-directory bump v="$(VER)"; \
	echo "=== [2/6] 前端类型检查与构建 ==="; \
	npx tsc -b && npm run build; \
	echo "=== [3/6] 打包 macOS .dmg 与 .app.zip ==="; \
	$(MAKE) --no-print-directory dmg; \
	DMG_PATH="$(DMG_DIR)/ReadingBook_$(VER)_$(ARCH).dmg"; \
	if [[ ! -f "$$DMG_PATH" ]]; then \
		echo "错误：未找到 macOS 安装包 $$DMG_PATH" >&2; \
		exit 1; \
	fi; \
	ASSETS=("$$DMG_PATH" "$(APP_ZIP)"); \
	APK_RELEASE_PATH="/tmp/ReadingBook_$(VER)_android_arm64.apk"; \
	if [[ "$(ANDROID)" == "1" ]]; then \
		echo "=== [4/6] 打包并签名 Android Release APK ==="; \
		./scripts/build-android.sh; \
		SIGNED_APK=$$(find src-tauri/gen/android/app/build/outputs/apk -path '*/release/*-signed.apk' -type f | head -n 1 || true); \
		if [[ -z "$$SIGNED_APK" || ! -f "$$SIGNED_APK" ]]; then \
			echo "错误：未找到签名后的 Android Release APK" >&2; \
			exit 1; \
		fi; \
		cp "$$SIGNED_APK" "$$APK_RELEASE_PATH"; \
		ASSETS+=("$$APK_RELEASE_PATH"); \
	else \
		echo "=== [4/6] 已跳过 Android 打包（ANDROID=$(ANDROID)） ==="; \
	fi; \
	echo "=== [5/6] 提交版本变更、打标签并推送 ==="; \
	git add package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json; \
	if [[ -n "$$(git status --porcelain src-tauri/Cargo.lock)" ]]; then \
		git add src-tauri/Cargo.lock; \
	fi; \
	if ! git diff --cached --quiet; then \
		git commit -m "chore(release): bump version to $(VER)"; \
	fi; \
	BRANCH=$$(git rev-parse --abbrev-ref HEAD); \
	git tag "v$(VER)"; \
	git push origin "$$BRANCH"; \
	git push origin "v$(VER)"; \
	echo "=== [6/6] 创建 GitHub Release v$(VER) ==="; \
	NOTES_FILE="$(NOTES)"; \
	TEMP_NOTES=""; \
	if [[ -z "$$NOTES_FILE" ]]; then \
		TEMP_NOTES="/tmp/readingbook-release-notes-$(VER).md"; \
		NOTES_FILE="$$TEMP_NOTES"; \
		{ \
			echo "ReadingBook $(VER)"; \
			echo ""; \
			if [[ -n "$$PREV_TAG" ]]; then \
				git log "$${PREV_TAG}..HEAD" --no-merges --grep='^chore(release):' --invert-grep --pretty=format:'- %s'; \
				echo ""; \
			else \
				echo "- 发布 v$(VER)"; \
			fi; \
			echo ""; \
			echo "安装包："; \
			echo "- ReadingBook_$(VER)_$(ARCH).dmg（macOS 推荐，拖拽安装）"; \
			echo "- ReadingBook.app.zip（macOS 免挂载包）"; \
			if [[ "$(ANDROID)" == "1" ]]; then \
				echo "- ReadingBook_$(VER)_android_arm64.apk（Android Release 签名包）"; \
			fi; \
		} > "$$NOTES_FILE"; \
	fi; \
	gh release create "v$(VER)" \
		--title "ReadingBook $(VER)" \
		--notes-file "$$NOTES_FILE" \
		"$${ASSETS[@]}"; \
	[[ -n "$$TEMP_NOTES" ]] && rm -f "$$TEMP_NOTES"; \
	echo "=== 发版完成：v$(VER) ==="

clean: ## 清理前端构建产物与临时打包文件
	@rm -rf dist /tmp/ReadingBook.app.zip /tmp/ReadingBook_*_android_arm64.apk
	@echo "已清理 dist/ 与临时打包文件。"

clean-all: clean ## 彻底清理（含 Rust src-tauri/target 缓存）
	@rm -rf src-tauri/target
	@echo "已清理 src-tauri/target/。"

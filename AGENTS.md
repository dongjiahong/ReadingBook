# AGENTS.md

本文件是给 AI 编码助手看的工作约定，优先级高于通用习惯。

## 发版规则（用户明确要求，不要每次再问）

**打包版本必须与 Release 版本完全一致**：Git 标签、Release 标题、安装包文件名三处版本号相同。

发版前先把下面三处的 `version` 改成同一个目标版本（例如 `0.1.6`）：

- `package.json` → `version`
- `src-tauri/Cargo.toml` → `[package] version`
- `src-tauri/tauri.conf.json` → `version`

改完再打包，否则 dmg 会沿用旧版本号（例如发 v0.1.6 却产出 `ReadingBook_0.1.0_aarch64.dmg`，这是不允许的）。

### 标准流程

```sh
# 1. 改三处版本号后校验
npx tsc -b && npm run build

# 2. 打包（产出 .app 与 dmg，文件名应带新版本号）
npm run tauri build
#    src-tauri/target/release/bundle/macos/ReadingBook.app
#    src-tauri/target/release/bundle/dmg/ReadingBook_<版本>_aarch64.dmg

# 3. 压缩 .app 作为第二个产物
ditto -c -k --keepParent \
  src-tauri/target/release/bundle/macos/ReadingBook.app \
  /tmp/ReadingBook.app.zip

# 4. 提交、打标签、推送
git tag v<版本>
git push origin main
git push origin v<版本>

# 5. 建 Release（标题格式固定）
gh release create v<版本> --title "ReadingBook <版本>" --notes-file <notes.md> \
  src-tauri/target/release/bundle/dmg/ReadingBook_<版本>_aarch64.dmg \
  /tmp/ReadingBook.app.zip
```

### Release 正文格式

```
ReadingBook <版本>

- 本次改动 1
- 本次改动 2

安装包：
- ReadingBook_<版本>_aarch64.dmg（推荐，拖拽安装）
- ReadingBook.app.zip
```

## 验证要求

- 提交前跑 `npx tsc -b`；涉及渲染/打包时再跑 `npm run build`。
- 涉及界面改动的，尽量在真机窗口里点一遍（`npm run tauri dev`）。
- 需要在自己的实例里试操作真实书库时，把 `~/Library/Application Support/com.readingbook.app`
  复制到临时目录并用 `HOME=<临时目录> ./src-tauri/target/debug/app` 启动，避免改动用户数据。

## 已知约定

- `AnnotationCardItem.collapsed` 与卡片位置一起存在 `book_annotations.cards_json`，老数据缺字段视为展开，不做迁移。
- 卡片摆放统一走 `src/utils/cardPlacement.ts` 的 `nearestFreeY`：不冲突不动，冲突时按 `prefer` 决定往上还是就近。

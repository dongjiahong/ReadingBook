# AGENTS.md

本文件是给 AI 编码助手看的工作约定，优先级高于通用习惯。

## 发版规则（用户明确要求，不要每次再问）

**打包版本必须与 Release 版本完全一致**：Git 标签、Release 标题、安装包文件名三处版本号相同。

发版前先把下面三处的 `version` 改成同一个目标版本（例如 `0.4.0`）：

- `package.json` → `version`
- `src-tauri/Cargo.toml` → `[package] version`
- `src-tauri/tauri.conf.json` → `version`

改完再打包，否则 dmg 会沿用旧版本号（例如发 v0.4.0 却产出旧版 dmg，这是不允许的）。

### Android 打包硬性约定

- **Android 打包一律使用 Release 模式，不用 Debug**（`./scripts/build-android.sh` 已默认构建并签名 arm64 release APK，包名 `com.readingbook.app`，签名密钥固定保存在 `~/.readingbook-android-release.jks`）。
- 打包前会自动从 `readingbook.png` 同步 Android `mipmap-*` 图标。

### 标准发版流程

```sh
# 1. 改三处版本号并同步文档后校验
npx tsc -b && npm run build

# 2. 打包 macOS（产出 .app 与 dmg，文件名应带新版本号）
npm run tauri build
#    src-tauri/target/release/bundle/macos/ReadingBook.app
#    src-tauri/target/release/bundle/dmg/ReadingBook_<版本>_aarch64.dmg

# 3. 压缩 .app 作为第二个产物
ditto -c -k --keepParent \
  src-tauri/target/release/bundle/macos/ReadingBook.app \
  /tmp/ReadingBook.app.zip

# 4. 打包并签名 Android Release APK（可选附带到 Release）
./scripts/build-android.sh
#    src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned-signed.apk

# 5. 提交、打标签、推送
git tag v<版本>
git push origin main
git push origin v<版本>

# 6. 建 Release（标题格式固定）
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
- ReadingBook_<版本>_aarch64.dmg（macOS 推荐，拖拽安装）
- ReadingBook.app.zip（macOS 免挂载包）
- ReadingBook_<版本>_android_arm64.apk（Android Release 签名包，如有附带）
```

## 验证要求

- 提交前跑 `npx tsc -b`；涉及渲染/打包时再跑 `npm run build`。
- 每个阶段完成后及时 `git commit`，方便随时回滚。
- 涉及界面改动的，尽量在真机窗口里点一遍（`npm run tauri dev` / `./scripts/build-android.sh --install`）。
- 需要在自己的实例里试操作真实书库时，把 `~/Library/Application Support/com.readingbook.app`
  复制到临时目录并用 `HOME=<临时目录> ./src-tauri/target/debug/app` 启动，避免改动用户数据。

## 已知约定

- 数据库采用 v2 规范化表结构（`books`、`anchors`、`cards`、`edges`、`sync_peers`、`settings`），应用内不保留旧版 v1 JSON 快照兼容代码；旧库升级走外部脚本 `scripts/migrate_v1_to_v2.py`。
- `cards` 表把批注内容时间戳（`updated_at`）与桌面画布布局时间戳（`layout_updated_at`）分开维护，局域网同步时互不覆盖。
- 卡片摆放统一走 `src/utils/cardPlacement.ts` 的 `nearestFreeY`：不冲突不动，冲突时按 `prefer` 决定往上还是就近。

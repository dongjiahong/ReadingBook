# ReadingBook

**左侧沉浸读书 + 右侧无限批注画布**的桌面阅读器。书页与批注共享同一条原生滚动轴，跨层 SVG 引线把你划线的句子、图表和右侧的想法精确连在一起。

基于 Tauri 2 + React 19 + SQLite，支持本地 EPUB / PDF 导入、书架管理、四色图文批注、内置图片标注、图卡复盘画廊、带图 Markdown 导出与整库一键备份。

![ReadingBook 书架](docs/shelf.png)

<p align="center"><sub>书架：「继续阅读」焦点区展示进度与批注/图表统计，支持导入本地 EPUB / PDF</sub></p>

## 为什么不一样

普通阅读器把笔记塞进侧栏列表，和正文是两个世界；白板工具（Miro、Heptabase）能画思维网，但读不了书。ReadingBook 把两者放进同一套坐标系：

- **垂直方向天生同步**：书页和画布在同一个 flex 容器里共享一条滚动条，翻页时卡片跟着走，不需要任何 JS 补偿，所以没有 1–2 帧的视觉滞后。
- **水平方向无限延展**：右侧画布向右无限延伸，书页用 `position: sticky` 钉在左边，平移到第 5 层子卡片时依然能看见原文。
- **引线不遮挡正文**：划词跨行时自动选取中间行的行尾矩形作锚点；锚点右侧还有同行文字时，引线先下探到行间隙、绕过文字再弯向卡片；选中任意卡片或标注时启用**聚焦降噪**，无关连线自动淡化。

![ReadingBook 阅读工作区](docs/reader.png)

<p align="center"><sub>阅读工作区：每一根引线都从原文的具体词句或图表出发，右侧卡片可继续向右延伸成思维网</sub></p>

## 功能

**阅读与导航**

- 本地 EPUB / PDF 导入，书架顶部「继续阅读」焦点卡片展示进度条、批注卡与图表统计，封面带书脊光影
- EPUB：OPF 元数据、`nav.xhtml` / `toc.ncx` 多级目录、小节级精确跳转、行内粗体/斜体/上下标、插图自然尺寸缓存
- PDF：目录大纲、`IntersectionObserver` 分页虚拟化、离屏页面 `page.cleanup()` 回收内存
- 主题（浅色 / 护眼 / 深色）、字体（系统 / 宋体 / 黑体）、字号、行高、书页宽度，拖动书页右边缘可调宽
- 语义段落/页码定位 + 顶栏实时阅读进度百分比，重开自动恢复阅读位置
- **书页边缘四色微缩热力刻度**：一眼查看全书批注分布，悬停预览原文、点击直达对应段落与卡片

**四色划词与图文批注**

- **四色语义划词浮条（EPUB & PDF 通用）**：高亮/划线切换 + 4 种语义色（重点黄 / 多头绿 / 警示红 / 思考蓝），自动记忆上次选用颜色与样式；支持单键盲操（`1`–`4` 四色标注、`H` 高亮、`U` 划线、`Enter` 建空白卡、`C` 复制、`Esc` 关闭）
- **空白建卡 + 自动聚焦 + 全局贴图**：建卡不回填原文，光标直接进入输入框；选中任意卡片后全局按 `⌘V` 即可直接粘贴剪贴板截图
- **标注二次编辑与升级**：点击纯高亮/纯划线或已连卡卡片悬浮栏，随时换色、高亮↔下划线切换；纯标注可一键升级为带连线的批注卡
- **图表快速成卡**：EPUB 插图悬停一键「转成卡片」；PDF 顶栏裁切模式（或随时按住 `⌥` 拖拽）直接从高清 Canvas 框选截图生成锚定卡片
- **内置图片标注器**：点击卡片附图右上角编辑图标，直接在原图上画箭头、趋势线/支撑阻力线（按住 `Shift` 锁定水平/垂直/45°）、矩形框、半透明荧光笔与带白边文字，保存后无损替换

**画布排布与复盘**

- **右侧画布悬浮控制胶囊**：右下角毛玻璃胶囊收纳卡片原地缩放（`50%–120%`，也支持 `⌘+滚轮`）、一键对称自动排列、全部折叠/展开、引线走线模式切换、新建自由卡片与回页边
- **单卡调宽 + 失焦轻量 Markdown 渲染**：拖拽卡片右边缘调宽（`220–520px`）或一键切换标准/宽卡；编辑时纯文本，失焦后渲染 `**加粗**`、`` `代码` ``、`- 列表` 与 `#标签` 胶囊；左侧 3px 语义色条与书页标注联动
- **防漂移与无损撤销**：基于锚点相对偏移 + 同列防重叠算法，字号/书宽/图片加载变化时平滑跟随；支持 `⌘Z` / `⇧⌘Z` 撤销重做
- **批注复盘抽屉**：按四色语义、仅看附图、仅看卡片筛选全书批注，带缩略图预览与一键定位
- **图卡复盘画廊 / 闪卡模式**：顶栏一键打开本书所有带图卡片画廊，支持四色与 `#标签` 筛选，点开进入全屏闪卡模式（`←` / `→` 翻页复盘、一键跳回原书位置）
- **快速搜索（`⌘K`）**：支持检索当前书批注、当前书全文与全书库笔记

**数据安全与迁移**

- **本地文件持久化**：桌面端卡片附图原图与缩略图直接落盘于 `$APPDATA/images/`，SQLite 仅保存相对路径（旧版 IndexedDB 图片自动迁移）
- **带图 Markdown 导出**：选择目标目录后自动生成 `<书名>-笔记/` 文件夹，含 `.md` 文件与同级 `assets/` 附图目录（相对路径引用，可直接拖入 Obsidian / Notion）
- **整库一键备份与恢复**：设置面板支持一键打包导出或还原完整书库（SQLite 数据库、书籍文件、封面与全部批注图片）

![ReadingBook 阅读 EPUB](docs/epub.png)

## 技术栈

| 层 | 选型 |
| --- | --- |
| 桌面壳 | Tauri 2（Rust 1.90+） |
| 前端 | React 19 + TypeScript + Vite 6 |
| 存储 | `tauri-plugin-sql`（SQLite）+ 本地磁盘 `$APPDATA/images/`（卡片原图与缩略图） |
| EPUB | [zip.js](https://github.com/gildas-lormeau/zip.js) 自定义 `Reader` 直读磁盘字节区间 |
| PDF | [PDF.js](https://github.com/mozilla/pdf.js) 自定义 `PDFDataRangeTransport` |
| 图标 | [lucide-react](https://lucide.dev/) |

## 快速开始

前置：Node.js 20+、Rust 1.90+、Xcode Command Line Tools（macOS）。

```sh
npm install
npm run tauri dev                  # 开发（Vite HMR + Rust 热重启）
```

完整打包（静默生成 `.app` 与只读压缩 `.dmg`，不触发 Finder 弹窗）：

```sh
./scripts/package.sh               # 产出 src-tauri/target/release/bundle/dmg/ReadingBook_<ver>_<arch>.dmg
```

只要前端预览的话（书架会提示需要桌面版，示例文档与画布可正常体验）：

```sh
npm run dev
```

### 应用图标

源图是仓库根目录的 `readingbook.png`（1024×1024，透明背景）。改动后重新生成全套图标：

```sh
npx tauri icon readingbook.png
```

## 目录结构

```
src/
  App.tsx                        窗口外壳、书架/阅读切换、导入删除、设置读写
  ReaderView.tsx                 阅读工作区：滚动物理、卡片放置、连线、持久化、撤销重做
  components/
    ShelfView.tsx                书架与「继续阅读」焦点区
    BookPane.tsx                 EPUB 正文渲染、四色锚点与插图一键转卡片
    PdfBookPane.tsx              PDF 分页渲染、文本层与高清框选截图成卡
    SelectionPopover.tsx         四色语义划词浮条与单键快捷键
    AnnotationCard.tsx           批注卡片（语义色条、拖拽调宽、轻量 Markdown 渲染）
    AnnotationDrawer.tsx         批注复盘抽屉（四色与附图筛选）
    AnchorMinimap.tsx            书页边缘四色微缩热力刻度
    GalleryModal.tsx             图卡复盘画廊与全屏闪卡模式
    ImageAnnotatorModal.tsx      内置图片标注器（箭头/趋势线/方框/荧光笔/文字）
    SearchModal.tsx              ⌘K 全文与跨书批注快速搜索
    BookToCanvasBridge.tsx       跨层 SVG 引线引擎（RAF 零重渲染 + 聚焦降噪）
    SettingsPanel.tsx            阅读设置与整库备份/恢复
  services/db.ts                 SQLite 访问
  services/library.ts            导入、封面生成、删除
  utils/epubLoader.ts            EPUB 解析、目录、磁盘区间读取
  utils/epubDimsCache.ts         EPUB 插图自然尺寸缓存
  utils/imageStore.ts            本地磁盘图片存取与缩略图管理
  utils/exportMarkdown.ts        带图 Markdown 导出（含同级 assets 目录）
  styles.css                     Plan A Sticky 布局与主题变量
src-tauri/
  src/lib.rs                     SQLite 迁移、区间读取、带图导出与整库备份/恢复命令
  migrations/0001_init.sql       books / book_annotations / settings 三张表
  tauri.conf.json                窗口、bundle、asset 协议配置
  icons/                         打包用图标（由 readingbook.png 生成）
scripts/package.sh               一键前端构建 + Tauri .app + hdiutil .dmg 打包脚本
docs/                            截图（书架 / 阅读工作区 / EPUB）
ARCHITECTURE.md                  需求演进、架构选型、算法与内存实测
```

## 数据位置（macOS）

| 内容 | 路径 |
| --- | --- |
| 数据库 | `~/Library/Application Support/com.readingbook.app/readingbook.db` |
| 书籍文件 | `~/Library/Application Support/com.readingbook.app/books/` |
| 封面 | `~/Library/Application Support/com.readingbook.app/covers/` |
| 卡片附图 | `~/Library/Application Support/com.readingbook.app/images/` |
| 图片尺寸缓存 | `~/Library/Application Support/com.readingbook.app/cache/` |

删掉整个 `com.readingbook.app` 目录即可清空全部数据（也可先在「阅读设置 → 导出整库备份」中备份）。

## 已知限制

- 目前只在 macOS 上验证过打包与运行；Windows / Linux 的理论目标已配置，未实测。
- 批注锚点是「段落下标 + 字符偏移」，跨版本改书会失效（CFI 基础路径已生成但未用于迁移）。

更详细的需求清单、方案对比与性能数据见 [ARCHITECTURE.md](ARCHITECTURE.md)。

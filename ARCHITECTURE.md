# ReadingBook 架构设计与需求实现文档

本文档整理自 **ReadingBook** 交互式阅读与无限画布批注原型的完整需求演进、架构选型与核心技术实现方案，可作为后续正式产品研发的工程蓝图。

---

## 一、项目背景与核心需求清单

ReadingBook 旨在解决传统电子书阅读器中“划线笔记与正文割裂、批注空间受限、思维导图难以随书同步”的痛点，打造**“左侧沉浸式读书 + 右侧无限延展画布 + 跨层精准引线”**的一体化阅读工作台。

经过多轮交互验证，系统确立了以下 8 项核心产品需求：

1. **多格式本地电子书支持**：支持解析与阅读本地 `.epub` 与 `.pdf` 电子书（以及内置示例文本），保留清晰排版与文本选区能力。
2. **右侧无限延展画布与随书原生同步**：右侧空白区域作为可无限向右延展的批注画布；上下翻页阅读时，右侧卡片必须与左侧对应段落/页面保持 **1:1 零延迟原生同步**，同时支持向右拖拽平移查看深层分支卡片，且左侧书页在水平平移时保持固定可见。
3. **极简自适应卡片**：
   - 取消常驻头部栏，仅保留悬停浮现的工具胶囊（连线、加图、定位、删除）。
   - 卡片高度随文字与图片内容自动撑开，不设固定截断高度。
   - **纯粹批注样式**：新建划线卡片仅作为思考载体，不默认附带红色删除线或修订 Diff 样式。
4. **卡片富媒体与灯箱预览**：支持通过 `Cmd+V` 粘贴截图、拖拽本地图片文件或点击按钮上传图片；点击卡片内缩略图可弹出全屏灯箱放大查看，支持按 `Esc` 或点击空白遮罩关闭。
5. **防挡字智能引线（Book-to-Canvas Bridge）**：
   - 支持**跨行选区智能取点**：当划线跨越多个文本行时，优先选择中间偏右且位于行尾的矩形作为锚点，避免引线从文本中部穿出。
   - 支持**行间避字路由**：当锚点位于某行文字中间（右侧仍有同行文字）时，提供 `interline`（行间避字）模式，引线先垂直下探至行间隙、水平绕过右侧文字，再平滑弯向右侧卡片，彻底避免遮挡正文；同时保留 `margin-align`（边距对齐）模式供切换。
6. **双向交互与卡片思维网**：
   - **书 $\rightarrow$ 卡片**：划词弹出浮动工具栏，支持“高亮新建”“划线新建”及“连到选中卡片”。
   - **卡片 $\rightarrow$ 书**：拖拽卡片左侧 `🔗` 锚点可反向连接正文选区或整段。
   - **卡片 $\rightarrow$ 卡片**：拖拽卡片右侧端口可连接任意其他卡片，点击右侧 `+` 按钮可快速生成子分支卡片。
7. **防重叠新建与对称树状自动排列**：
   - **新建防重叠**：无论是划词新建还是通过 `+` 号连续创建第 3、4、5 个子卡片，均基于卡片真实 DOM 高度进行纵轴碰撞检测，自动寻找不重叠的空位放置。
   - **对称自动排列**：一键整理画布卡片时，按父子连线拓扑构建树状层级，并将同组子卡片以父节点垂直中心线为基准**上下均匀对称分配**，避免单向往下堆叠。
8. **长文档高性能虚拟化**：面对数百页 PDF，仅渲染视口及缓冲区域内的页面，离屏自动释放 Canvas 与文本层内存，滚动期间跨层 SVG 连线零 React 重渲染。

---

## 二、整体架构演进与方案选型

### 1. 为什么放弃“双栏独立滚动 + React Flow”

原型初期尝试了“左侧 DOM 书页独立滚动 + 右侧 [React Flow](https://reactflow.dev/) 独立画布 + JS 监听 `scroll` 同步偏移量”的方案，但暴露出三类结构性缺陷：
- **滚动不同步与果冻效应**：浏览器原生滚动是异步合成的，JS 监听 `scroll` 事件再更新右侧画布 `transform` 必然滞后 1–2 帧，快速滚轮或触控板惯性滑动时引线与书页明显脱节。
- **双套坐标系与缩放冲突**：左侧页内滚动位置与右侧画布视口偏移需要双向换算，一旦引入右侧水平拖拽或卡片自动撑高，坐标极易错位。
- **高频重渲染开销**：每次滚动触发连线状态更新会导致 React 组件树频繁 Diff。

### 2. 最终选型：方案 A（单一原生滚动容器 + Sticky 书页 + 共享高度无限宽画布）

正式架构采用 **Plan A（统一原生滚动架构）**，从 DOM 布局层彻底消灭双栏同步问题：

```text
+-----------------------------------------------------------------------+
| .workspace-outer (100vw x 100vh, position: relative, overflow: hidden)|
|  |                                                                    |
|  +-- .unified-scroll-viewport (overflow: auto, 唯一原生滚动条)         |
|  |    |                                                               |
|  |    +-- .unified-stage (display: flex; width: max-content)          |
|  |         |                                                          |
|  |         +-- .book-sticky-col (position: sticky; left: 0; z-index:10)|
|  |         |     左侧书页：垂直随原生滚动 1:1 移动，水平平移时固定在左侧  |
|  |         |                                                          |
|  |         +-- .infinite-margin-canvas (flex-grow, min-width 动态扩展) |
|  |               右侧无限画布：与左侧共享同一垂直坐标系与总高度           |
|  |               - card-edges-svg (卡片间 SVG 贝塞尔连线)               |
|  |               - AnnotationCard (position: absolute, x/y 绝对定位)   |
|  |                                                                    |
|  +-- BookToCanvasBridge (全屏覆盖 SVG, pointer-events: none)          |
|        直接读取 DOM Rect 并通过 RAF 操作 SVG Path，零 React 重渲染      |
+-----------------------------------------------------------------------+
```

**方案 A 的核心优势**：
- **垂直方向天生同步**：书页与画布处于同一个 `.unified-stage` Flex 容器内，共享同一条原生垂直滚动条，浏览器的合成器线程保证 60/120fps 绝对同步，无需任何滚动同步代码。
- **水平方向无限延展不丢书页**：当用户向右拖拽画布空白处或扩展多层子卡片时，`.unified-scroll-viewport` 横向滚动，`.book-sticky-col` 凭借 `position: sticky; left: 0` 始终贴合视口左侧，书页与批注同屏参照。
- **交互自由度高**：直接基于原生 DOM 绝对定位渲染 `AnnotationCard`，绕开了第三方画布库对文本框输入、图片粘贴、高度自适应和滚动拦截的限制。

---

## 三、核心模块与数据结构设计

### 1. 核心数据模型（`src/types.ts`）

| 模型名称 | 关键字段 | 说明 |
| :--- | :--- | :--- |
| `DocFormat` | `'demo' \| 'epub' \| 'pdf'` | 统一文档格式标识 |
| `NormalizedPdfRect` | `x, y, width, height` (`0~1` 归一化) | 与 PDF 缩放比例无关的相对高亮/选区矩形 |
| `BookAnchor` | `id, format, paragraphId, startOffset, endOffset, epubCfiRange?, pdfPage?, pdfRects?, quote, style, color` | 书页锚点模型，兼容 EPUB 偏移/CFI 与 PDF 页码/归一化矩形 |
| `AnnotationCardItem` | `id, anchorId, x, y, width, note, images[], color, createdAt` | 批注卡片模型（`images` 存 `CardImage` 引用，列表显示缩略图 object URL，原图在 IndexedDB，高度由内容自适应） |
| `CardEdge` | `id, fromCardId, toCardId, color` | 卡片间思维连线 |
| `DraggingWireState` | `mode ('card-to-book' \| 'card-to-card'), sourceCardId, startX, startY, currentX, currentY` | 拖拽连线实时预览状态 |

### 2. 项目文件职责对照表

| 文件路径 | 核心职责 |
| :--- | :--- |
| `src/App.tsx` | 全局状态管理（文档、锚点、卡片、连线、灯箱、引线模式）、Plan A 容器协调、画布平移、防重叠放置算法与对称树状自动排列 |
| `src/types.ts` | 跨格式锚点、卡片、连线与拖拽状态的 TypeScript 类型定义 |
| `src/utils/epubLoader.ts` | 基于 [zip.js](https://github.com/gildas-lormeau/zip.js) 的 `BlobReader` 按需解压 `.epub`、解析 `container.xml` 与 `.opf` Spine 顺序、抽取正文块并生成 [EPUB CFI](https://idpf.org/epub/linking/cfi/) 基础路径 |
| `src/components/BookPane.tsx` | EPUB 与示例文本渲染、基于 `Range` 的字符偏移选区计算、浮动批注菜单与反向连线落点接收 |
| `src/components/PdfBookPane.tsx` | 基于 [PDF.js](https://github.com/mozilla/pdf.js/) 的分页渲染、`IntersectionObserver` 虚拟化与内存回收、文本选区及 `Alt/Option` 框选归一化 |
| `src/components/AnnotationCard.tsx` | 极简自适应卡片 UI、Textarea 自动撑高回调、图片粘贴/拖入/上传、点击图片触发灯箱、左/右连接端口与 `+` 分支按钮 |
| `src/components/BookToCanvasBridge.tsx` | 全屏 SVG 跨层连线引擎，RAF 零重渲染刷新、跨行最优矩形选取与行间避字路径生成 |
| `src/styles.css` | Plan A Sticky 布局、点阵画布背景、悬浮工具栏、灯箱遮罩与划线高亮视觉样式 |

---

## 四、关键技术实现细节

### 1. EPUB 解析与 CFI 定位
- 使用 [zip.js](https://github.com/gildas-lormeau/zip.js) 的 `BlobReader` 读取 `.epub` 压缩包：只读取中央目录和实际需要的 XHTML 条目，不再把整包 100MB+ 的 EPUB 解压进 JS 堆。定位 `META-INF/container.xml` 获取 `.opf` 根文件路径，按 `manifest` 与 `spine` 顺序读取各章节 XHTML。
- 在抽取段落时为每章生成确定性的 `epubCfiBase`（遵循 [EPUB CFI 规范](https://idpf.org/epub/linking/cfi/)），结合段落内 `startOffset` 与 `endOffset`，为正式版的跨设备精准还原打下基础。

### 2. PDF.js 虚拟化分页与归一化坐标
- **Worker 配置**：通过 `new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url)` 挂载 PDF.js Worker，避免主线程阻塞。
- **视口虚拟化**：为每页预估占位高度，利用 `IntersectionObserver`（`rootMargin: '300px 0px'`）判断页面是否接近视口。进入缓冲区时渲染 Canvas 与可选择的 `TextLayer`；Canvas 同时受 `devicePixelRatio <= 2` 和约 400 万总像素两条上限约束，避免高倍缩放时单页位图失控。离开缓冲区后销毁 Canvas 尺寸、清空文本层，并调用 `page.cleanup()` 释放 pdf.js 的页面资源；缩放变化做 150ms 防抖，只渲染最终比例。
- **归一化选区**：用户划选文本或按住 `Alt/Option` 框选公式/图表时，将 DOM 矩形转换为相对于页面宽高的 `0~1` 归一化坐标（`NormalizedPdfRect`），并为每个高亮块注入 `data-anchor-group={anchor.id}` 以便跨层连线精确追踪。

### 3. 零重渲染 RAF 跨层 SVG 桥接与防挡字算法
为了在滚动与拖动卡片时保持极高帧率，`BookToCanvasBridge.tsx` 不将每帧坐标存入 React State，而是直接监听滚动容器的 `scroll`、窗口 `resize` 及卡片布局变更事件，通过 `requestAnimationFrame` 直接修改 `<path>`、`<circle>` 的 DOM 属性：

1. **多行选区最优锚点选取（`pickBestAnchorLineRect`）**：
   - 收集同一个 `anchor.id` 对应的所有高亮行矩形，按垂直位置分行聚合。
   - 若跨越多行，优先选取**中间偏下行的最右侧矩形**，确保连线从选区整体视觉中心右侧引出，既美观又远离首尾折行干扰。
2. **同行遮挡检测与行间避字（`detectSameLineRightEdge` & `interline` 模式）**：
   - 检测目标矩形右侧是否还存在同一行的未选中文本。
   - 当锚点位于行中（`hasTextAfter = true`）且处于 `interline` 模式时，引线从锚点底部右侧出发，先下探约 `8px` 进入行间隙，水平延伸至该行文本右边界外侧（`lineRight + 10px`），再通过三次贝塞尔曲线平滑连向右侧卡片左侧端口，完全避开后续文字。
   - 若锚点已在行尾或使用 `margin-align` 模式，则直接从行尾右侧或书页右缘引出。

### 4. 卡片防重叠放置与对称树状自动排列
- **新建防碰撞（`findNonOverlappingY`）**：
  - 在卡片高度动态变化（多行笔记或贴入大图）的场景下，固定行高估算必定导致重叠。
  - 新建主卡片或通过 `+` 号创建第 $N$ 个子卡片时，算法通过 `cardEl.getBoundingClientRect().height` 读取同列所有现有卡片的**真实渲染高度**，将垂直区间排序后，从理想 `targetY` 出发向下探测，直到找到满足 `gap >= 18px` 的首个安全纵向位置。
- **对称树状自动排列（`handleAutoLayoutCards`）**：
  - 根据 `CardEdge` 构建有向图，区分连通树根与孤立卡片，按拓扑层级分配横向列坐标（`colX = BASE_X + depth * (CARD_W + COL_GAP)`）。
  - 自底向上计算每个子树所需的总垂直包络高度，自顶向下布局时**以父节点的垂直中心线为对称轴**，将所有子分支均匀居中分布于父节点上下两侧，最后按 `Y` 轴做一次全局防碰撞微调并自动扩展画布最小宽度 `canvasMinWidth`。
  - *注：若正式版需要支持多父节点有向无环图（DAG）或更复杂的正交避让，可进一步引入 [ELK.js](https://github.com/kieler/elkjs) 布局引擎。*

### 5. 极简卡片交互与图片灯箱
- **极简外观**：卡片宽度固定为 `248px`，圆角边框配合微弱阴影；工具栏仅在 `:hover` / `:focus-within` 时以顶部悬浮胶囊形式出现，不占用阅读视觉空间。
- **高度自适应**：监听 `textarea` 内容变化与图片加载完成事件，动态重算高度并触发 `onLayoutChange` 通知 `BookToCanvasBridge` 实时更新引线端点。
- **图片支持与灯箱**：卡片 `onPaste` 捕获剪贴板图片、`onDrop` 接收本地拖拽图片、按钮选择文件，统一生成最长边 480px 的缩略图并存入 IndexedDB，列表只加载缩略图 object URL；点击缩略图时才按需读取原图 Blob 打开灯箱，绑定 `Escape` 键与遮罩点击关闭事件。移除图片、删除卡片或切换书籍时同步 revoke object URL 并删除 IndexedDB 记录。

---

## 五、面向正式产品的工程化路线图

基于当前验证通过的交互原型，正式产品落地建议按以下四个阶段推进（第 1、2 步已在 2026-11-13 落地，见第七节）：

1. **桌面端容器化打包（已落地）**：使用 [Tauri 2.0](https://v2.tauri.app/)（轻量、Rust 后端原生文件读写与系统剪贴板访问，或备选 [Electron](https://electronjs.org/)）包装前端应用，实现本地书库目录扫描与大文件流式读取，避免浏览器每次手动重新选择文件。
2. **数据持久化与标准批注模型（已落地）**：
   - 本地 SQLite（`tauri-plugin-sql`）保存书籍元数据、阅读进度、批注与设置；卡片原图仍存 IndexedDB，SQLite 只记 image id，重开时按需重建缩略图 URL，避免数据库膨胀。
   - 批注数据结构建议对齐 [W3C Web Annotation Data Model](https://www.w3.org/TR/annotation-model/)，便于未来跨端同步与生态互通。
3. **双向导出能力**：
   - **Markdown / Obsidian 导出**：按章节与卡片树状层级导出带引用原文、批注正文及图片附件的 `.md` 笔记。
   - **原生 PDF 写回**：借助 [pdf-lib](https://github.com/hopding/pdf-lib) 将归一化高亮矩形与批注摘要写入标准 PDF Annotation 层，生成可在其他阅读器中查看的带批注 PDF。
4. **阅读器内核增强**：
   - 完善 EPUB 目录大纲（TOC）提取、章节内嵌图片与自定义 CSS 样式还原、全书全文检索。
   - 增加画布缩放（Zoom In/Out）、小地图（Minimap）以及卡片全文搜索定位功能。

---

## 六、内存优化实测（2026-11-13）

测试环境：Chromium 157（headless），视口 1440×900，DPR 2，生产构建；对照版本保留旧的 DataURL 图片、`rootMargin: 800px`、DPR 2 且不调用 `page.cleanup()` 的实现。数值为渲染器侧估算，不是整机 RSS，重点看前后相对变化。

### 1. 图片：20 张约 1400×1000 的 JPEG

| 指标 | 旧实现（DataURL） | 新实现（IndexedDB + 480px 缩略图） |
| --- | ---: | ---: |
| 解码位图估算 | 112.2 MB | 4.5 MB |
| 内联 base64 字符串 | 19.8 MB | 0 |
| JS Heap（`performance.memory`） | 26.1 MB | 5.0 MB |

图片是这次优化里收益最大的一项。列表只解码缩略图，原图仅在灯箱打开时按需读取。

### 2. PDF：375 页、36 MB 文档

| 场景 | 旧实现 Canvas | 新实现 Canvas |
| --- | ---: | ---: |
| 100%，首屏 | 18.87 MB（3 页） | 12.58 MB（2 页） |
| 220%，第 100 页附近 | 60.91 MB（2 页） | 30.50 MB（2 页） |

旧实现单页 Canvas 为 2376×3360，新实现通过约 400 万像素预算压到 1681×2378；同时 `rootMargin` 从 800px 收到 300px，离屏页会调用 `page.cleanup()`。高倍缩放下 Canvas 占用约减半。

### 3. EPUB：135 MB、318 个条目

| 指标 | 旧实现（JSZip） | 新实现（zip.js BlobReader） |
| --- | ---: | ---: |
| 解析后 JS Heap | 144.4 MB | 10.5 MB |
| 提取段落数 | 2148 | 2148 |
| 加载耗时 | 约 2 s | 约 2 s |

旧实现把整个 135 MB 压缩包读入 JS 堆；新实现只读中央目录和实际需要的 XHTML 条目，正文结果保持一致。

**结论**：省内存的关键不是换语言或换壳，而是三件事：图片不要 base64 和全尺寸解码；PDF Canvas 要有像素预算并及时释放页面资源；EPUB 不要整包解压进 JS 堆。这三项在浏览器、Tauri 和 Wails 中都适用。

---

## 七、桌面端实现：Tauri 2 + SQLite + 书架（2026-11-13）

原型已升级为可运行的 macOS 桌面应用。前端在 `src/`，Rust 侧在 `src-tauri/`；同一套前端用 `npm run dev` 也能在浏览器里预览（书架能力仅桌面版可用）。

### 1. 数据存储

数据库：`~/Library/Application Support/com.readingbook.app/readingbook.db`（迁移脚本 `src-tauri/migrations/0001_init.sql`）。

| 表 | 用途 | 关键字段 |
| --- | --- | --- |
| `books` | 书架条目 | `id, title, author, format, file_path, cover_path, progress, progress_locator` |
| `book_annotations` | 每本书的批注快照 | `book_id, anchors_json, cards_json, edges_json` |
| `settings` | 阅读设置 | `key, value(JSON)` |

导入时书籍原文件复制到 `books/<id>.<ext>`，封面统一转成最长边 480px 的 JPEG 存 `covers/<id>.jpg`。书架只解码这一张缩略图，不加载原书。

### 2. EPUB 磁盘按需读取

`src/utils/epubLoader.ts` 里的 `DiskRangeReader` 是 zip.js 的自定义 `Reader`：

- `init()` 调用 Rust 命令 `book_file_size` 拿文件长度；
- `readUint8Array(offset, length)` 调用 `read_book_range`；
- Rust 侧返回 `tauri::ipc::Response`（原始字节），不走 JSON 序列化，避免大块数据被放大成数字数组。

因此打开 142MB 的 EPUB 时，只有中央目录、当前章节 XHTML 和可视区域内的图片会进入内存，整包不会复制到 WebView 堆里。导入流程仍然使用内存中的 `File`（一次性解析元数据与封面），阅读流程走磁盘。

### 3. 窗口与顶栏融合

`tauri.conf.json` 使用 macOS 的 `titleBarStyle: "Overlay"` + `hiddenTitle: true`，红绿灯浮在应用内容上；顶栏高 46px，左侧预留 92px（`--titlebar-inset`），整条栏带 `data-tauri-drag-region`，可以直接拖动窗口、双击最大化。顶栏操作收成 28px 图标按钮，与阅读内容轻量分隔。

### 4. 书架与阅读设置

- **导入**：系统文件对话框 → 解析元数据（EPUB 读 OPF 的 `dc:title`/`dc:creator` 与 `cover-image`；PDF 读文档信息并渲染首页缩略图）→ 复制文件 → 写 SQLite。
- **书架**：按最近打开排序，卡片显示封面、标题、作者、进度条；hover 出现删除按钮，删除走应用内二次确认（不用 `window.confirm`）。
- **阅读设置**：主题（浅色/护眼/深色）、正文字号、行高、书页宽度。设置写入 `settings` 表，通过 `.theme-*` 类切换 CSS 变量、通过 `--reader-font-size` / `--reader-line-height` 即时作用到书页。
- **批注持久化**：`anchors/cards/edges` 以 600ms 防抖写入 `book_annotations`；卡片图片只存 id，重新打开时从 IndexedDB 重建缩略图 object URL，找不到的记录直接丢弃。
- **阅读进度**：滚动停止 500ms 后写入 `progress` 与 `scrollTop/scrollLeft`，再次打开恢复到原位置。
- 拖拽书页右边缘调整宽度时**不改动水平滚动量**：画布紧跟在 sticky 书页列后面，卡片会随书页边缘一起平移，所以加宽/收窄都不会把卡片压到栏底下（旧实现用 `scrollLeft += delta` 维持屏幕位置，正是卡片被遮住的原因）。新建卡片与自动排列以「当前可见左边缘 + 44px」为基准，平移到右侧后新建也不会落在栏背面；恢复阅读位置时水平偏移会夹到「最左卡片 x − 16px」。松手后宽度写回设置。

### 5. EPUB / PDF 展示增强（对标 readest）

参考 [readest](https://github.com/readest/readest)（基于 foliate-js）的 EPUB 阅读体验，补齐了不依赖 iframe 重写就能拿到的部分：

- **目录**：优先解析 EPUB 3 `nav.xhtml` 里的 `nav[epub\:type="toc"]`，回退到 `toc.ncx` 的 `navPoint`，再回退到按章节生成。目录项按 `<ol>` 层级保留缩进；链接里的 `#fragment` 会映射到包含该 `id` 的段落（id 常在行内 `span` 上，所以段落及其所有后代 id 都会登记），点击后精确跳到小节标题而不是章节开头；跳转用显式 `scrollTop` 计算（`scrollIntoView` 在 sticky 列里会偏），标题会正好贴在视口顶部。
- **行内样式**：解析段落时把 `em/i/cite`、`strong/b`、`sup`、`sub` 提取成 `TextRun[]`，渲染时与高亮锚点区间一起切分，`<em>`/`<strong>` 与高亮可以叠加。拼接后的文本仍等于段落 `text`，所以原有的字符偏移锚点、划词偏移计算完全不用改。
- **字体**：设置里新增「系统 / 宋体 / 黑体」，通过 `--reader-font-family` 作用到正文、标题与引用，配合字号、行高、书页宽度即时生效。
- **PDF 目录**：读取 pdf.js 的 `getOutline()`，把 dest 解析成页码，目录面板与 EPUB 共用；点击直接滚到对应页。
- **PDF 按需读取**：新增 `DiskRangeTransport`（继承 `PDFDataRangeTransport`），通过 `read_book_range` 逐段拉取，`disableAutoFetch` + `disableStream` 避免整本进内存；38MB 的测试 PDF 打开时不再复制一份完整 `ArrayBuffer`。

**没照搬的部分**：readest 用 foliate-js 在 iframe 里渲染每个章节、保留原书 CSS 与分页/CFI。我们这套「Sticky 书页 + 单一原生滚动 + 右侧无限画布」的连线依赖真实 DOM 坐标，换成 iframe 会推翻引线引擎，所以继续用自定义的段落模型，只吸收目录、行内样式与排版设置。

### 6. 运行与打包

```sh
npm run tauri dev                     # 开发（Vite + Rust 热重启）
npm run tauri build -- --bundles app  # 生成 ReadingBook.app
```

浏览器预览仍然可用（`npm run dev`）：没有 Tauri 运行时的情况下书架会提示「需要桌面版」，示例文档与批注画布可正常体验。

---

## 八、v0.4.0 跨端演进：v2 规范化数据库、Android 移动端、在线 Edge TTS 与 WiFi 局域网同步（2026-11-25）

v0.4.0 将 ReadingBook 从单机 macOS 阅读器升级为 **macOS + Android 跨端协同阅读工作台**，核心包含以下四个工程模块：

### 1. v2 规范化 SQLite 表结构与外部迁移
- 废弃旧版整本 JSON 快照表 `book_annotations`，将 `src-tauri/migrations/0001_init.sql` 规范化为 6 张独立表：
  - `books`（新增 `file_sha256`、`cover_sha256`、`progress_updated_at`、`tts_locator`、`updated_at`、`deleted_at`）
  - `anchors`、`cards`、`edges`（行级软删除 `deleted_at` + 独立时间戳，便于增量同步）
  - `sync_peers`（已配对局域网设备 `device_id`、`device_name`、`pairing_secret`、`last_sync_at`、`last_ip`、`last_port`）
  - `settings`
- **内容与画布布局解耦**：`cards` 表拆分 `updated_at`（批注正文/附图变更时间）与 `layout_updated_at` / `needs_layout`（桌面 2D 画布坐标变更时间），避免移动端编辑批注覆盖桌面端排版。
- 应用内不保留 v1 兼容代码；旧库升级由独立脚本 `scripts/migrate_v1_to_v2.py` 一次性无损完成。

### 2. Android 移动端阅读器与 Release 自动化打包
- **阅读优先架构**：移动端（`< 768px`）不渲染桌面无限画布，改由 `MobileReaderView.tsx` 提供单栏沉浸阅读、底部工具栏、目录/复盘抽屉与 `MobileNoteSheet.tsx`（Bottom Sheet 批注卡片树，支持增改删子卡片、换色、复制与图片灯箱）。
- **Android SAF 导入**：`src/services/library.ts` 的 `importBookFromPath()` 支持识别 Android `content://` URI（无后缀时通过 `%PDF-` 与 ZIP `PK\x03\x04` 魔数判断格式），并同时复用于 macOS Finder 原生拖拽导入（`getCurrentWebview().onDragDropEvent`）。
- **自动化 Release 签名打包**：`scripts/build-android.sh` 自动从 `readingbook.png` 同步 Android `mipmap-*` 图标、默认构建 `arm64 release` APK、使用本地持久化 keystore（`~/.readingbook-android-release.jks`）执行 `zipalign` + `apksigner` 签名，并支持一键 WiFi ADB 安装与启动 `com.readingbook.app`。

### 3. 纯 Rust 在线 Edge Neural TTS 与 20 句智能缓存
- 后端 `src-tauri/src/tts.rs` 基于 `edge-tts-rust`（异步 WebSocket 连接池）合成 `audio-24khz-48kbitrate-mono-mp3`，无需本地模型文件与 JNI 证书初始化，macOS 与 Android 双端统一运行。
- 精选女声 Top 3（晓晓、晓伊、Ava 双语）与男声 Top 3（云希、云健、Andrew 双语），支持 `0.85x–2.5x` 变速不变调、从当前阅读位置起播与段落高亮跟随。
- 前端 `src/utils/ttsCache.ts` 在 IndexedDB 持久化预取后续 20 句音频：未听过的音频长期保留，已播放完成的音频在播完 2 小时后自动清理。
- `TtsPlayerBar.tsx` 采用双行防遮挡控制栏与自定义男女声分组人声选择器，彻底替代原生 `<select>`。

### 4. 纯 Rust WiFi 局域网双向同步
- 后端 `src-tauri/src/sync.rs` 实现零外部依赖的局域网 P2P 同步服务：
  - UDP `45888` 广播与监听，自动发现同一 WiFi 下的 ReadingBook 设备；
  - Tokio 嵌入式 HTTP/1.1 服务（`45889` 端口），提供 `/sync/ping`、`/sync/pair`、`/sync/exchange`、`GET/POST /sync/file`；
  - 6 位动态配对码（5 分钟 TTL）交换共享密钥，后续所有数据交换与文件传输均校验 `X-RB-Device-Id` + `X-RB-Timestamp` + `X-RB-Signature`（HMAC-SHA256）。
- 前端 `src/services/sync.ts` 与 `src/components/SyncModal.tsx` 负责增量 SQLite 记录交换、字段级 LWW 合并以及缺失的 `books/`、`covers/`、`images/` 二进制文件双向拉推。

### 5. 两端设置页视觉焕新
- `SettingsPanel.tsx` 重构为顶部「实时排版预览」+ 分组卡片（`Aa` 主题预览块、分段字体切换、带 `-/+` 微调按钮的滑块），桌面端居中卡片、Android 端底部抽屉弹出。

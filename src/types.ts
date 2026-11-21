export type DocFormat = 'epub' | 'pdf';
export type AnnotationStyle = 'highlight' | 'underline' | 'pin';
export type AnchorColor = 'amber' | 'green' | 'blue' | 'rose';
export type CardKind = 'review' | 'revision' | 'thought';

export interface NormalizedPdfRect {
  x: number; // 0 ~ 1 relative to page width
  y: number; // 0 ~ 1 relative to page height
  w: number;
  h: number;
}

export interface BookAnchor {
  id: string;
  docFormat?: DocFormat;
  paragraphId: string;
  epubCfi?: string;
  pdfPage?: number;
  pdfRects?: NormalizedPdfRect[];
  quote: string;
  startOffset: number;
  endOffset: number;
  style: AnnotationStyle;
  color?: AnchorColor;
  badgeNumber: number;
  kind: CardKind;
  /** 关联的批注卡片；基础标注（仅高亮/划线）没有卡片。 */
  targetNodeId?: string;
}

export interface CardImage {
  id: string;
  thumbUrl: string;
  width: number;
  height: number;
  /** 桌面端原图相对路径（位于 $APPDATA/images/）。 */
  filePath?: string;
  /** 桌面端缩略图相对路径（位于 $APPDATA/images/）。 */
  thumbPath?: string;
}

export interface AnnotationCardItem {
  id: string;
  x: number;
  y: number;
  kind: CardKind;
  badgeNumber?: number;
  body: string;
  images?: CardImage[];
  status?: 'pending' | 'accepted' | 'rejected';
  anchorId?: string;
  /** 相对所属书页锚点的垂直偏移量（px）；重排/字号变化/图片加载后按此保持相对位置。 */
  anchorOffsetY?: number;
  /** 思维导图式折叠：收起自身内容，并隐藏全部后代卡片。 */
  collapsed?: boolean;
  /** 单卡自定义宽度（px，默认 248，可拖拽右边缘调整或切换宽卡）。 */
  width?: number;
}

export interface CardEdge {
  id: string;
  source: string;
  target: string;
  color?: string;
}

export interface DraggingWireState {
  mode: 'to-book' | 'to-card';
  sourceNodeId: string;
  startX: number; // relative to workspace-outer
  startY: number; // relative to workspace-outer
  currentX: number; // relative to workspace-outer
  currentY: number; // relative to workspace-outer
}

/** A book in the local library (persisted in SQLite). */
export interface BookRecord {
  id: string;
  title: string;
  author: string;
  format: 'epub' | 'pdf';
  /** Path relative to the app data directory, e.g. `books/<id>.epub`. */
  filePath: string;
  /** Path relative to the app data directory, e.g. `covers/<id>.jpg`. */
  coverPath: string | null;
  totalParagraphs: number;
  addedAt: number;
  lastOpenedAt: number | null;
  /** 0 ~ 1 reading progress used by the shelf progress bar. */
  progress: number;
  /** JSON string with scroll offsets so reopening resumes in place. */
  locator: string | null;
}

export type ReaderTheme = 'light' | 'sepia' | 'dark';
export type ReaderFont = 'system' | 'serif' | 'sans';

export interface ReaderSettings {
  theme: ReaderTheme;
  fontSize: number;
  lineHeight: number;
  bookWidth: number;
  fontFamily: ReaderFont;
  /** 右侧批注卡片锚点原地缩放比例（0.5 ~ 1.2，默认 1）。 */
  cardScale?: number;
}

export interface BookAnnotations {
  anchors: BookAnchor[];
  cards: AnnotationCardItem[];
  edges: CardEdge[];
}

/** Inline formatting runs; concatenated text must equal `BookParagraph.text`. */
export interface TextRun {
  text: string;
  italic?: boolean;
  bold?: boolean;
  sup?: boolean;
  sub?: boolean;
}

export interface BookParagraph {
  id: string;
  type: 'heading' | 'stage' | 'quote' | 'prose' | 'table' | 'image';
  text?: string;
  runs?: TextRun[];
  epubCfiBase?: string;
  lines?: { id: string; text: string }[];
  rows?: { line: string; image: string; reading: string }[];
  imagePath?: string;
  imageSrc?: string;
  imageAlt?: string;
  imageWidth?: number;
  imageHeight?: number;
}

/** One table-of-contents entry (EPUB nav/NCX or PDF outline). */
export interface TocEntry {
  label: string;
  /** Paragraph id for EPUB, page number for PDF. */
  target: string;
  depth: number;
  kind: 'epub' | 'pdf';
}

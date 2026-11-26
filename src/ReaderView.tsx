import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Bookmark,
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  Crop,
  Download,
  GitCommitHorizontal,
  Headphones,
  Highlighter,
  Images,
  LayoutGrid,
  ListTree,
  Loader2,
  MessageSquarePlus,
  Pencil,
  PlusCircle,
  Redo2,
  RotateCcw,
  Search,
  Settings,
  Trash2,
  Underline,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { AnchorMinimap } from './components/AnchorMinimap';
import { AnnotationCard } from './components/AnnotationCard';
import { AnnotationDrawer } from './components/AnnotationDrawer';
import { BookPane } from './components/BookPane';
import { GalleryModal } from './components/GalleryModal';
import { ANCHOR_COLORS } from './components/SelectionPopover';
import { ImageAnnotatorModal } from './components/ImageAnnotatorModal';
import { SearchModal, type SearchResultAction } from './components/SearchModal';
import { TtsPlayerBar } from './components/TtsPlayerBar';
import {
  BookToCanvasBridge,
  type MidLineRoutingMode,
} from './components/BookToCanvasBridge';
import { PdfBookPane, type PdfSource } from './components/PdfBookPane';
import type {
  AnchorColor,
  AnnotationCardItem,
  AnnotationStyle,
  BookAnchor,
  BookParagraph,
  BookRecord,
  CardEdge,
  CardImage,
  DocFormat,
  DraggingWireState,
  NormalizedPdfRect,
  ReaderSettings,
  TocEntry,
} from './types';
import { invoke } from '@tauri-apps/api/core';
import { loadAnnotations, saveAnnotations } from './services/db';
import { EpubImageLoader, parseEpubFile } from './utils/epubLoader';
import {
  loadEpubImageDims,
  saveEpubImageDims,
  type ImageDimsMap,
} from './utils/epubDimsCache';
import { computeCardFoldState } from './utils/cardTree';
import { nearestFreeY, type PlacementBox } from './utils/cardPlacement';
import { exportBookAnnotationsToMarkdown } from './utils/exportMarkdown';
import {
  createFullImageUrl,
  deleteStoredImage,
  importImageFiles,
  restoreThumbUrls,
  revokeImageUrl,
  revokeObjectUrlIfBlob,
} from './utils/imageStore';

const DEFAULT_FREE_CARD_TEXT = '可在右侧无限画布任意摆放，支持粘贴截图或拖入图片。';

interface SavedLocator {
  top: number;
  left: number;
  paragraphId?: string;
  pdfPage?: number;
  offsetY?: number;
}

function parseLocator(locator: string | null): SavedLocator | null {
  if (!locator) return null;
  try {
    const parsed = JSON.parse(locator) as Partial<SavedLocator>;
    return {
      top: Number(parsed.top) || 0,
      left: Number(parsed.left) || 0,
      paragraphId: typeof parsed.paragraphId === 'string' ? parsed.paragraphId : undefined,
      pdfPage: typeof parsed.pdfPage === 'number' && Number.isFinite(parsed.pdfPage) ? parsed.pdfPage : undefined,
      offsetY: typeof parsed.offsetY === 'number' && Number.isFinite(parsed.offsetY) ? parsed.offsetY : undefined,
    };
  } catch {
    return null;
  }
}

function findAnchorElement(bookEl: HTMLElement, anchor: BookAnchor): HTMLElement | null {
  return (
    bookEl.querySelector<HTMLElement>(`[data-anchor-id="${anchor.id}"]`) ??
    (anchor.style === 'pin'
      ? bookEl.querySelector<HTMLElement>(`[data-paragraph-id="${anchor.paragraphId}"]`)
      : null)
  );
}

interface PreviewImageState {
  id: string;
  url: string;
  alt?: string;
  zoomable?: boolean;
  cardId?: string;
  image?: CardImage;
}

interface ReaderViewProps {
  book: BookRecord;
  settings: ReaderSettings;
  onBack: () => void;
  onSwitchBook?: (bookId: string) => void;
  onOpenSettings: () => void;
  onSettingsChange: (patch: Partial<ReaderSettings>) => void;
  onProgress: (bookId: string, progress: number, locator: string) => void;
}

export default function ReaderView({
  book,
  settings,
  onBack,
  onSwitchBook,
  onOpenSettings,
  onSettingsChange,
  onProgress,
}: ReaderViewProps) {
  const workspaceOuterRef = useRef<HTMLDivElement | null>(null);
  const unifiedScrollRef = useRef<HTMLDivElement | null>(null);
  const bookStickyRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const bridgeTriggerRef = useRef<() => void>(() => {});
  const bookWidthRef = useRef(settings.bookWidth);
  const progressTimerRef = useRef<number | null>(null);
  const lastProgressRef = useRef<{ progress: number; locator: string } | null>(null);
  const hydratedRef = useRef(false);
  const restoreScrollRef = useRef<SavedLocator | null>(null);
  const activeRestoreTargetRef = useRef<SavedLocator | null>(null);
  const userInteractedAfterOpenRef = useRef(false);
  const imageAlignTimerRef = useRef<number | null>(null);
  const epubDimsRef = useRef<ImageDimsMap>({});
  const epubDimsDirtyRef = useRef(false);
  const epubDimsTimerRef = useRef<number | null>(null);
  const undoStackRef = useRef<
    { anchors: BookAnchor[]; cards: AnnotationCardItem[]; edges: CardEdge[] }[]
  >([]);
  const redoStackRef = useRef<
    { anchors: BookAnchor[]; cards: AnnotationCardItem[]; edges: CardEdge[] }[]
  >([]);
  const pendingDeleteImagesRef = useRef<Map<string, CardImage>>(new Map());
  const pendingInitialAlignRef = useRef(false);
  const saveTimerRef = useRef<number | null>(null);
  const dirtyAnnotationsRef = useRef(false);
  const latestAnnotationsRef = useRef<{
    bookId: string;
    anchors: BookAnchor[];
    cards: AnnotationCardItem[];
    edges: CardEdge[];
  }>({ bookId: book.id, anchors: [], cards: [], edges: [] });

  const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false });

  const cardScale = Math.min(1.2, Math.max(0.5, settings.cardScale ?? 1));
  const [annotatingImage, setAnnotatingImage] = useState<{
    cardId: string;
    image: CardImage;
    url: string;
  } | null>(null);
  const [bookWidth, setBookWidth] = useState<number>(settings.bookWidth);
  const [isResizing, setIsResizing] = useState(false);
  const [docReady, setDocReady] = useState(false);
  const [toc, setToc] = useState<TocEntry[]>([]);
  const [showToc, setShowToc] = useState(false);
  const [showReviewDrawer, setShowReviewDrawer] = useState(false);
  const [showGallery, setShowGallery] = useState(false);
  const [showTts, setShowTts] = useState(false);
  const [ttsParagraphId, setTtsParagraphId] = useState<string | null>(null);
  const [pdfCropMode, setPdfCropMode] = useState(false);
  const [showSearch, setShowSearch] = useState(false);

  useEffect(() => {
    const bookEl = bookStickyRef.current;
    if (!bookEl) return;
    bookEl.querySelectorAll('[data-tts-active="true"]').forEach((el) => {
      el.removeAttribute('data-tts-active');
    });
    if (ttsParagraphId) {
      const activeEl = bookEl.querySelector<HTMLElement>(
        `[data-paragraph-id="${ttsParagraphId}"]`
      );
      if (activeEl) activeEl.setAttribute('data-tts-active', 'true');
    }
  }, [ttsParagraphId]);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const [readingProgress, setReadingProgress] = useState<number>(book.progress ?? 0);

  const [docFormat, setDocFormat] = useState<DocFormat>('epub');
  const [bookTitle, setBookTitle] = useState<string>('');
  const [paragraphs, setParagraphs] = useState<BookParagraph[]>([]);
  const [pdfSource, setPdfSource] = useState<PdfSource | null>(null);
  const [pdfScale, setPdfScale] = useState<number>(1.0);
  const [epubImageLoader, setEpubImageLoader] = useState<EpubImageLoader | null>(
    null
  );
  const [loadError, setLoadError] = useState<string | null>(null);

  const [anchors, setAnchors] = useState<BookAnchor[]>([]);
  const [cards, setCards] = useState<AnnotationCardItem[]>([]);
  const [edges, setEdges] = useState<CardEdge[]>([]);

  const cardsRef = useRef(cards);
  cardsRef.current = cards;
  const edgesRef = useRef(edges);
  edgesRef.current = edges;
  const pendingAutoLayoutRef = useRef(false);

  const [activeAnchorId, setActiveAnchorId] = useState<string | null>(null);
  // 基础标注（仅划线/高亮）被点击后弹出的删除操作条，坐标相对视口。
  const [anchorActions, setAnchorActions] = useState<{
    anchorId: string;
    x: number;
    y: number;
  } | null>(null);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [autoFocusCardId, setAutoFocusCardId] = useState<string | null>(null);
  const [revealCardId, setRevealCardId] = useState<string | null>(null);
  const [draggingWire, setDraggingWire] = useState<DraggingWireState | null>(null);
  const [isPanningCanvas, setIsPanningCanvas] = useState(false);
  const [midLineMode, setMidLineMode] = useState<MidLineRoutingMode>('interline');
  const [previewImage, setPreviewImage] = useState<PreviewImageState | null>(null);
  const previewImageRef = useRef<PreviewImageState | null>(null);
  previewImageRef.current = previewImage;

  const bumpSync = useCallback(() => {
    bridgeTriggerRef.current();
  }, []);

  const closePreviewImage = useCallback(() => {
    const current = previewImageRef.current;
    if (current) revokeObjectUrlIfBlob(current.url);
    previewImageRef.current = null;
    setPreviewImage(null);
  }, []);

  // 仅释放内存中的 ObjectURL，绝不删除磁盘或数据库中的持久化图片。
  const revokeCardImageUrls = useCallback((list: AnnotationCardItem[]) => {
    for (const card of list) {
      for (const image of card.images ?? []) {
        revokeImageUrl(image.id);
      }
    }
  }, []);

  // 仅在用户主动删除卡片时调用，同步清理持久化的图片文件。
  const deleteCardImages = useCallback((list: AnnotationCardItem[]) => {
    for (const card of list) {
      for (const image of card.images ?? []) {
        void deleteStoredImage(image);
      }
    }
  }, []);

  // Keep the EPUB zip reader alive only while its book is open.
  useEffect(() => {
    return () => {
      epubImageLoader?.dispose();
    };
  }, [epubImageLoader]);

  // Close image lightbox on Escape key
  useEffect(() => {
    if (!previewImage) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closePreviewImage();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [previewImage, closePreviewImage]);

  // Release in-memory thumbnail URLs and preview URL when leaving the book
  useEffect(() => {
    return () => {
      const current = previewImageRef.current;
      if (current) revokeObjectUrlIfBlob(current.url);
      previewImageRef.current = null;
      revokeCardImageUrls(cardsRef.current);
    };
  }, [revokeCardImageUrls]);

  // Mind-map style folding: a collapsed card hides its whole descendant subtree.
  const { hidden: hiddenCardIds, hiddenCounts: hiddenCountByCard } = useMemo(
    () => computeCardFoldState(cards, edges),
    [cards, edges]
  );

  const visibleCards = useMemo(
    () => cards.filter((card) => !hiddenCardIds.has(card.id)),
    [cards, hiddenCardIds]
  );

  // Compute dynamic infinite width for the right canvas based on the rightmost card
  const canvasMinWidth = useMemo(() => {
    let maxRight = 720;
    const scaledSpan = Math.round(360 * cardScale);
    for (const c of visibleCards) {
      if (c.x + scaledSpan > maxRight) {
        maxRight = c.x + scaledSpan;
      }
    }
    return maxRight + 420;
  }, [visibleCards, cardScale]);

  // Compute dynamic minimum height so cards placed lower than short books are still reachable
  const canvasMinHeight = useMemo(() => {
    let maxBottom = 600;
    for (const c of visibleCards) {
      if (c.y + 260 > maxBottom) {
        maxBottom = c.y + 260;
      }
    }
    return maxBottom;
  }, [visibleCards]);

  // Compute card-to-card Bézier curves directly in right-canvas local coordinates
  const [cardEdgePaths, setCardEdgePaths] = useState<
    { id: string; source: string; target: string; d: string; color: string }[]
  >([]);

  // 聚焦降噪：选中某张卡片时，高亮其上下游链路，其余无关连线自动淡化
  const focusedCardIds = useMemo<Set<string> | null>(() => {
    if (!selectedCardId) return null;
    const result = new Set<string>([selectedCardId]);
    const neighbors = new Map<string, string[]>();
    for (const edge of edges) {
      const out = neighbors.get(edge.source) ?? [];
      out.push(edge.target);
      neighbors.set(edge.source, out);
      const inc = neighbors.get(edge.target) ?? [];
      inc.push(edge.source);
      neighbors.set(edge.target, inc);
    }
    const queue = [selectedCardId];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const nxt of neighbors.get(cur) ?? []) {
        if (!result.has(nxt)) {
          result.add(nxt);
          queue.push(nxt);
        }
      }
    }
    return result;
  }, [selectedCardId, edges]);

  const recomputeCardEdges = useCallback(() => {
    const canvasEl = canvasRef.current;
    if (!canvasEl) return;
    const canvasRect = canvasEl.getBoundingClientRect();

    const nextPaths: {
      id: string;
      source: string;
      target: string;
      d: string;
      color: string;
    }[] = [];
    for (const edge of edges) {
      const srcEl = canvasEl.querySelector<HTMLElement>(
        `[data-card-id="${edge.source}"]`
      );
      const tgtEl = canvasEl.querySelector<HTMLElement>(
        `[data-card-id="${edge.target}"]`
      );
      if (!srcEl || !tgtEl) continue;

      const srcRect = srcEl.getBoundingClientRect();
      const tgtRect = tgtEl.getBoundingClientRect();

      const x1 = srcRect.right - canvasRect.left;
      const y1 = srcRect.top + srcRect.height / 2 - canvasRect.top;
      const x2 = tgtRect.left - canvasRect.left;
      const y2 = tgtRect.top + tgtRect.height / 2 - canvasRect.top;

      const dx = Math.max(40, Math.abs(x2 - x1) * 0.5);
      const d = `M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${(x1 + dx).toFixed(1)} ${y1.toFixed(1)}, ${(x2 - dx).toFixed(1)} ${y2.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}`;
      nextPaths.push({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        d,
        color: edge.color || '#3b82f6',
      });
    }
    setCardEdgePaths(nextPaths);
    bumpSync();
  }, [edges, bumpSync]);

  useEffect(() => {
    const raf = requestAnimationFrame(recomputeCardEdges);
    return () => cancelAnimationFrame(raf);
  }, [cards, edges, recomputeCardEdges]);

  const syncHistoryFlags = useCallback(() => {
    setHistoryState({
      canUndo: undoStackRef.current.length > 0,
      canRedo: redoStackRef.current.length > 0,
    });
  }, []);

  const pushUndoSnapshot = useCallback(() => {
    const snap = latestAnnotationsRef.current;
    undoStackRef.current.push({
      anchors: snap.anchors,
      cards: snap.cards,
      edges: snap.edges,
    });
    if (undoStackRef.current.length > 40) {
      undoStackRef.current.shift();
    }
    redoStackRef.current = [];
    syncHistoryFlags();
  }, [syncHistoryFlags]);

  const handleUndo = useCallback(() => {
    const prev = undoStackRef.current.pop();
    if (!prev) return;
    const cur = latestAnnotationsRef.current;
    redoStackRef.current.push({
      anchors: cur.anchors,
      cards: cur.cards,
      edges: cur.edges,
    });
    setAnchors(prev.anchors);
    setCards(prev.cards);
    setEdges(prev.edges);
    syncHistoryFlags();
  }, [syncHistoryFlags]);

  const handleRedo = useCallback(() => {
    const next = redoStackRef.current.pop();
    if (!next) return;
    const cur = latestAnnotationsRef.current;
    undoStackRef.current.push({
      anchors: cur.anchors,
      cards: cur.cards,
      edges: cur.edges,
    });
    setAnchors(next.anchors);
    setCards(next.cards);
    setEdges(next.edges);
    syncHistoryFlags();
  }, [syncHistoryFlags]);

  // 全局快捷键：⌘/Ctrl+K 快速搜索；非输入框焦点时响应 ⌘/Ctrl+Z 撤销与 ⇧⌘Z 重做。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === 'k') {
        e.preventDefault();
        setShowSearch((prev) => !prev);
        return;
      }
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'TEXTAREA' ||
          target.tagName === 'INPUT' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (key === 'z' && !e.shiftKey) {
        if (undoStackRef.current.length > 0) {
          e.preventDefault();
          handleUndo();
        }
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        if (redoStackRef.current.length > 0) {
          e.preventDefault();
          handleRedo();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleUndo, handleRedo]);

  const handleExportMarkdown = useCallback(async () => {
    try {
      const res = await exportBookAnnotationsToMarkdown({
        bookTitle: bookTitle || book.title,
        anchors,
        cards,
        edges,
        paragraphs,
      });
      if (res.exported) {
        setExportNotice(
          res.imageCount > 0
            ? `已导出笔记与 ${res.imageCount} 张附图`
            : '已导出 Markdown'
        );
        window.setTimeout(() => setExportNotice(null), 2600);
      }
    } catch (err) {
      console.warn('导出 Markdown 失败', err);
      setExportNotice('导出失败');
      window.setTimeout(() => setExportNotice(null), 2400);
    }
  }, [bookTitle, book.title, anchors, cards, edges, paragraphs]);

  const handleSearchSelect = useCallback(
    (action: SearchResultAction) => {
      if (action.kind === 'other-book') {
        onSwitchBook?.(action.bookId);
        return;
      }
      if (action.kind === 'paragraph') {
        const target = bookStickyRef.current?.querySelector<HTMLElement>(
          `[data-paragraph-id="${action.paragraphId}"]`
        );
        const scroller = unifiedScrollRef.current;
        if (target && scroller) {
          const offset =
            target.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
          scroller.scrollTo({
            top: Math.max(0, scroller.scrollTop + offset - 24),
            left: scroller.scrollLeft,
            behavior: 'smooth',
          });
          bumpSync();
        }
        return;
      }
      if (action.kind === 'anchor') {
        setActiveAnchorId(action.anchorId);
        const target = bookStickyRef.current?.querySelector<HTMLElement>(
          `[data-anchor-id="${action.anchorId}"]`
        );
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      // kind === 'card': 展开祖先链并同时聚焦卡片与对应书页锚点
      const parentsByChild = new Map<string, string[]>();
      for (const edge of edgesRef.current) {
        const list = parentsByChild.get(edge.target);
        if (list) list.push(edge.source);
        else parentsByChild.set(edge.target, [edge.source]);
      }
      const related = new Set<string>([action.cardId]);
      const stack = [...(parentsByChild.get(action.cardId) ?? [])];
      while (stack.length > 0) {
        const id = stack.pop()!;
        if (related.has(id)) continue;
        related.add(id);
        stack.push(...(parentsByChild.get(id) ?? []));
      }
      setCards((prev) =>
        prev.some((c) => related.has(c.id) && c.collapsed)
          ? prev.map((c) =>
              related.has(c.id) && c.collapsed ? { ...c, collapsed: false } : c
            )
          : prev
      );
      setSelectedCardId(action.cardId);
      if (action.anchorId) setActiveAnchorId(action.anchorId);
      setRevealCardId(action.cardId);
    },
    [bumpSync, onSwitchBook]
  );

  const getAnchorLocalY = useCallback((anchorId: string): number | null => {
    const canvasEl = canvasRef.current;
    const bookEl = bookStickyRef.current;
    if (!canvasEl || !bookEl) return null;
    const found = latestAnnotationsRef.current.anchors.find((a) => a.id === anchorId);
    const anchorEl = found
      ? findAnchorElement(bookEl, found)
      : bookEl.querySelector<HTMLElement>(`[data-anchor-id="${anchorId}"]`);
    if (!anchorEl) return null;
    const rect = anchorEl.getBoundingClientRect();
    if (rect.height <= 0) return null;
    return Math.max(20, rect.top - canvasEl.getBoundingClientRect().top - 10);
  }, []);

  const handleMoveCard = useCallback(
    (cardId: string, nextX: number, nextY: number) => {
      setCards((prev) =>
        prev.map((c) => {
          if (c.id !== cardId) return c;
          const anchorY = c.anchorId ? getAnchorLocalY(c.anchorId) : null;
          return {
            ...c,
            x: nextX,
            y: nextY,
            ...(anchorY !== null ? { anchorOffsetY: Math.round(nextY - anchorY) } : {}),
          };
        })
      );
    },
    [getAnchorLocalY]
  );

  const handleResizeCard = useCallback((cardId: string, nextWidth: number) => {
    setCards((prev) =>
      prev.map((c) => (c.id === cardId ? { ...c, width: nextWidth } : c))
    );
  }, []);

  const handleChangeBody = useCallback((cardId: string, newBody: string) => {
    setCards((prev) =>
      prev.map((c) => (c.id === cardId ? { ...c, body: newBody } : c))
    );
  }, []);

  const handleAddImages = useCallback((cardId: string, newImages: CardImage[]) => {
    if (!cardsRef.current.some((card) => card.id === cardId)) {
      for (const image of newImages) void deleteStoredImage(image);
      return;
    }
    // 登记到待检集合：若后续通过 ⌘Z 撤销建卡导致该图不再被引用，离开书籍时会自动清理。
    for (const image of newImages) {
      pendingDeleteImagesRef.current.set(image.id, image);
    }
    setCards((prev) =>
      prev.map((c) =>
        c.id === cardId ? { ...c, images: [...(c.images ?? []), ...newImages] } : c
      )
    );
  }, []);

  // 选中卡片时直接 ⌘/Ctrl+V 粘贴剪贴板截图，无需先点进卡片输入框
  useEffect(() => {
    if (!selectedCardId) return;
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'TEXTAREA' ||
          target.tagName === 'INPUT' ||
          target.isContentEditable)
      ) {
        return;
      }
      const items = e.clipboardData?.items;
      if (!items) return;
      const imageFiles: File[] = [];
      for (let i = 0; i < items.length; i += 1) {
        if (items[i].type.startsWith('image/')) {
          const file = items[i].getAsFile();
          if (file) imageFiles.push(file);
        }
      }
      if (imageFiles.length === 0) return;
      e.preventDefault();
      const targetCardId = selectedCardId;
      void importImageFiles(imageFiles).then((imported) => {
        if (imported.length > 0) {
          handleAddImages(targetCardId, imported);
        }
      });
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [selectedCardId, handleAddImages]);

  const handleRemoveImage = useCallback(
    (cardId: string, image: CardImage) => {
      pushUndoSnapshot();
      pendingDeleteImagesRef.current.set(image.id, image);
      setCards((prev) =>
        prev.map((c) =>
          c.id === cardId
            ? {
                ...c,
                images: (c.images ?? []).filter((item) => item.id !== image.id),
              }
            : c
        )
      );
      if (previewImageRef.current?.id === image.id) {
        closePreviewImage();
      }
    },
    [closePreviewImage, pushUndoSnapshot]
  );

  const handlePreviewImage = useCallback(async (image: CardImage) => {
    const url = await createFullImageUrl(image);
    if (!url) return;

    const ownerCard = cardsRef.current.find((c) =>
      (c.images ?? []).some((img) => img.id === image.id)
    );
    const current = previewImageRef.current;
    if (current) revokeObjectUrlIfBlob(current.url);
    const next: PreviewImageState = {
      id: image.id,
      url,
      alt: '批注附图',
      zoomable: false,
      cardId: ownerCard?.id,
      image,
    };
    previewImageRef.current = next;
    setPreviewImage(next);
  }, []);

  const handlePreviewBlob = useCallback((blob: Blob, alt: string) => {
    const url = URL.createObjectURL(blob);
    const current = previewImageRef.current;
    if (current) URL.revokeObjectURL(current.url);
    const next = {
      id: `preview-${Date.now()}`,
      url,
      alt,
      zoomable: true,
    };
    previewImageRef.current = next;
    setPreviewImage(next);
  }, []);

  const handleUpdateStatus = useCallback(
    (cardId: string, status: 'accepted' | 'rejected') => {
      setCards((prev) =>
        prev.map((c) =>
          c.id === cardId
            ? { ...c, status: c.status === status ? 'pending' : status }
            : c
        )
      );
    },
    []
  );

  const handleFocusAnchor = useCallback((anchorId: string) => {
    setActiveAnchorId(anchorId);
    const bookEl = bookStickyRef.current;
    if (!bookEl) return;
    const found = latestAnnotationsRef.current.anchors.find((a) => a.id === anchorId);
    const targetEl = found
      ? findAnchorElement(bookEl, found)
      : bookEl.querySelector<HTMLElement>(`[data-anchor-id="${anchorId}"]`);
    if (targetEl) {
      targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, []);

  const handleDeleteCard = useCallback((cardId: string) => {
    pushUndoSnapshot();
    const target = cardsRef.current.find((card) => card.id === cardId);
    if (target) {
      for (const img of target.images ?? []) {
        pendingDeleteImagesRef.current.set(img.id, img);
      }
    }

    setCards((prev) => prev.filter((c) => c.id !== cardId));
    setEdges((prev) => prev.filter((e) => e.source !== cardId && e.target !== cardId));
    setAnchors((prev) => prev.filter((a) => a.targetNodeId !== cardId));
  }, [pushUndoSnapshot]);

  const handleDeleteAnchor = useCallback((anchorId: string) => {
    pushUndoSnapshot();
    setAnchors((prev) => prev.filter((a) => a.id !== anchorId));
    setActiveAnchorId((current) => (current === anchorId ? null : current));
    setAnchorActions(null);
  }, [pushUndoSnapshot]);

  const handleUpdateAnchor = useCallback(
    (anchorId: string, patch: Partial<Pick<BookAnchor, 'color' | 'style'>>) => {
      pushUndoSnapshot();
      setAnchors((prev) =>
        prev.map((a) => {
          if (a.id !== anchorId) return a;
          const nextStyle = patch.style ?? a.style;
          return {
            ...a,
            ...patch,
            kind:
              nextStyle === 'highlight'
                ? 'review'
                : nextStyle === 'underline'
                  ? 'revision'
                  : a.kind,
          };
        })
      );
    },
    [pushUndoSnapshot]
  );

  // 点击操作条和标注以外的地方、或按 Esc 时收起删除操作条。
  useEffect(() => {
    if (!anchorActions) return;
    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest('.anchor-actions-popover')) return;
      if (target.closest('[data-anchor-id]')) return;
      setAnchorActions(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAnchorActions(null);
    };
    window.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [anchorActions]);

  const handleToggleCollapse = useCallback((cardId: string) => {
    setCards((prev) =>
      prev.map((c) => (c.id === cardId ? { ...c, collapsed: !c.collapsed } : c))
    );
  }, []);

  // 全局一键：还有展开的卡片就全部收起，否则全部展开。
  const allCardsCollapsed = cards.length > 0 && cards.every((c) => c.collapsed);

  const handleToggleCollapseAll = useCallback(() => {
    const collapseAll = cards.some((c) => !c.collapsed);
    // 折叠/展开会改变卡片高度，排布必须按新高度重算，否则展开后互相压住。
    pendingAutoLayoutRef.current = true;
    setCards((prev) => prev.map((c) => ({ ...c, collapsed: collapseAll })));
  }, [cards]);

  // 被折叠隐藏的卡片不应该继续保持选中态。
  useEffect(() => {
    setSelectedCardId((current) =>
      current && hiddenCardIds.has(current) ? null : current
    );
  }, [hiddenCardIds]);

  // 展开后卡片才重新挂载，滚动定位要等这一次提交完成后再做。
  useEffect(() => {
    if (!revealCardId) return;
    const el = canvasRef.current?.querySelector<HTMLElement>(
      `[data-card-id="${revealCardId}"]`
    );
    setRevealCardId(null);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
  }, [revealCardId]);

  // Find the nearest free Y in the target column using actual rendered DOM heights
  const findNonOverlappingY = useCallback(
    (
      targetX: number,
      idealY: number,
      newCardEstHeight: number,
      list: AnnotationCardItem[]
    ) => {
      const canvasEl = canvasRef.current;
      const colThreshold = Math.round(252 * cardScale);
      const rowGap = Math.max(10, Math.round(16 * cardScale));
      const boxes: PlacementBox[] = list
        .filter((c) => Math.abs(c.x - targetX) < colThreshold)
        .map((c) => {
          const el = canvasEl?.querySelector<HTMLElement>(`[data-card-id="${c.id}"]`);
          const h = el ? el.getBoundingClientRect().height : Math.round(72 * cardScale);
          return { top: c.y, bottom: c.y + h };
        });

      return nearestFreeY(idealY, newCardEstHeight, boxes, rowGap);
    },
    [cardScale]
  );

  const handleAddChildCard = useCallback(
    (sourceCardId: string) => {
      pushUndoSnapshot();
      const childId = `card-${Date.now()}`;
      setCards((prev) => {
        const src = prev.find((c) => c.id === sourceCardId);
        if (!src) return prev;
        const nextX = src.x + Math.round(292 * cardScale);
        const nextY = findNonOverlappingY(nextX, src.y, 56, prev);
        // 父卡片收起时新子卡片会被一起隐藏，所以先展开父卡片。
        const base = src.collapsed
          ? prev.map((c) =>
              c.id === sourceCardId ? { ...c, collapsed: false } : c
            )
          : prev;

        return [
          ...base,
          {
            id: childId,
            x: nextX,
            y: nextY,
            kind: 'thought',
            body: '',
          },
        ];
      });
      setEdges((prev) => [
        ...prev,
        {
          id: `edge-${sourceCardId}-${childId}`,
          source: sourceCardId,
          target: childId,
          color: '#3b82f6',
        },
      ]);
      setSelectedCardId(childId);
    },
    [findNonOverlappingY]
  );

  // Structured Symmetric Auto-Layout: aligns visible cards into neat columns and centers child groups around their parent
  const handleAutoLayoutCards = useCallback(() => {
    const canvasEl = canvasRef.current;
    const bookEl = bookStickyRef.current;
    if (!canvasEl || !bookEl || visibleCards.length === 0) return;

    const canvasRect = canvasEl.getBoundingClientRect();
    const layoutCards = visibleCards;
    const layoutCardIds = new Set(layoutCards.map((c) => c.id));

    // 1. Measure actual DOM height of every visible card
    const cardHeightMap = new Map<string, number>();
    for (const c of layoutCards) {
      const el = canvasEl.querySelector<HTMLElement>(`[data-card-id="${c.id}"]`);
      cardHeightMap.set(c.id, el ? el.getBoundingClientRect().height : 64);
    }

    // 2. Measure true book anchor Y (in canvas local coordinate space) for anchored cards
    const anchorTargetYMap = new Map<string, number>();
    for (const anchor of anchors) {
      if (!anchor.targetNodeId || !layoutCardIds.has(anchor.targetNodeId)) continue;
      const anchorEl = findAnchorElement(bookEl, anchor);
      if (anchorEl) {
        const rect = anchorEl.getBoundingClientRect();
        if (rect.height > 0) {
          const localY = Math.max(20, rect.top - canvasRect.top - 10);
          anchorTargetYMap.set(anchor.targetNodeId, localY);
        }
      }
    }

    // 3. Build parent -> children graph from visible edges and assign column index (0, 1, 2, ...)
    const incomingMap = new Map<string, string[]>();
    const outgoingMap = new Map<string, string[]>();
    for (const edge of edges) {
      if (!layoutCardIds.has(edge.source) || !layoutCardIds.has(edge.target)) continue;
      incomingMap.set(edge.target, [...(incomingMap.get(edge.target) ?? []), edge.source]);
      outgoingMap.set(edge.source, [...(outgoingMap.get(edge.source) ?? []), edge.target]);
    }

    const colMap = new Map<string, number>();
    const visited = new Set<string>();

    const roots = layoutCards.filter(
      (c) => Boolean(c.anchorId) || (incomingMap.get(c.id)?.length ?? 0) === 0
    );

    const queue: { id: string; col: number }[] = roots.map((r) => ({
      id: r.id,
      col: 0,
    }));

    while (queue.length > 0) {
      const { id, col } = queue.shift()!;
      const prevCol = colMap.get(id) ?? -1;
      if (col > prevCol && col < 12) {
        colMap.set(id, col);
      }
      if (visited.has(`${id}-${col}`)) continue;
      visited.add(`${id}-${col}`);

      const children = outgoingMap.get(id) ?? [];
      for (const childId of children) {
        queue.push({ id: childId, col: col + 1 });
      }
    }

    for (const c of layoutCards) {
      if (!colMap.has(c.id)) colMap.set(c.id, 0);
    }

    // 4. Group visible cards by column index (0, 1, 2, ...)
    const maxCol = Math.max(0, ...Array.from(colMap.values()));
    const newPosMap = new Map<string, { x: number; y: number }>();

    // 第一列固定贴近书页右侧边缘，不再叠加 scrollLeft，避免画布平移状态下点整理把卡片永久推向右方。
    const COL_START_X = 44;
    const COL_STEP_X = Math.round(292 * cardScale);
    const ROW_GAP_Y = Math.max(10, Math.round(18 * cardScale));

    for (let col = 0; col <= maxCol; col++) {
      const colCards = layoutCards.filter((c) => (colMap.get(c.id) ?? 0) === col);
      const desiredYMap = new Map<string, number>();

      if (col === 0) {
        for (const c of colCards) {
          desiredYMap.set(c.id, anchorTargetYMap.get(c.id) ?? c.y);
        }
      } else {
        // Group children by their primary parent so siblings fan out symmetrically
        // both UP and DOWN around the parent's vertical midpoint!
        const byParent = new Map<string, AnnotationCardItem[]>();
        const orphans: AnnotationCardItem[] = [];

        for (const c of colCards) {
          const parents = (incomingMap.get(c.id) ?? []).filter((pid) =>
            newPosMap.has(pid)
          );
          if (parents.length > 0) {
            const primaryParent = parents[0];
            const list = byParent.get(primaryParent) ?? [];
            list.push(c);
            byParent.set(primaryParent, list);
          } else {
            orphans.push(c);
          }
        }

        for (const [parentId, siblings] of byParent.entries()) {
          siblings.sort((a, b) => a.y - b.y);
          const parentPos = newPosMap.get(parentId)!;
          const parentH = cardHeightMap.get(parentId) ?? 64;
          const parentCenterY = parentPos.y + parentH / 2;

          const totalHeight =
            siblings.reduce((sum, s) => sum + (cardHeightMap.get(s.id) ?? 64), 0) +
            Math.max(0, siblings.length - 1) * ROW_GAP_Y;

          let cursorY = Math.max(16, parentCenterY - totalHeight / 2);
          for (const s of siblings) {
            desiredYMap.set(s.id, cursorY);
            cursorY += (cardHeightMap.get(s.id) ?? 64) + ROW_GAP_Y;
          }
        }

        for (const o of orphans) {
          desiredYMap.set(o.id, anchorTargetYMap.get(o.id) ?? o.y);
        }
      }

      colCards.sort((a, b) => {
        const dy = (desiredYMap.get(a.id) ?? a.y) - (desiredYMap.get(b.id) ?? b.y);
        return Math.abs(dy) > 1 ? dy : a.y - b.y;
      });

      const targetX = COL_START_X + col * COL_STEP_X;
      const placedBoxes: PlacementBox[] = [];

      // 从下往上摆：最下面的卡片停在自己的锚点，上面的卡片依次往上叠，
      // 冲突时向上让，整列不会像旧实现那样一路往下漂。
      for (const c of [...colCards].reverse()) {
        const idealY = desiredYMap.get(c.id) ?? c.y;
        const cardH = cardHeightMap.get(c.id) ?? 64;
        const actualY = nearestFreeY(idealY, cardH, placedBoxes, ROW_GAP_Y, 16, 'up');
        newPosMap.set(c.id, { x: targetX, y: actualY });
        placedBoxes.push({ top: actualY, bottom: actualY + cardH });
      }
    }

    setCards((prev) => {
      let changed = false;
      const next = prev.map((c) => {
        const pos = newPosMap.get(c.id);
        if (!pos) return c;
        const anchorY = anchorTargetYMap.get(c.id);
        const nextOffset =
          c.anchorId && anchorY !== undefined
            ? Math.round(pos.y - anchorY)
            : c.anchorOffsetY;
        if (
          Math.abs(c.x - pos.x) <= 0.5 &&
          Math.abs(c.y - pos.y) <= 0.5 &&
          c.anchorOffsetY === nextOffset
        ) {
          return c;
        }
        changed = true;
        return {
          ...c,
          x: pos.x,
          y: pos.y,
          ...(nextOffset !== undefined ? { anchorOffsetY: nextOffset } : {}),
        };
      });
      return changed ? next : prev;
    });
  }, [visibleCards, anchors, edges, cardScale]);

  // 一键折叠 / 展开之后，等新的卡片高度落到 DOM 上，再整理一次布局，
  // 省得用户还得手动点一次「自动排列」。
  useEffect(() => {
    if (!pendingAutoLayoutRef.current) return;
    pendingAutoLayoutRef.current = false;
    const raf = requestAnimationFrame(() => handleAutoLayoutCards());
    return () => cancelAnimationFrame(raf);
  }, [cards, handleAutoLayoutCards]);

  const handleStartDragToBook = useCallback(
    (cardId: string, clientX: number, clientY: number) => {
      const outerEl = workspaceOuterRef.current;
      if (!outerEl) return;
      const outerRect = outerEl.getBoundingClientRect();
      const handleEl = outerEl.querySelector<HTMLElement>(
        `[data-card-handle-id="${cardId}"]`
      );
      const handleRect = handleEl?.getBoundingClientRect();

      const startX = handleRect
        ? handleRect.left + handleRect.width / 2 - outerRect.left
        : clientX - outerRect.left;
      const startY = handleRect
        ? handleRect.top + handleRect.height / 2 - outerRect.top
        : clientY - outerRect.top;

      setSelectedCardId(cardId);
      setDraggingWire({
        mode: 'to-book',
        sourceNodeId: cardId,
        startX,
        startY,
        currentX: clientX - outerRect.left,
        currentY: clientY - outerRect.top,
      });
    },
    []
  );

  const handleStartDragToCard = useCallback(
    (cardId: string, clientX: number, clientY: number) => {
      const outerEl = workspaceOuterRef.current;
      if (!outerEl) return;
      const outerRect = outerEl.getBoundingClientRect();
      const portEl = outerEl.querySelector<HTMLElement>(
        `[data-card-source-id="${cardId}"]`
      );
      const portRect = portEl?.getBoundingClientRect();

      const startX = portRect
        ? portRect.left + portRect.width / 2 - outerRect.left
        : clientX - outerRect.left;
      const startY = portRect
        ? portRect.top + portRect.height / 2 - outerRect.top
        : clientY - outerRect.top;

      setSelectedCardId(cardId);
      setDraggingWire({
        mode: 'to-card',
        sourceNodeId: cardId,
        startX,
        startY,
        currentX: clientX - outerRect.left,
        currentY: clientY - outerRect.top,
      });
    },
    []
  );

  const bindExistingCardToAnchor = useCallback(
    (
      cardId: string,
      anchorMeta: Omit<BookAnchor, 'id' | 'badgeNumber' | 'kind' | 'targetNodeId'>
    ) => {
      const anchorId = `anchor-${Date.now()}`;
      const existingCard = cards.find((c) => c.id === cardId);
      const kind = existingCard?.kind ?? 'thought';
      const sameKindCount = anchors.filter((a) => a.kind === kind).length;
      const badgeNumber = existingCard?.badgeNumber ?? sameKindCount + 1;

      const newAnchor: BookAnchor = {
        ...anchorMeta,
        id: anchorId,
        badgeNumber,
        kind,
        targetNodeId: cardId,
      };

      setAnchors((prev) => [...prev.filter((a) => a.targetNodeId !== cardId), newAnchor]);
      setCards((prev) =>
        prev.map((c) => {
          if (c.id !== cardId) return c;
          return {
            ...c,
            badgeNumber,
            anchorId,
            body: c.body.trim() === DEFAULT_FREE_CARD_TEXT ? '' : c.body,
          };
        })
      );
      setActiveAnchorId(anchorId);
    },
    [cards, anchors]
  );

  const completeDropWireOntoBook = useCallback(
    (sourceNodeId: string, clientX: number, clientY: number) => {
      const bookEl = bookStickyRef.current;
      if (!bookEl) return;
      const bookRect = bookEl.getBoundingClientRect();
      if (
        clientX < bookRect.left ||
        clientX > bookRect.right ||
        clientY < bookRect.top ||
        clientY > bookRect.bottom
      ) {
        return;
      }

      const hitElements = document.elementsFromPoint(clientX, clientY);

      if (docFormat === 'pdf') {
        const pageEl = hitElements.find(
          (el): el is HTMLElement => el instanceof HTMLElement && Boolean(el.dataset.pdfPage)
        );
        if (!pageEl) return;

        const pageNumber = Number(pageEl.dataset.pdfPage);
        const pageRect = pageEl.getBoundingClientRect();
        const textSpan = hitElements.find(
          (el): el is HTMLElement =>
            el instanceof HTMLElement && el.dataset.pdfTextItem === 'true'
        );

        let normRect: NormalizedPdfRect;
        let quoteText = `PDF 第 ${pageNumber} 页锚点`;

        if (textSpan) {
          const spanRect = textSpan.getBoundingClientRect();
          normRect = {
            x: Math.max(0, Math.min(0.96, (spanRect.left - pageRect.left) / pageRect.width)),
            y: Math.max(0, Math.min(0.98, (spanRect.top - pageRect.top) / pageRect.height)),
            w: Math.max(0.04, Math.min(1, spanRect.width / pageRect.width)),
            h: Math.max(0.016, Math.min(0.2, spanRect.height / pageRect.height)),
          };
          quoteText = textSpan.textContent?.trim() || quoteText;
        } else {
          const relX = (clientX - pageRect.left) / pageRect.width;
          const relY = (clientY - pageRect.top) / pageRect.height;
          const w = 0.16;
          const h = 0.024;
          normRect = {
            x: Math.max(0.02, Math.min(0.96 - w, relX - w / 2)),
            y: Math.max(0.01, Math.min(0.98 - h, relY - h / 2)),
            w,
            h,
          };
        }

        bindExistingCardToAnchor(sourceNodeId, {
          docFormat: 'pdf',
          paragraphId: `pdf-page-${pageNumber}`,
          pdfPage: pageNumber,
          pdfRects: [normRect],
          quote: quoteText,
          startOffset: 0,
          endOffset: quoteText.length,
          style: textSpan ? 'highlight' : 'pin',
        });
        return;
      }

      const paraEl = hitElements.find(
        (el): el is HTMLElement =>
          el instanceof HTMLElement && Boolean(el.dataset.paragraphId)
      );
      if (!paraEl || !paraEl.dataset.paragraphId) return;

      const paragraphId = paraEl.dataset.paragraphId;
      const fullText = paraEl.textContent || '';
      if (!fullText.trim()) return;

      const sentenceEnd = fullText.search(/[。！？.!?]/);
      const endOffset =
        sentenceEnd > 0 ? Math.min(fullText.length, sentenceEnd + 1) : Math.min(fullText.length, 55);
      const quote = fullText.slice(0, endOffset).trim();

      const para = paragraphs.find((p) => p.id === paragraphId);
      const epubCfi = para?.epubCfiBase ? `${para.epubCfiBase}/1:0` : undefined;

      bindExistingCardToAnchor(sourceNodeId, {
        docFormat,
        paragraphId,
        epubCfi,
        quote,
        startOffset: 0,
        endOffset,
        style: 'highlight',
      });
    },
    [docFormat, paragraphs, bindExistingCardToAnchor]
  );

  // Global mousemove / mouseup when dragging wire (to book or to another card)
  useEffect(() => {
    if (!draggingWire) return;

    const handleMouseMove = (e: MouseEvent) => {
      const outerEl = workspaceOuterRef.current;
      if (!outerEl) return;
      const outerRect = outerEl.getBoundingClientRect();
      setDraggingWire((prev) =>
        prev
          ? {
              ...prev,
              currentX: e.clientX - outerRect.left,
              currentY: e.clientY - outerRect.top,
            }
          : null
      );
    };

    const handleMouseUp = (e: MouseEvent) => {
      const { mode, sourceNodeId } = draggingWire;
      setDraggingWire(null);

      if (mode === 'to-book') {
        completeDropWireOntoBook(sourceNodeId, e.clientX, e.clientY);
      } else {
        const hitElements = document.elementsFromPoint(e.clientX, e.clientY);
        const targetCardEl = hitElements.find(
          (el): el is HTMLElement =>
            el instanceof HTMLElement &&
            Boolean(el.dataset.cardId) &&
            el.dataset.cardId !== sourceNodeId
        );
        if (targetCardEl?.dataset.cardId) {
          const targetId = targetCardEl.dataset.cardId;
          setEdges((prev) => {
            if (prev.some((ed) => ed.source === sourceNodeId && ed.target === targetId)) {
              return prev;
            }
            return [
              ...prev,
              {
                id: `edge-${sourceNodeId}-${targetId}-${Date.now()}`,
                source: sourceNodeId,
                target: targetId,
                color: '#3b82f6',
              },
            ];
          });
        }
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [draggingWire, completeDropWireOntoBook]);

  // Load the selected book plus its saved annotations.
  useEffect(() => {
    let cancelled = false;

    const disposeCurrentBook = () => {
      closePreviewImage();
      revokeCardImageUrls(cardsRef.current);
      setEpubImageLoader(null);
      setPdfSource(null);
    };

    const open = async () => {
      hydratedRef.current = false;
      lastProgressRef.current = null;
      restoreScrollRef.current = parseLocator(book.locator);
      setDocReady(false);
      setShowToc(false);

      try {
        if (book.format === 'pdf') {
          const size = await invoke<number>('book_file_size', { path: book.filePath });
          if (cancelled) return;
          disposeCurrentBook();
          setDocFormat('pdf');
          setBookTitle(book.title);
          setPdfSource({ kind: 'disk', path: book.filePath, size });
          setPdfScale(1);
          setToc([]);
        } else {
          // EPUB books are read straight from disk by byte range, so a 100MB+
          // archive never gets copied into the webview heap.
          const source = { diskPath: book.filePath };
          const [parsed, cachedDims] = await Promise.all([
            parseEpubFile(source),
            loadEpubImageDims(book.id),
          ]);
          if (cancelled) return;
          epubDimsRef.current = cachedDims;
          epubDimsDirtyRef.current = false;
          const sizedParagraphs = parsed.paragraphs.map((p) => {
            if (p.type !== 'image' || !p.imagePath) return p;
            if (p.imageWidth && p.imageHeight) return p;
            const dims = cachedDims[p.imagePath];
            return dims ? { ...p, imageWidth: dims[0], imageHeight: dims[1] } : p;
          });
          disposeCurrentBook();
          setDocFormat('epub');
          setBookTitle(parsed.title);
          setParagraphs(sizedParagraphs);
          setEpubImageLoader(new EpubImageLoader(source));
          setToc(parsed.toc);
        }

        const saved = await loadAnnotations(book.id);
        if (cancelled) return;
        const restoredCards = saved ? await restoreThumbUrls(saved.cards) : [];
        if (cancelled) return;

        setAnchors(saved?.anchors ?? []);
        setCards(restoredCards);
        setEdges(saved?.edges ?? []);
        pendingInitialAlignRef.current = restoredCards.some((c) => Boolean(c.anchorId));
        setActiveAnchorId(null);
        setSelectedCardId(null);
        setLoadError(null);
      } catch (err) {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : '打开书籍失败');
      } finally {
        if (!cancelled) {
          hydratedRef.current = true;
          setDocReady(true);
          setTimeout(bumpSync, 80);
        }
      }
    };

    void open();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book]);

  const paragraphIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    paragraphs.forEach((p, idx) => map.set(p.id, idx));
    return map;
  }, [paragraphs]);

  const applySavedLocator = useCallback((target: SavedLocator | null) => {
    const el = unifiedScrollRef.current;
    if (!el) return;
    if (!target) {
      el.scrollLeft = 0;
      return;
    }
    const bookEl = bookStickyRef.current;
    let positionedByAnchor = false;
    if (bookEl && target.paragraphId) {
      const node = bookEl.querySelector<HTMLElement>(
        `[data-paragraph-id="${target.paragraphId}"]`
      );
      if (node) {
        const offset =
          node.getBoundingClientRect().top - el.getBoundingClientRect().top;
        el.scrollTop = Math.max(0, el.scrollTop + offset - (target.offsetY ?? 0));
        positionedByAnchor = true;
      }
    } else if (bookEl && target.pdfPage) {
      const pageNode = bookEl.querySelector<HTMLElement>(
        `[data-pdf-page="${target.pdfPage}"]`
      );
      if (pageNode) {
        const offset =
          pageNode.getBoundingClientRect().top - el.getBoundingClientRect().top;
        el.scrollTop = Math.max(0, el.scrollTop + offset - (target.offsetY ?? 0));
        positionedByAnchor = true;
      }
    }
    if (!positionedByAnchor) {
      el.scrollTop = target.top;
    }
    const minCardX = cardsRef.current.reduce(
      (min, card) => Math.min(min, card.x),
      Number.POSITIVE_INFINITY
    );
    const maxLeft = Number.isFinite(minCardX)
      ? Math.max(0, minCardX - 16)
      : target.left;
    el.scrollLeft = Math.min(target.left, maxLeft);
  }, []);

  // 按每个锚点卡片的相对偏移（anchorOffsetY）平滑跟随书页变化，并在移位后做同列防重叠保护。
  const realignDriftedCardsIfNeeded = useCallback(() => {
    const canvasEl = canvasRef.current;
    const bookEl = bookStickyRef.current;
    if (!canvasEl || !bookEl || visibleCards.length === 0) return;
    const canvasRect = canvasEl.getBoundingClientRect();

    const anchorLocalYByCard = new Map<string, number>();
    const deltaByRoot = new Map<string, number>();
    let maxDrift = 0;
    for (const anchor of anchors) {
      if (!anchor.targetNodeId) continue;
      const card = visibleCards.find((c) => c.id === anchor.targetNodeId);
      if (!card) continue;
      const anchorEl = findAnchorElement(bookEl, anchor);
      if (!anchorEl) continue;
      const rect = anchorEl.getBoundingClientRect();
      if (rect.height <= 0) continue;
      const localY = Math.max(20, rect.top - canvasRect.top - 10);
      anchorLocalYByCard.set(card.id, localY);
      const targetY = Math.max(16, Math.round(localY + (card.anchorOffsetY ?? 0)));
      const diff = targetY - card.y;
      if (Math.abs(diff) > 12) {
        deltaByRoot.set(card.id, diff);
        maxDrift = Math.max(maxDrift, Math.abs(diff));
      }
    }
    if (deltaByRoot.size === 0) return;

    if (maxDrift > 36 && visibleCards.every((c) => c.anchorOffsetY === undefined)) {
      handleAutoLayoutCards();
      return;
    }

    const outgoing = new Map<string, string[]>();
    for (const edge of edges) {
      outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target]);
    }
    const shiftById = new Map<string, number>();
    for (const [rootId, delta] of deltaByRoot.entries()) {
      const queue = [rootId];
      while (queue.length > 0) {
        const id = queue.shift()!;
        if (shiftById.has(id)) continue;
        shiftById.set(id, delta);
        for (const childId of outgoing.get(id) ?? []) {
          if (!deltaByRoot.has(childId)) queue.push(childId);
        }
      }
    }

    // 计算移位后的理想 Y，并按列从下往上做防重叠求解，确保绝不把两张卡片压到一起。
    const cardHeightMap = new Map<string, number>();
    for (const c of visibleCards) {
      const el = canvasEl.querySelector<HTMLElement>(`[data-card-id="${c.id}"]`);
      cardHeightMap.set(c.id, el ? el.getBoundingClientRect().height : 64);
    }

    const proposedY = new Map<string, number>();
    for (const c of visibleCards) {
      const delta = shiftById.get(c.id) ?? 0;
      proposedY.set(c.id, Math.max(16, Math.round(c.y + delta)));
    }

    const resolvedY = new Map<string, number>();
    const sorted = [...visibleCards].sort(
      (a, b) => (proposedY.get(b.id) ?? b.y) - (proposedY.get(a.id) ?? a.y)
    );
    const placed: { x: number; top: number; bottom: number }[] = [];
    const colThreshold = Math.round(252 * cardScale);
    const rowGap = Math.max(10, Math.round(18 * cardScale));
    for (const c of sorted) {
      const idealY = proposedY.get(c.id) ?? c.y;
      const h = cardHeightMap.get(c.id) ?? 64;
      const sameColBoxes: PlacementBox[] = placed
        .filter((p) => Math.abs(p.x - c.x) < colThreshold)
        .map((p) => ({ top: p.top, bottom: p.bottom }));
      const finalY = nearestFreeY(idealY, h, sameColBoxes, rowGap, 16, 'up');
      resolvedY.set(c.id, finalY);
      placed.push({ x: c.x, top: finalY, bottom: finalY + h });
    }

    setCards((prev) => {
      let changed = false;
      const next = prev.map((c) => {
        const nextY = resolvedY.get(c.id);
        if (nextY === undefined || Math.abs(nextY - c.y) <= 0.5) return c;
        changed = true;
        const anchorY = anchorLocalYByCard.get(c.id);
        return {
          ...c,
          y: nextY,
          ...(c.anchorId && anchorY !== undefined
            ? { anchorOffsetY: Math.round(nextY - anchorY) }
            : {}),
        };
      });
      return changed ? next : prev;
    });
  }, [anchors, edges, visibleCards, handleAutoLayoutCards, cardScale]);

  const realignRef = useRef(realignDriftedCardsIfNeeded);
  realignRef.current = realignDriftedCardsIfNeeded;
  const recomputeEdgesRef = useRef(recomputeCardEdges);
  recomputeEdgesRef.current = recomputeCardEdges;
  const autoLayoutRef = useRef(handleAutoLayoutCards);
  autoLayoutRef.current = handleAutoLayoutCards;

  // 仅在字号、行高、书栏宽度变化时触发平滑跟随；卡片缩放变化时按新比例重排间距。
  useEffect(() => {
    if (!docReady) return;
    const timer = window.setTimeout(() => {
      realignRef.current();
      recomputeEdgesRef.current();
    }, 100);
    return () => window.clearTimeout(timer);
  }, [docReady, settings.fontSize, settings.lineHeight, bookWidth]);

  const prevCardScaleRef = useRef(cardScale);
  useEffect(() => {
    if (prevCardScaleRef.current === cardScale) return;
    prevCardScaleRef.current = cardScale;
    if (!docReady) return;
    const timer = window.setTimeout(() => {
      autoLayoutRef.current();
      recomputeEdgesRef.current();
    }, 60);
    return () => window.clearTimeout(timer);
  }, [docReady, cardScale]);

  // 右侧画布支持 ⌘/Ctrl + 滚轮进行锚点原地缩放。
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.metaKey && !e.ctrlKey) return;
      e.preventDefault();
      const step = e.deltaY < 0 ? 0.1 : -0.1;
      const next = Math.min(1.2, Math.max(0.5, +(prevCardScaleRef.current + step).toFixed(2)));
      if (next !== prevCardScaleRef.current) {
        onSettingsChange({ cardScale: next });
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [onSettingsChange]);

  const handleStartAnnotateImage = useCallback(async (cardId: string, image: CardImage) => {
    const url = await createFullImageUrl(image);
    if (!url) return;
    setAnnotatingImage({ cardId, image, url });
  }, []);

  const handleCloseAnnotator = useCallback(() => {
    setAnnotatingImage((cur) => {
      if (cur) revokeObjectUrlIfBlob(cur.url);
      return null;
    });
  }, []);

  const handleSaveAnnotatedImage = useCallback(
    async (file: File) => {
      const target = annotatingImage;
      if (!target) return;
      const imported = await importImageFiles([file]);
      const replacement = imported[0];
      if (!replacement) {
        handleCloseAnnotator();
        return;
      }
      pushUndoSnapshot();
      pendingDeleteImagesRef.current.set(target.image.id, target.image);
      pendingDeleteImagesRef.current.set(replacement.id, replacement);
      setCards((prev) =>
        prev.map((c) =>
          c.id === target.cardId
            ? {
                ...c,
                images: (c.images ?? []).map((img) =>
                  img.id === target.image.id ? replacement : img
                ),
              }
            : c
        )
      );
      handleCloseAnnotator();
    },
    [annotatingImage, handleCloseAnnotator, pushUndoSnapshot]
  );

  // EPUB 懒加载图片撑开书页高度后，缓存其真实尺寸，并及时重绘引线与对齐锚点卡片。
  const handleEpubImageLoaded = useCallback(
    (imagePath?: string, width?: number, height?: number) => {
      if (imagePath && width && height) {
        const prev = epubDimsRef.current[imagePath];
        if (!prev || prev[0] !== width || prev[1] !== height) {
          epubDimsRef.current[imagePath] = [width, height];
          epubDimsDirtyRef.current = true;
          if (epubDimsTimerRef.current) window.clearTimeout(epubDimsTimerRef.current);
          epubDimsTimerRef.current = window.setTimeout(() => {
            epubDimsTimerRef.current = null;
            if (!epubDimsDirtyRef.current) return;
            epubDimsDirtyRef.current = false;
            void saveEpubImageDims(book.id, epubDimsRef.current);
          }, 800);
        }
      }
      recomputeCardEdges();
      if (imageAlignTimerRef.current) window.clearTimeout(imageAlignTimerRef.current);
      imageAlignTimerRef.current = window.setTimeout(() => {
        imageAlignTimerRef.current = null;
        if (!userInteractedAfterOpenRef.current && activeRestoreTargetRef.current) {
          applySavedLocator(activeRestoreTargetRef.current);
        }
        realignDriftedCardsIfNeeded();
        recomputeCardEdges();
      }, 150);
    },
    [book.id, applySavedLocator, realignDriftedCardsIfNeeded, recomputeCardEdges]
  );

  useEffect(() => {
    return () => {
      if (imageAlignTimerRef.current) window.clearTimeout(imageAlignTimerRef.current);
      if (epubDimsTimerRef.current) window.clearTimeout(epubDimsTimerRef.current);
      if (epubDimsDirtyRef.current) {
        epubDimsDirtyRef.current = false;
        void saveEpubImageDims(book.id, epubDimsRef.current);
      }
      // 离开书籍时，清理确认不再被任何卡片引用的待删除图片文件（保留撤销期间的无损恢复能力）。
      const liveImageIds = new Set<string>();
      for (const card of latestAnnotationsRef.current.cards) {
        for (const img of card.images ?? []) liveImageIds.add(img.id);
      }
      for (const [id, img] of pendingDeleteImagesRef.current.entries()) {
        if (!liveImageIds.has(id)) {
          void deleteStoredImage(img);
        }
      }
      pendingDeleteImagesRef.current.clear();
    };
  }, [book.id]);

  // Restore the reading position once layout has settled, and auto-align drifted cards on open.
  useEffect(() => {
    if (!docReady) return;
    const target = restoreScrollRef.current;
    restoreScrollRef.current = null;
    activeRestoreTargetRef.current = target;
    userInteractedAfterOpenRef.current = false;
    setReadingProgress(book.progress ?? 0);
    const el = unifiedScrollRef.current;
    if (!el) return;

    const markUserInteracted = () => {
      userInteractedAfterOpenRef.current = true;
      activeRestoreTargetRef.current = null;
    };
    el.addEventListener('wheel', markUserInteracted, { passive: true });
    el.addEventListener('pointerdown', markUserInteracted, { passive: true });

    const apply = () => {
      if (userInteractedAfterOpenRef.current) return;
      applySavedLocator(target);
      if (pendingInitialAlignRef.current) {
        pendingInitialAlignRef.current = false;
        realignDriftedCardsIfNeeded();
      }
      bumpSync();
    };

    const raf = requestAnimationFrame(apply);
    const settle = window.setTimeout(apply, 160);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(settle);
      el.removeEventListener('wheel', markUserInteracted);
      el.removeEventListener('pointerdown', markUserInteracted);
    };
  }, [docReady, book.progress, applySavedLocator, realignDriftedCardsIfNeeded, bumpSync]);

  const flushAnnotationsNow = useCallback(() => {
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (!dirtyAnnotationsRef.current) return;
    dirtyAnnotationsRef.current = false;
    const snapshot = latestAnnotationsRef.current;
    void saveAnnotations(snapshot.bookId, {
      anchors: snapshot.anchors,
      cards: snapshot.cards.map((card) => ({
        ...card,
        images: card.images?.map((image) => ({
          id: image.id,
          thumbUrl: '',
          width: image.width,
          height: image.height,
          ...(image.filePath ? { filePath: image.filePath } : {}),
          ...(image.thumbPath ? { thumbPath: image.thumbPath } : {}),
        })),
      })),
      edges: snapshot.edges,
    }).catch((err) => console.warn('保存批注失败', err));
  }, []);

  // Persist annotations (debounced so typing stays smooth, flushed on unmount/close).
  useEffect(() => {
    latestAnnotationsRef.current = { bookId: book.id, anchors, cards, edges };
    if (!hydratedRef.current) return;
    dirtyAnnotationsRef.current = true;
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(flushAnnotationsNow, 600);
    return () => {
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [book.id, anchors, cards, edges, flushAnnotationsNow]);

  useEffect(() => {
    const handleBeforeUnload = () => flushAnnotationsNow();
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      flushAnnotationsNow();
    };
  }, [flushAnnotationsNow]);

  useEffect(() => {
    if (!showToc) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowToc(false);
    };
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest('.toc-panel')) return;
      if (target.closest('[data-toc-toggle="true"]')) return;
      setShowToc(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('mousedown', onMouseDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('mousedown', onMouseDown);
    };
  }, [showToc]);

  useEffect(() => {
    if (!showReviewDrawer) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowReviewDrawer(false);
    };
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest('.review-drawer')) return;
      if (target.closest('[data-review-toggle="true"]')) return;
      setShowReviewDrawer(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('mousedown', onMouseDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('mousedown', onMouseDown);
    };
  }, [showReviewDrawer]);

  useEffect(() => {
    if (!pdfCropMode) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPdfCropMode(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [pdfCropMode]);

  const handleTocJump = useCallback((entry: TocEntry) => {
    const selector =
      entry.kind === 'pdf'
        ? `[data-pdf-page="${entry.target}"]`
        : `[data-paragraph-id="${entry.target}"]`;
    const target = bookStickyRef.current?.querySelector<HTMLElement>(selector);
    const scroller = unifiedScrollRef.current;
    if (target && scroller) {
      // Set scrollTop explicitly: scrollIntoView misaligns inside a sticky
      // column, while this lands the heading exactly at the viewport top.
      const offset =
        target.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      scroller.scrollTo({
        top: Math.max(0, scroller.scrollTop + offset - 8),
        left: scroller.scrollLeft,
        behavior: 'auto',
      });
      bumpSync();
    }
    setShowToc(false);
  }, [bumpSync]);

  // Keep the pane width in sync when settings change from the settings dialog.
  useEffect(() => {
    setBookWidth(settings.bookWidth);
    bookWidthRef.current = settings.bookWidth;
  }, [settings.bookWidth]);

  const computeReadingSnapshot = useCallback((): {
    progress: number;
    locator: string;
  } | null => {
    const el = unifiedScrollRef.current;
    if (!el) return null;
    const scrollerRect = el.getBoundingClientRect();
    const max = el.scrollHeight - el.clientHeight;
    const fallbackRatio = max > 0 ? Math.min(1, Math.max(0, el.scrollTop / max)) : 0;
    const saved: SavedLocator = {
      top: Math.round(el.scrollTop),
      left: Math.round(el.scrollLeft),
    };
    let ratio = fallbackRatio;

    const bookEl = bookStickyRef.current;
    if (bookEl && docFormat === 'epub') {
      const nodes = bookEl.querySelectorAll<HTMLElement>('[data-paragraph-id]');
      for (let i = 0; i < nodes.length; i += 1) {
        const rect = nodes[i].getBoundingClientRect();
        if (rect.bottom > scrollerRect.top + 8) {
          const pid = nodes[i].dataset.paragraphId;
          if (pid) {
            saved.paragraphId = pid;
            saved.offsetY = Math.round(rect.top - scrollerRect.top);
            const idx = paragraphIndexMap.get(pid);
            if (idx !== undefined && paragraphs.length > 1) {
              ratio = max > 0 && el.scrollTop >= max - 4
                ? 1
                : Math.min(1, Math.max(0, idx / (paragraphs.length - 1)));
            }
          }
          break;
        }
      }
    } else if (bookEl && docFormat === 'pdf') {
      const pages = bookEl.querySelectorAll<HTMLElement>('[data-pdf-page]');
      for (let i = 0; i < pages.length; i += 1) {
        const rect = pages[i].getBoundingClientRect();
        if (rect.bottom > scrollerRect.top + 8) {
          const pageNum = Number(pages[i].dataset.pdfPage);
          if (Number.isFinite(pageNum) && pageNum > 0) {
            saved.pdfPage = pageNum;
            saved.offsetY = Math.round(rect.top - scrollerRect.top);
            if (pages.length > 1) {
              ratio = max > 0 && el.scrollTop >= max - 4
                ? 1
                : Math.min(1, Math.max(0, (pageNum - 1) / (pages.length - 1)));
            }
          }
          break;
        }
      }
    }

    return { progress: ratio, locator: JSON.stringify(saved) };
  }, [docFormat, paragraphIndexMap, paragraphs.length]);

  const handleScroll = useCallback(() => {
    // 滚动后操作条会错位，直接收起。
    setAnchorActions((prev) => (prev ? null : prev));
    bumpSync();
    const el = unifiedScrollRef.current;
    if (!el) return;
    if (progressTimerRef.current) window.clearTimeout(progressTimerRef.current);
    progressTimerRef.current = window.setTimeout(() => {
      const snap = computeReadingSnapshot();
      if (!snap) return;
      setReadingProgress(snap.progress);
      lastProgressRef.current = snap;
      onProgress(book.id, snap.progress, snap.locator);
    }, 350);
  }, [book.id, bumpSync, computeReadingSnapshot, onProgress]);

  // Flush the pending reading position when leaving the book.
  useEffect(() => {
    return () => {
      if (progressTimerRef.current) window.clearTimeout(progressTimerRef.current);
      const last = lastProgressRef.current;
      if (!last) return;
      onProgress(book.id, last.progress, last.locator);
    };
  }, [book.id, onProgress]);

  const spawnCardForAnchor = useCallback(
    (
      anchorMeta: Omit<BookAnchor, 'id' | 'badgeNumber' | 'kind' | 'targetNodeId'>,
      anchorScreenY: number,
      linkToExistingNodeId?: string
    ) => {
      if (linkToExistingNodeId) {
        pushUndoSnapshot();
        bindExistingCardToAnchor(linkToExistingNodeId, anchorMeta);
        return;
      }

      pushUndoSnapshot();
      const kind = anchorMeta.style === 'highlight' ? 'review' : 'revision';
      const sameKindCount = anchors.filter((a) => a.kind === kind).length;
      const badgeNumber = sameKindCount + 1;
      const anchorId = `anchor-${Date.now()}`;
      const cardId = `card-${Date.now()}`;

      // Convert screen Y directly into unified canvas Y (same native scroll coordinate!)
      const canvasRect = canvasRef.current?.getBoundingClientRect();
      const rawY = canvasRect ? Math.max(20, anchorScreenY - canvasRect.top - 20) : 100;
      const estHeight = 64;
      // Place the card just right of the visible book edge so a panned canvas
      // never hides it under the sticky column.
      const cardX = (unifiedScrollRef.current?.scrollLeft ?? 0) + 44;
      const candidateY = findNonOverlappingY(cardX, rawY, estHeight, cards);

      const newAnchor: BookAnchor = {
        ...anchorMeta,
        id: anchorId,
        badgeNumber,
        kind,
        targetNodeId: cardId,
      };

      const newCard: AnnotationCardItem = {
        id: cardId,
        x: cardX,
        y: candidateY,
        kind,
        badgeNumber,
        body: '',
        status: kind === 'revision' ? 'pending' : undefined,
        anchorId,
        anchorOffsetY: Math.round(candidateY - rawY),
      };

      setAnchors((prev) => [...prev, newAnchor]);
      setCards((prev) => [...prev, newCard]);
      setActiveAnchorId(anchorId);
      setSelectedCardId(cardId);
      setAutoFocusCardId(cardId);
    },
    [anchors, cards, bindExistingCardToAnchor, findNonOverlappingY, pushUndoSnapshot]
  );

  // 将已有的纯高亮/纯划线标注一键升级为带连线的空白批注卡
  const handlePromoteAnchorToCard = useCallback(
    (anchor: BookAnchor) => {
      pushUndoSnapshot();
      const kind = anchor.style === 'highlight' ? 'review' : 'revision';
      const sameKindCount = anchors.filter((a) => a.kind === kind && a.targetNodeId).length;
      const badgeNumber = sameKindCount + 1;
      const cardId = `card-${Date.now()}`;

      const bookEl = bookStickyRef.current;
      const canvasRect = canvasRef.current?.getBoundingClientRect();
      const anchorEl = bookEl ? findAnchorElement(bookEl, anchor) : null;
      const anchorRect = anchorEl?.getBoundingClientRect();
      const anchorScreenY = anchorRect
        ? anchorRect.top + anchorRect.height / 2
        : anchorActions?.y ?? 200;
      const rawY = canvasRect ? Math.max(20, anchorScreenY - canvasRect.top - 20) : 100;
      const cardX = (unifiedScrollRef.current?.scrollLeft ?? 0) + 44;
      const candidateY = findNonOverlappingY(cardX, rawY, 64, cards);

      const newCard: AnnotationCardItem = {
        id: cardId,
        x: cardX,
        y: candidateY,
        kind,
        badgeNumber,
        body: '',
        status: kind === 'revision' ? 'pending' : undefined,
        anchorId: anchor.id,
        anchorOffsetY: Math.round(candidateY - rawY),
      };

      setAnchors((prev) =>
        prev.map((a) =>
          a.id === anchor.id
            ? { ...a, targetNodeId: cardId, badgeNumber, kind }
            : a
        )
      );
      setCards((prev) => [...prev, newCard]);
      setAnchorActions(null);
      setActiveAnchorId(anchor.id);
      setSelectedCardId(cardId);
      setAutoFocusCardId(cardId);
    },
    [anchors, cards, anchorActions, findNonOverlappingY, pushUndoSnapshot]
  );

  // 基础标注：只在书页上留下高亮/划线，不创建右侧卡片。
  const createPlainAnchor = useCallback(
    (
      anchorMeta: Omit<BookAnchor, 'id' | 'badgeNumber' | 'kind' | 'targetNodeId'>
    ) => {
      pushUndoSnapshot();
      const newAnchor: BookAnchor = {
        ...anchorMeta,
        id: `anchor-${Date.now()}`,
        badgeNumber: 0,
        kind: anchorMeta.style === 'highlight' ? 'review' : 'revision',
      };
      setAnchors((prev) => [...prev, newAnchor]);
      setActiveAnchorId(newAnchor.id);
    },
    [pushUndoSnapshot]
  );

  const handleCreateTextAnnotation = useCallback(
    (draft: {
      paragraphId: string;
      quote: string;
      startOffset: number;
      endOffset: number;
      style: AnnotationStyle;
      color?: AnchorColor;
      anchorScreenY: number;
      /** false 时只做基础标注，不生成卡片。 */
      withCard?: boolean;
      linkToExistingNodeId?: string;
    }) => {
      const para = paragraphs.find((p) => p.id === draft.paragraphId);
      const epubCfi = para?.epubCfiBase
        ? `${para.epubCfiBase}/1:${draft.startOffset}`
        : undefined;
      const anchorMeta = {
        docFormat,
        paragraphId: draft.paragraphId,
        epubCfi,
        quote: draft.quote,
        startOffset: draft.startOffset,
        endOffset: draft.endOffset,
        style: draft.style,
        color: draft.color,
      };

      if (draft.withCard === false) {
        createPlainAnchor(anchorMeta);
        return;
      }
      spawnCardForAnchor(anchorMeta, draft.anchorScreenY, draft.linkToExistingNodeId);
    },
    [paragraphs, docFormat, spawnCardForAnchor, createPlainAnchor]
  );

  const handleCreatePdfAnnotation = useCallback(
    (draft: {
      pageNumber: number;
      quote: string;
      rects: NormalizedPdfRect[];
      style: AnnotationStyle;
      color?: AnchorColor;
      anchorScreenY: number;
      /** false 时只做基础标注，不生成卡片。 */
      withCard?: boolean;
      linkToExistingNodeId?: string;
    }) => {
      const anchorMeta = {
        docFormat: 'pdf' as const,
        paragraphId: `pdf-page-${draft.pageNumber}`,
        pdfPage: draft.pageNumber,
        pdfRects: draft.rects,
        quote: draft.quote,
        startOffset: 0,
        endOffset: draft.quote.length,
        style: draft.style,
        color: draft.color,
      };

      if (draft.withCard === false) {
        createPlainAnchor(anchorMeta);
        return;
      }
      spawnCardForAnchor(anchorMeta, draft.anchorScreenY, draft.linkToExistingNodeId);
    },
    [spawnCardForAnchor, createPlainAnchor]
  );

  // 将书页中的 EPUB 插图一键转为右侧带图批注卡片并连线到该图
  const handleCreateImageCard = useCallback(
    async (paragraphId: string, blob: Blob, alt: string, anchorScreenY: number) => {
      const ext = blob.type.includes('png')
        ? 'png'
        : blob.type.includes('webp')
          ? 'webp'
          : 'jpg';
      const file = new File([blob], `epub-figure-${Date.now()}.${ext}`, {
        type: blob.type || 'image/png',
      });
      const imported = await importImageFiles([file]);
      if (imported.length === 0) return;
      for (const img of imported) {
        pendingDeleteImagesRef.current.set(img.id, img);
      }

      pushUndoSnapshot();
      const anchorId = `anchor-${Date.now()}`;
      const cardId = `card-${Date.now()}`;
      const badgeNumber =
        latestAnnotationsRef.current.anchors.filter((a) => a.kind === 'thought').length + 1;

      const canvasRect = canvasRef.current?.getBoundingClientRect();
      const rawY = canvasRect ? Math.max(20, anchorScreenY - canvasRect.top - 20) : 100;
      const cardX = (unifiedScrollRef.current?.scrollLeft ?? 0) + 44;
      const candidateY = findNonOverlappingY(cardX, rawY, 180, cardsRef.current);

      const newAnchor: BookAnchor = {
        id: anchorId,
        docFormat: 'epub',
        paragraphId,
        quote: alt || '插图批注',
        startOffset: 0,
        endOffset: 0,
        style: 'pin',
        color: 'blue',
        badgeNumber,
        kind: 'thought',
        targetNodeId: cardId,
      };

      const newCard: AnnotationCardItem = {
        id: cardId,
        x: cardX,
        y: candidateY,
        kind: 'thought',
        badgeNumber,
        body: '',
        images: imported,
        anchorId,
        anchorOffsetY: Math.round(candidateY - rawY),
      };

      setAnchors((prev) => [...prev, newAnchor]);
      setCards((prev) => [...prev, newCard]);
      setActiveAnchorId(anchorId);
      setSelectedCardId(cardId);
      setAutoFocusCardId(cardId);
    },
    [findNonOverlappingY, pushUndoSnapshot]
  );

  // 将 PDF 框选裁切区域直接转为右侧带图批注卡片并锚定到该 PDF 区域
  const handleCreatePdfCropCard = useCallback(
    async (draft: {
      pageNumber: number;
      rect: NormalizedPdfRect;
      blob: Blob;
      anchorScreenY: number;
    }) => {
      const file = new File(
        [draft.blob],
        `pdf-p${draft.pageNumber}-${Date.now()}.png`,
        { type: 'image/png' }
      );
      const imported = await importImageFiles([file]);
      if (imported.length === 0) return;
      for (const img of imported) {
        pendingDeleteImagesRef.current.set(img.id, img);
      }

      pushUndoSnapshot();
      const anchorId = `anchor-${Date.now()}`;
      const cardId = `card-${Date.now()}`;
      const badgeNumber =
        latestAnnotationsRef.current.anchors.filter((a) => a.kind === 'thought').length + 1;

      const canvasRect = canvasRef.current?.getBoundingClientRect();
      const rawY = canvasRect
        ? Math.max(20, draft.anchorScreenY - canvasRect.top - 20)
        : 100;
      const cardX = (unifiedScrollRef.current?.scrollLeft ?? 0) + 44;
      const candidateY = findNonOverlappingY(cardX, rawY, 180, cardsRef.current);

      const newAnchor: BookAnchor = {
        id: anchorId,
        docFormat: 'pdf',
        paragraphId: `pdf-page-${draft.pageNumber}`,
        pdfPage: draft.pageNumber,
        pdfRects: [draft.rect],
        quote: `PDF 第 ${draft.pageNumber} 页图表截图`,
        startOffset: 0,
        endOffset: 0,
        style: 'pin',
        color: 'blue',
        badgeNumber,
        kind: 'thought',
        targetNodeId: cardId,
      };

      const newCard: AnnotationCardItem = {
        id: cardId,
        x: cardX,
        y: candidateY,
        kind: 'thought',
        badgeNumber,
        body: '',
        images: imported,
        anchorId,
        anchorOffsetY: Math.round(candidateY - rawY),
      };

      setAnchors((prev) => [...prev, newAnchor]);
      setCards((prev) => [...prev, newCard]);
      setActiveAnchorId(anchorId);
      setSelectedCardId(cardId);
      setAutoFocusCardId(cardId);
    },
    [findNonOverlappingY, pushUndoSnapshot]
  );

  const handleClickBookAnchor = useCallback((anchor: BookAnchor, point?: { x: number; y: number }) => {
    setActiveAnchorId(anchor.id);
    // 基础标注没有关联卡片，点击后弹出删除入口。
    const targetId = anchor.targetNodeId;
    if (!targetId) {
      setSelectedCardId(null);
      if (point) {
        setAnchorActions({ anchorId: anchor.id, x: point.x, y: point.y });
      }
      return;
    }
    setAnchorActions(null);
    setSelectedCardId(targetId);

    // 目标卡片可能被祖先折叠隐藏：先展开祖先链和它自己，再滚动定位。
    const parentsByChild = new Map<string, string[]>();
    for (const edge of edgesRef.current) {
      const list = parentsByChild.get(edge.target);
      if (list) list.push(edge.source);
      else parentsByChild.set(edge.target, [edge.source]);
    }
    const related = new Set<string>([targetId]);
    const stack = [...(parentsByChild.get(targetId) ?? [])];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (related.has(id)) continue;
      related.add(id);
      stack.push(...(parentsByChild.get(id) ?? []));
    }
    setCards((prev) =>
      prev.some((c) => related.has(c.id) && c.collapsed)
        ? prev.map((c) =>
            related.has(c.id) && c.collapsed ? { ...c, collapsed: false } : c
          )
        : prev
    );
    setRevealCardId(targetId);
  }, []);

  const handleCreateFreeCard = () => {
    const scrollEl = unifiedScrollRef.current;
    const cardId = `card-free-${Date.now()}`;
    const idealY = scrollEl ? scrollEl.scrollTop + 140 : 140;
    const x = scrollEl ? Math.max(44, scrollEl.scrollLeft + 44) : 44;
    const y = findNonOverlappingY(x, idealY, 72, cards);

    setCards((prev) => [
      ...prev,
      {
        id: cardId,
        x,
        y,
        kind: 'thought',
        body: DEFAULT_FREE_CARD_TEXT,
      },
    ]);
    setSelectedCardId(cardId);
  };

  // Dragging blank canvas background pans both horizontally and vertically smoothly
  const handleCanvasBackgroundMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest('[data-card-id]') || target.closest('.edge-delete-btn')) return;

    setActiveAnchorId(null);
    setSelectedCardId(null);

    const scrollEl = unifiedScrollRef.current;
    if (!scrollEl) return;

    setIsPanningCanvas(true);
    const startX = e.clientX;
    const startY = e.clientY;
    const origLeft = scrollEl.scrollLeft;
    const origTop = scrollEl.scrollTop;

    const handleMouseMove = (moveEvt: MouseEvent) => {
      scrollEl.scrollLeft = origLeft - (moveEvt.clientX - startX);
      scrollEl.scrollTop = origTop - (moveEvt.clientY - startY);
    };

    const handleMouseUp = () => {
      setIsPanningCanvas(false);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  // Resizable left book column width
  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      const nextWidth = Math.max(340, Math.min(920, e.clientX));
      bookWidthRef.current = nextWidth;
      setBookWidth(nextWidth);
      // Do not touch scrollLeft here: the canvas lives after the sticky book
      // column, so cards already move with the column edge. Compensating the
      // scroll would slide cards underneath the widened column.
      bumpSync();
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      onSettingsChange({ bookWidth: bookWidthRef.current });
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing, bumpSync, onSettingsChange]);

  useEffect(() => {
    window.addEventListener('resize', recomputeCardEdges);
    return () => window.removeEventListener('resize', recomputeCardEdges);
  }, [recomputeCardEdges]);

  return (
    <div className="app-shell">
      <header className="topbar" data-tauri-drag-region>
        <div className="topbar__left" data-tauri-drag-region>
          <button
            type="button"
            className="topbar__icon-btn"
            title="返回书架"
            onClick={onBack}
          >
            <ArrowLeft size={16} />
          </button>
          {toc.length > 0 && (
            <button
              type="button"
              data-toc-toggle="true"
              className={`topbar__icon-btn ${showToc ? 'is-active' : ''}`}
              title="目录"
              onClick={() => {
                setShowReviewDrawer(false);
                setShowToc((visible) => !visible);
              }}
            >
              <ListTree size={15} />
            </button>
          )}
          <button
            type="button"
            data-review-toggle="true"
            className={`topbar__icon-btn ${showReviewDrawer ? 'is-active' : ''}`}
            title="批注复盘列表（按颜色与附图筛选）"
            onClick={() => {
              setShowToc(false);
              setShowReviewDrawer((visible) => !visible);
            }}
          >
            <Bookmark size={15} />
          </button>
          <button
            type="button"
            className={`topbar__icon-btn ${showGallery ? 'is-active' : ''}`}
            title="图卡复盘画廊与闪卡模式"
            onClick={() => {
              setShowToc(false);
              setShowReviewDrawer(false);
              setShowGallery(true);
            }}
          >
            <Images size={15} />
          </button>
          {docFormat === 'epub' && (
            <button
              type="button"
              className={`topbar__icon-btn ${showTts ? 'is-active' : ''}`}
              title="在线听书 (Edge Neural TTS)"
              onClick={() => setShowTts((v) => !v)}
            >
              <Headphones size={15} />
            </button>
          )}
          <div className="topbar__doc" data-tauri-drag-region>
            <span className="topbar__title" data-tauri-drag-region>
              {bookTitle}
            </span>
            <span className="topbar__meta" data-tauri-drag-region>
              {docFormat.toUpperCase()}
              {docReady ? (
                <>
                  <span className="topbar__dot">·</span>
                  <span title="当前阅读进度">{Math.round(readingProgress * 100)}%</span>
                </>
              ) : (
                <>
                  <span className="topbar__dot">·</span>
                  <Loader2 size={11} className="topbar__spinner" />
                  加载中
                </>
              )}
            </span>
          </div>
          {loadError && <span className="topbar__error">{loadError}</span>}
        </div>

        <div className="topbar__actions">
          {docFormat === 'pdf' && (
            <>
              <div className="topbar__zoom-group">
                <button
                  type="button"
                  className={`topbar__icon-btn ${pdfCropMode ? 'is-active' : ''}`}
                  title="框选 PDF 图表直接生成右侧带图卡片（也可按住 ⌥ 拖拽）"
                  onClick={() => setPdfCropMode((v) => !v)}
                >
                  <Crop size={15} />
                </button>
                <button
                  type="button"
                  className="topbar__icon-btn"
                  title="缩小 PDF"
                  onClick={() => setPdfScale((s) => Math.max(0.6, +(s - 0.15).toFixed(2)))}
                >
                  <ZoomOut size={15} />
                </button>
                <span className="topbar__zoom-label">{Math.round(pdfScale * 100)}%</span>
                <button
                  type="button"
                  className="topbar__icon-btn"
                  title="放大 PDF"
                  onClick={() => setPdfScale((s) => Math.min(2.2, +(s + 0.15).toFixed(2)))}
                >
                  <ZoomIn size={15} />
                </button>
              </div>
              <span className="topbar__divider" />
            </>
          )}

          <button
            type="button"
            className="topbar__icon-btn"
            title="撤销 (⌘Z)"
            disabled={!historyState.canUndo}
            onClick={handleUndo}
          >
            <Undo2 size={15} />
          </button>

          <button
            type="button"
            className="topbar__icon-btn"
            title="重做 (⇧⌘Z)"
            disabled={!historyState.canRedo}
            onClick={handleRedo}
          >
            <Redo2 size={15} />
          </button>

          <span className="topbar__divider" />

          {exportNotice && <span className="topbar__notice">{exportNotice}</span>}

          <button
            type="button"
            className="topbar__icon-btn"
            title="搜索原文与批注 (⌘K)"
            onClick={() => setShowSearch(true)}
          >
            <Search size={15} />
          </button>

          <button
            type="button"
            className="topbar__icon-btn"
            title="导出本书批注与附图文件夹"
            onClick={() => void handleExportMarkdown()}
          >
            <Download size={15} />
          </button>

          <button
            type="button"
            className="topbar__icon-btn"
            title="阅读设置"
            onClick={onOpenSettings}
          >
            <Settings size={15} />
          </button>
        </div>
      </header>

      {showToc && (
        <aside className="toc-panel" aria-label="目录">
          <div className="toc-panel__header">
            <span>目录</span>
            <button
              type="button"
              className="topbar__icon-btn"
              title="关闭目录 (Esc)"
              onClick={() => setShowToc(false)}
            >
              <X size={14} />
            </button>
          </div>
          <div className="toc-panel__list">
            {toc.map((entry, index) => (
              <button
                key={`${entry.target}-${index}`}
                type="button"
                className="toc-panel__item"
                style={{ paddingLeft: `${12 + entry.depth * 14}px` }}
                title={entry.label}
                onClick={() => handleTocJump(entry)}
              >
                {entry.label}
              </button>
            ))}
          </div>
        </aside>
      )}

      {showReviewDrawer && (
        <AnnotationDrawer
          anchors={anchors}
          cards={cards}
          paragraphs={paragraphs}
          onClose={() => setShowReviewDrawer(false)}
          onSelect={(action) => {
            handleSearchSelect(action);
          }}
        />
      )}

      {/* Outer fixed-size container hosts the screen-sized SVG bridge */}
      <div ref={workspaceOuterRef} className="workspace-outer">
        {/* Single Native Unified Scroll Viewport */}
        <div
          ref={unifiedScrollRef}
          className="unified-scroll-viewport"
          onScroll={handleScroll}
        >
          <div className="unified-stage">
            {/* Left Sticky Book Column: stays pinned on left when panning right */}
            <div
              ref={bookStickyRef}
              className="book-sticky-col"
              style={
                {
                  width: `${bookWidth}px`,
                  '--reader-font-size': `${settings.fontSize}px`,
                  '--reader-line-height': `${settings.lineHeight}`,
                  '--reader-font-family':
                    settings.fontFamily === 'serif'
                      ? "'Songti SC', 'Noto Serif CJK SC', SimSun, serif"
                      : settings.fontFamily === 'sans'
                        ? "'PingFang SC', 'Heiti SC', 'Noto Sans CJK SC', sans-serif"
                        : "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Segoe UI', sans-serif",
                } as React.CSSProperties
              }
            >
              {docFormat === 'pdf' && pdfSource ? (
                <PdfBookPane
                  source={pdfSource}
                  scale={pdfScale}
                  containerWidth={bookWidth}
                  anchors={anchors}
                  activeAnchorId={activeAnchorId}
                  selectedCardId={selectedCardId}
                  isDraggingWireToBook={Boolean(draggingWire && draggingWire.mode === 'to-book')}
                  cropMode={pdfCropMode}
                  onExitCropMode={() => setPdfCropMode(false)}
                  scrollContainerRef={unifiedScrollRef}
                  onScroll={handleScroll}
                  onPageRendered={bumpSync}
                  onCreatePdfAnnotation={handleCreatePdfAnnotation}
                  onCreatePdfCropCard={handleCreatePdfCropCard}
                  onClickAnchor={handleClickBookAnchor}
                  onPreviewImage={handlePreviewBlob}
                  onOutline={setToc}
                />
              ) : (
                <BookPane
                  paragraphs={paragraphs}
                  anchors={anchors}
                  activeAnchorId={activeAnchorId}
                  selectedCardId={selectedCardId}
                  isDraggingWireToBook={Boolean(draggingWire && draggingWire.mode === 'to-book')}
                  scrollContainerRef={unifiedScrollRef}
                  epubImageLoader={epubImageLoader}
                  onImageLoaded={handleEpubImageLoaded}
                  onCreateImageCard={handleCreateImageCard}
                  onScroll={handleScroll}
                  onCreateAnnotation={handleCreateTextAnnotation}
                  onClickAnchor={handleClickBookAnchor}
                  onPreviewImage={handlePreviewBlob}
                />
              )}

              {/* Resizer Handle attached to right edge of sticky book column */}
              <div
                className={`pane-resizer ${isResizing ? 'is-dragging' : ''}`}
                onMouseDown={(e) => {
                  e.stopPropagation();
                  setIsResizing(true);
                }}
                title="拖拽调整书籍宽度"
              />
            </div>

            {/* Right Infinitely-Expandable Margin Canvas sharing exact native Y-axis */}
            <div
              ref={canvasRef}
              className={`infinite-margin-canvas ${isPanningCanvas ? 'is-panning' : ''}`}
              style={{
                minWidth: `${canvasMinWidth}px`,
                minHeight: `${canvasMinHeight}px`,
              }}
              onMouseDown={handleCanvasBackgroundMouseDown}
            >
              {/* Card-to-Card SVG Edges */}
              <svg className="card-edges-svg">
                {cardEdgePaths.map((edge) => {
                  const isDimmed =
                    focusedCardIds !== null &&
                    !focusedCardIds.has(edge.source) &&
                    !focusedCardIds.has(edge.target);
                  return (
                    <g key={edge.id} className="card-edge-group">
                      <path
                        d={edge.d}
                        fill="none"
                        stroke={edge.color}
                        strokeWidth={isDimmed ? 1.4 : 1.8}
                        strokeOpacity={isDimmed ? 0.16 : 0.86}
                      />
                      <path
                        d={edge.d}
                        fill="none"
                        stroke="transparent"
                        strokeWidth={12}
                        style={{ cursor: 'pointer', pointerEvents: 'stroke' }}
                        onClick={(e) => {
                          e.stopPropagation();
                          setEdges((prev) => prev.filter((ed) => ed.id !== edge.id));
                        }}
                      >
                        <title>点击删除该连线</title>
                      </path>
                    </g>
                  );
                })}
              </svg>

              {/* Draggable, Auto-Expanding Minimalist Cards */}
              {visibleCards.map((card) => {
                const linkedAnchor = card.anchorId
                  ? anchors.find((a) => a.id === card.anchorId)
                  : undefined;
                return (
                  <AnnotationCard
                    key={card.id}
                    card={card}
                    cardScale={cardScale}
                    anchorColor={linkedAnchor?.color}
                    anchorStyle={linkedAnchor?.style}
                    hiddenCount={hiddenCountByCard.get(card.id) ?? 0}
                    isSelected={
                      selectedCardId === card.id ||
                      (activeAnchorId !== null && card.anchorId === activeAnchorId)
                    }
                    autoFocus={autoFocusCardId === card.id}
                    onAutoFocused={() => setAutoFocusCardId(null)}
                    onSelect={(id) => {
                      setSelectedCardId(id);
                      const found = cards.find((c) => c.id === id);
                      if (found?.anchorId) setActiveAnchorId(found.anchorId);
                    }}
                    onMoveCard={handleMoveCard}
                    onResizeCard={handleResizeCard}
                    onChangeBody={handleChangeBody}
                    onAddImages={handleAddImages}
                    onRemoveImage={handleRemoveImage}
                    onPreviewImage={handlePreviewImage}
                    onAnnotateImage={handleStartAnnotateImage}
                    onUpdateStatus={handleUpdateStatus}
                    onUpdateAnchor={handleUpdateAnchor}
                    onAddChild={handleAddChildCard}
                    onDelete={handleDeleteCard}
                    onFocusAnchor={handleFocusAnchor}
                    onStartDragToBook={handleStartDragToBook}
                    onStartDragToCard={handleStartDragToCard}
                    onToggleCollapse={handleToggleCollapse}
                    onLayoutChange={recomputeCardEdges}
                  />
                );
              })}
            </div>
          </div>
        </div>

        {/* Viewport-sized Cross-Column SVG Bridge */}
        <BookToCanvasBridge
          anchors={anchors}
          activeAnchorId={activeAnchorId}
          draggingWire={draggingWire}
          midLineMode={midLineMode}
          workspaceOuterRef={workspaceOuterRef}
          bookStickyRef={bookStickyRef}
          bridgeTriggerRef={bridgeTriggerRef}
        />

        {/* Book Right-Edge 4-Color Anchor Minimap */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: `${Math.max(0, bookWidth - 13)}px`,
            width: '12px',
            pointerEvents: 'none',
            zIndex: 22,
          }}
        >
          <AnchorMinimap
            docFormat={docFormat}
            anchors={anchors}
            paragraphs={paragraphs}
            activeAnchorId={activeAnchorId}
            onJumpAnchor={(anchor) => {
              handleFocusAnchor(anchor.id);
              if (anchor.targetNodeId) {
                setSelectedCardId(anchor.targetNodeId);
              }
            }}
          />
        </div>

        {/* Frosted-Glass Bottom-Right Canvas Floating Dock */}
        <div className="canvas-floating-dock" aria-label="画布控制栏">
          <div className="topbar__zoom-group" title="右侧卡片原地缩放（也可在画布按 ⌘+滚轮）">
            <button
              type="button"
              className="topbar__icon-btn"
              title="缩小卡片"
              disabled={cardScale <= 0.5}
              onClick={() =>
                onSettingsChange({
                  cardScale: Math.max(0.5, +(cardScale - 0.1).toFixed(2)),
                })
              }
            >
              <ZoomOut size={14} />
            </button>
            <button
              type="button"
              className="topbar__zoom-label topbar__zoom-reset"
              title="点击恢复卡片 100% 大小"
              onClick={() => onSettingsChange({ cardScale: 1 })}
            >
              {Math.round(cardScale * 100)}%
            </button>
            <button
              type="button"
              className="topbar__icon-btn"
              title="放大卡片"
              disabled={cardScale >= 1.2}
              onClick={() =>
                onSettingsChange({
                  cardScale: Math.min(1.2, +(cardScale + 0.1).toFixed(2)),
                })
              }
            >
              <ZoomIn size={14} />
            </button>
          </div>

          <span className="canvas-floating-dock__sep" />

          <button
            type="button"
            className="topbar__icon-btn"
            title="自动排列：按批注层级把卡片上下对称铺开"
            onClick={() => {
              pushUndoSnapshot();
              handleAutoLayoutCards();
            }}
          >
            <LayoutGrid size={15} />
          </button>

          {cards.length > 0 && (
            <button
              type="button"
              className="topbar__icon-btn"
              title={allCardsCollapsed ? '展开全部卡片' : '收起全部卡片'}
              onClick={handleToggleCollapseAll}
            >
              {allCardsCollapsed ? (
                <ChevronsUpDown size={15} />
              ) : (
                <ChevronsDownUp size={15} />
              )}
            </button>
          )}

          <button
            type="button"
            className="topbar__icon-btn"
            title={
              midLineMode === 'interline'
                ? '引线走线：行间避字（点击切换为页边对齐）'
                : '引线走线：页边对齐（点击切换为行间避字）'
            }
            onClick={() =>
              setMidLineMode((m) => (m === 'interline' ? 'margin-align' : 'interline'))
            }
          >
            <GitCommitHorizontal size={15} />
          </button>

          <span className="canvas-floating-dock__sep" />

          <button
            type="button"
            className="topbar__icon-btn"
            title="新建自由卡片"
            onClick={handleCreateFreeCard}
          >
            <PlusCircle size={15} />
          </button>

          <button
            type="button"
            className="topbar__icon-btn"
            title="回到书页边缘"
            onClick={() => {
              unifiedScrollRef.current?.scrollTo({ left: 0, behavior: 'smooth' });
            }}
          >
            <RotateCcw size={15} />
          </button>
        </div>
      </div>

      {/* 基础标注（仅高亮/划线）的快捷管理条：换色 / 切换样式 / 升级为批注卡 / 复制 / 删除 */}
      {anchorActions &&
        (() => {
          const anchor = anchors.find((a) => a.id === anchorActions.anchorId);
          if (!anchor) return null;
          const halfWidth = 152;
          const left = Math.min(
            Math.max(anchorActions.x, halfWidth + 8),
            window.innerWidth - halfWidth - 8
          );
          const curColor: AnchorColor =
            anchor.color ?? (anchor.style === 'underline' ? 'green' : 'amber');
          const nextStyle: AnnotationStyle =
            anchor.style === 'highlight' ? 'underline' : 'highlight';
          return (
            <div
              className="anchor-actions-popover"
              style={{
                left: `${left}px`,
                top: `${Math.max(56, anchorActions.y - 10)}px`,
              }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div className="selection-popover__swatches">
                {ANCHOR_COLORS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`selection-popover__swatch ${
                      curColor === item.id ? 'is-active' : ''
                    }`}
                    style={{ background: item.swatch }}
                    title={`改为${item.label}`}
                    onClick={() => handleUpdateAnchor(anchor.id, { color: item.id })}
                  />
                ))}
              </div>
              <div className="selection-popover__sep" />
              <button
                type="button"
                className="selection-popover__icon-btn"
                title={nextStyle === 'underline' ? '改为下划线' : '改为高亮'}
                onClick={() => handleUpdateAnchor(anchor.id, { style: nextStyle })}
              >
                {nextStyle === 'underline' ? (
                  <Underline size={13} />
                ) : (
                  <Highlighter size={13} />
                )}
              </button>
              <button
                type="button"
                className="selection-popover__btn selection-popover__btn--primary"
                title="为该标注生成空白批注卡并连线"
                onClick={() => handlePromoteAnchorToCard(anchor)}
              >
                <MessageSquarePlus size={12} />
                <span>建卡</span>
              </button>
              <button
                type="button"
                className="selection-popover__icon-btn"
                title="复制标注原文"
                onClick={() => {
                  void navigator.clipboard?.writeText(anchor.quote).catch(() => {});
                  setAnchorActions(null);
                }}
              >
                <Copy size={12} />
              </button>
              <div className="selection-popover__sep" />
              <button
                type="button"
                className="anchor-actions-popover__btn"
                title="删除标注（不删除书籍原文）"
                onClick={() => handleDeleteAnchor(anchor.id)}
              >
                <Trash2 size={12} />
              </button>
            </div>
          );
        })()}

      <SearchModal
        open={showSearch}
        currentBookId={book.id}
        currentBookTitle={bookTitle || book.title}
        paragraphs={paragraphs}
        anchors={anchors}
        cards={cards}
        onClose={() => setShowSearch(false)}
        onSelect={handleSearchSelect}
      />

      <GalleryModal
        open={showGallery}
        bookTitle={bookTitle || book.title}
        anchors={anchors}
        cards={cards}
        paragraphs={paragraphs}
        onClose={() => setShowGallery(false)}
        onJump={handleSearchSelect}
      />

      <TtsPlayerBar
        open={showTts}
        bookId={book.id}
        bookTitle={bookTitle || book.title}
        initialLocator={book.ttsLocator}
        paragraphs={paragraphs}
        getCurrentVisibleParagraphId={() => {
          const el = unifiedScrollRef.current;
          const bookEl = bookStickyRef.current;
          if (!el || !bookEl) return null;
          const top = el.getBoundingClientRect().top;
          const nodes = bookEl.querySelectorAll<HTMLElement>('[data-paragraph-id]');
          for (let i = 0; i < nodes.length; i += 1) {
            if (nodes[i].getBoundingClientRect().bottom > top + 12) {
              return nodes[i].dataset.paragraphId ?? null;
            }
          }
          return null;
        }}
        onClose={() => {
          setShowTts(false);
          setTtsParagraphId(null);
        }}
        onActiveParagraphChange={(pid) => {
          setTtsParagraphId(pid);
          if (pid) {
            const target = bookStickyRef.current?.querySelector<HTMLElement>(
              `[data-paragraph-id="${pid}"]`
            );
            const scroller = unifiedScrollRef.current;
            if (target && scroller) {
              const offset =
                target.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
              scroller.scrollTo({
                top: Math.max(0, scroller.scrollTop + offset - 80),
                left: scroller.scrollLeft,
                behavior: 'smooth',
              });
              bumpSync();
            }
          }
        }}
      />

      {/* Built-in Image Annotator Modal (arrows, rectangles, text) */}
      {annotatingImage && (
        <ImageAnnotatorModal
          imageUrl={annotatingImage.url}
          onCancel={handleCloseAnnotator}
          onSave={handleSaveAnnotatedImage}
        />
      )}

      {/* Floating Image Preview (transparent backdrop, direct annotate entry) */}
      {previewImage && (
        <div className="image-lightbox-backdrop" onClick={closePreviewImage}>
          <div
            className="image-lightbox-frame"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="image-lightbox-actions">
              {previewImage.cardId && previewImage.image && (
                <button
                  type="button"
                  className="image-lightbox-action-btn image-lightbox-action-btn--primary"
                  title="直接标注此图"
                  onClick={() => {
                    const { cardId, image } = previewImage;
                    closePreviewImage();
                    if (cardId && image) {
                      void handleStartAnnotateImage(cardId, image);
                    }
                  }}
                >
                  <Pencil size={13} />
                  <span>标注</span>
                </button>
              )}
              <button
                type="button"
                className="image-lightbox-action-btn"
                title="关闭预览 (Esc)"
                onClick={closePreviewImage}
              >
                <X size={15} />
              </button>
            </div>
            {previewImage.zoomable ? (
              <div className="image-lightbox-stage">
                <img
                  src={previewImage.url}
                  alt={previewImage.alt || '放大预览'}
                  className="image-lightbox-img image-lightbox-img--zoomable"
                />
              </div>
            ) : (
              <img
                src={previewImage.url}
                alt={previewImage.alt || '放大预览'}
                className="image-lightbox-img"
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

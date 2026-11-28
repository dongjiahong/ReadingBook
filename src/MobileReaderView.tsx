import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Bookmark,
  Crop,
  Headphones,
  Images,
  ListTree,
  Loader2,
  MessageSquarePlus,
  Pencil,
  Search,
  Settings,
  X,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { AnchorMinimap } from './components/AnchorMinimap';
import { AnnotationDrawer } from './components/AnnotationDrawer';
import { BookPane } from './components/BookPane';
import { GalleryModal } from './components/GalleryModal';
import { ImageAnnotatorModal } from './components/ImageAnnotatorModal';
import { MobileNoteSheet } from './components/MobileNoteSheet';
import type { LinkableCardOption } from './components/MobileSelectionDock';
import { PdfBookPane, type PdfSource } from './components/PdfBookPane';
import { SearchModal, type SearchResultAction } from './components/SearchModal';
import { SyncStatusBadge } from './components/SyncStatusBadge';
import { TtsPlayerBar } from './components/TtsPlayerBar';
import { loadAnnotations, saveAnnotations } from './services/db';
import {
  subscribeRemoteSyncUpdates,
  type SyncRuntimeSnapshot,
} from './services/sync';
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
  NormalizedPdfRect,
  ReaderSettings,
  TocEntry,
} from './types';
import {
  loadEpubImageDims,
  saveEpubImageDims,
  type ImageDimsMap,
} from './utils/epubDimsCache';
import { EpubImageLoader, parseEpubFile } from './utils/epubLoader';
import { useBackHandler } from './utils/backStack';
import {
  createFullImageUrl,
  deleteStoredImage,
  importImageFiles,
  restoreThumbUrls,
  revokeImageUrl,
  revokeObjectUrlIfBlob,
} from './utils/imageStore';

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
      pdfPage:
        typeof parsed.pdfPage === 'number' && Number.isFinite(parsed.pdfPage)
          ? parsed.pdfPage
          : undefined,
      offsetY:
        typeof parsed.offsetY === 'number' && Number.isFinite(parsed.offsetY)
          ? parsed.offsetY
          : undefined,
    };
  } catch {
    return null;
  }
}

interface MobileReaderViewProps {
  book: BookRecord;
  settings: ReaderSettings;
  syncRuntime?: SyncRuntimeSnapshot;
  onBack: () => void;
  onSwitchBook?: (bookId: string) => void;
  onOpenSettings: () => void;
  onOpenSync?: () => void;
  onProgress: (bookId: string, progress: number, locator: string) => void;
}

export default function MobileReaderView({
  book,
  settings,
  syncRuntime,
  onBack,
  onSwitchBook,
  onOpenSettings,
  onOpenSync,
  onProgress,
}: MobileReaderViewProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentHostRef = useRef<HTMLDivElement | null>(null);
  const progressTimerRef = useRef<number | null>(null);
  const lastProgressRef = useRef<{ progress: number; locator: string } | null>(null);
  const hydratedRef = useRef(false);
  const restoreScrollRef = useRef<SavedLocator | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const dirtyRef = useRef(false);
  const suppressNextSaveRef = useRef(false);
  const epubDimsRef = useRef<ImageDimsMap>({});
  const epubDimsDirtyRef = useRef(false);
  const epubDimsTimerRef = useRef<number | null>(null);
  const latestRef = useRef<{
    bookId: string;
    anchors: BookAnchor[];
    cards: AnnotationCardItem[];
    edges: CardEdge[];
  }>({ bookId: book.id, anchors: [], cards: [], edges: [] });

  const [docReady, setDocReady] = useState(false);
  const [docFormat, setDocFormat] = useState<DocFormat>('epub');
  const [bookTitle, setBookTitle] = useState(book.title);
  const [paragraphs, setParagraphs] = useState<BookParagraph[]>([]);
  const [pdfSource, setPdfSource] = useState<PdfSource | null>(null);
  const [epubImageLoader, setEpubImageLoader] = useState<EpubImageLoader | null>(null);
  const [toc, setToc] = useState<TocEntry[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [readingProgress, setReadingProgress] = useState(book.progress ?? 0);
  const readingProgressRef = useRef(readingProgress);
  readingProgressRef.current = readingProgress;
  const [remoteProgressPrompt, setRemoteProgressPrompt] = useState<{
    progress: number;
    locator: string | null;
  } | null>(null);
  const [viewportWidth, setViewportWidth] = useState<number>(() =>
    typeof window !== 'undefined' ? window.innerWidth : 390
  );

  const [anchors, setAnchors] = useState<BookAnchor[]>([]);
  const [cards, setCards] = useState<AnnotationCardItem[]>([]);
  const [edges, setEdges] = useState<CardEdge[]>([]);
  const cardsRef = useRef(cards);
  cardsRef.current = cards;

  const [activeAnchorId, setActiveAnchorId] = useState<string | null>(null);
  const [sheetAnchorId, setSheetAnchorId] = useState<string | null>(null);
  const [autoFocusCardId, setAutoFocusCardId] = useState<string | null>(null);

  const [showToc, setShowToc] = useState(false);
  const [showReviewDrawer, setShowReviewDrawer] = useState(false);
  const [showGallery, setShowGallery] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [showTts, setShowTts] = useState(false);
  const [cropMode, setCropMode] = useState(false);
  const [ttsParagraphId, setTtsParagraphId] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => {
      toastTimerRef.current = null;
      setToastMessage(null);
    }, 1800);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const host = contentHostRef.current;
    if (!host) return;
    host.querySelectorAll('[data-tts-active="true"]').forEach((el) => {
      el.removeAttribute('data-tts-active');
    });
    if (ttsParagraphId) {
      const activeEl = host.querySelector<HTMLElement>(
        `[data-paragraph-id="${ttsParagraphId}"]`
      );
      if (activeEl) activeEl.setAttribute('data-tts-active', 'true');
    }
  }, [ttsParagraphId]);

  const [previewImage, setPreviewImage] = useState<{
    url: string;
    alt: string;
    cardId?: string;
    imageId?: string;
    epubParagraphId?: string;
    epubBlob?: Blob;
  } | null>(null);

  const [annotatingImage, setAnnotatingImage] = useState<{
    cardId: string;
    imageId: string;
    url: string;
  } | null>(null);

  const closePreview = useCallback(() => {
    setPreviewImage((prev) => {
      if (prev) revokeObjectUrlIfBlob(prev.url);
      return null;
    });
  }, []);

  const closeAnnotator = useCallback(() => {
    setAnnotatingImage((prev) => {
      if (prev) revokeObjectUrlIfBlob(prev.url);
      return null;
    });
  }, []);

  // Layered Android back-gesture navigation: close top-most overlay first, then exit to shelf.
  useBackHandler(true, onBack);
  useBackHandler(cropMode, () => setCropMode(false));
  useBackHandler(showTts, () => {
    setShowTts(false);
    setTtsParagraphId(null);
  });
  useBackHandler(showToc, () => setShowToc(false));
  useBackHandler(showReviewDrawer, () => setShowReviewDrawer(false));
  useBackHandler(showSearch, () => setShowSearch(false));
  useBackHandler(sheetAnchorId !== null, () => setSheetAnchorId(null));
  useBackHandler(previewImage !== null, closePreview);
  useBackHandler(annotatingImage !== null, closeAnnotator);

  const revokeCardUrls = useCallback((list: AnnotationCardItem[]) => {
    for (const card of list) {
      for (const img of card.images ?? []) revokeImageUrl(img.id);
    }
  }, []);

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    return () => {
      epubImageLoader?.dispose();
    };
  }, [epubImageLoader]);

  useEffect(() => {
    return () => {
      revokeCardUrls(cardsRef.current);
      closePreview();
    };
  }, [revokeCardUrls, closePreview]);

  // Load book + annotations
  useEffect(() => {
    let cancelled = false;
    const open = async () => {
      hydratedRef.current = false;
      lastProgressRef.current = null;
      restoreScrollRef.current = parseLocator(book.locator);
      setDocReady(false);
      setShowToc(false);
      setSheetAnchorId(null);

      try {
        if (book.format === 'pdf') {
          const size = await invoke<number>('book_file_size', { path: book.filePath });
          if (cancelled) return;
          setDocFormat('pdf');
          setBookTitle(book.title);
          setPdfSource({ kind: 'disk', path: book.filePath, size });
          setToc([]);
        } else {
          const source = { diskPath: book.filePath };
          const [parsed, cachedDims] = await Promise.all([
            parseEpubFile(source),
            loadEpubImageDims(book.id),
          ]);
          if (cancelled) return;
          epubDimsRef.current = cachedDims;
          epubDimsDirtyRef.current = false;
          const sized = parsed.paragraphs.map((p) => {
            if (p.type !== 'image' || !p.imagePath) return p;
            if (p.imageWidth && p.imageHeight) return p;
            const dims = cachedDims[p.imagePath];
            return dims ? { ...p, imageWidth: dims[0], imageHeight: dims[1] } : p;
          });
          setDocFormat('epub');
          setBookTitle(parsed.title);
          setParagraphs(sized);
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
        setLoadError(null);
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : '打开书籍失败');
        }
      } finally {
        if (!cancelled) {
          hydratedRef.current = true;
          setDocReady(true);
        }
      }
    };
    void open();
    return () => {
      cancelled = true;
    };
  }, [book]);

  // Restore scroll position
  useEffect(() => {
    if (!docReady) return;
    const target = restoreScrollRef.current;
    restoreScrollRef.current = null;
    const scroller = scrollRef.current;
    const host = contentHostRef.current;
    if (!scroller || !target) return;

    const apply = () => {
      if (host && target.paragraphId) {
        const node = host.querySelector<HTMLElement>(
          `[data-paragraph-id="${target.paragraphId}"]`
        );
        if (node) {
          const offset =
            node.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
          scroller.scrollTop = Math.max(
            0,
            scroller.scrollTop + offset - (target.offsetY ?? 0)
          );
          return;
        }
      } else if (host && target.pdfPage) {
        const pageNode = host.querySelector<HTMLElement>(
          `[data-pdf-page="${target.pdfPage}"]`
        );
        if (pageNode) {
          const offset =
            pageNode.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
          scroller.scrollTop = Math.max(
            0,
            scroller.scrollTop + offset - (target.offsetY ?? 0)
          );
          return;
        }
      }
      scroller.scrollTop = target.top;
    };
    const raf = requestAnimationFrame(apply);
    const settle = window.setTimeout(apply, 180);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(settle);
    };
  }, [docReady]);

  // Persist annotations (debounced + flush on exit)
  const flushAnnotationsNow = useCallback(() => {
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    const snap = latestRef.current;
    void saveAnnotations(snap.bookId, {
      anchors: snap.anchors,
      cards: snap.cards,
      edges: snap.edges,
    }).catch((err) => console.warn('保存批注失败', err));
  }, []);

  useEffect(() => {
    latestRef.current = { bookId: book.id, anchors, cards, edges };
    if (!hydratedRef.current) return;
    if (suppressNextSaveRef.current) {
      suppressNextSaveRef.current = false;
      return;
    }
    dirtyRef.current = true;
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(flushAnnotationsNow, 500);
    return () => {
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [book.id, anchors, cards, edges, flushAnnotationsNow]);

  // Live-refresh annotations and prompt on remote reading progress updates
  useEffect(() => {
    return subscribeRemoteSyncUpdates((updates) => {
      const match = updates.find((u) => u.bookId === book.id);
      if (!match) return;
      if (match.annotationsChanged) {
        void loadAnnotations(book.id).then(async (saved) => {
          const restoredCards = saved ? await restoreThumbUrls(saved.cards) : [];
          suppressNextSaveRef.current = true;
          setAnchors(saved?.anchors ?? []);
          setCards(restoredCards);
          setEdges(saved?.edges ?? []);
        });
      }
      if (
        match.progressChanged &&
        match.locator &&
        typeof match.progress === 'number' &&
        Math.abs(match.progress - readingProgressRef.current) >= 0.01
      ) {
        setRemoteProgressPrompt({
          progress: match.progress,
          locator: match.locator,
        });
      }
    });
  }, [book.id]);

  useEffect(() => {
    const onBeforeUnload = () => flushAnnotationsNow();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      flushAnnotationsNow();
    };
  }, [flushAnnotationsNow]);

  const paragraphIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    paragraphs.forEach((p, i) => map.set(p.id, i));
    return map;
  }, [paragraphs]);

  const computeReadingSnapshot = useCallback((): {
    progress: number;
    locator: string;
  } | null => {
    const scroller = scrollRef.current;
    if (!scroller) return null;
    const scrollerRect = scroller.getBoundingClientRect();
    const max = scroller.scrollHeight - scroller.clientHeight;
    let ratio = max > 0 ? Math.min(1, Math.max(0, scroller.scrollTop / max)) : 0;
    const saved: SavedLocator = { top: Math.round(scroller.scrollTop), left: 0 };

    const host = contentHostRef.current;
    if (host && docFormat === 'epub') {
      const nodes = host.querySelectorAll<HTMLElement>('[data-paragraph-id]');
      for (let i = 0; i < nodes.length; i += 1) {
        const rect = nodes[i].getBoundingClientRect();
        if (rect.bottom > scrollerRect.top + 8) {
          const pid = nodes[i].dataset.paragraphId;
          if (pid) {
            saved.paragraphId = pid;
            saved.offsetY = Math.round(rect.top - scrollerRect.top);
            const idx = paragraphIndexMap.get(pid);
            if (idx !== undefined && paragraphs.length > 1) {
              ratio =
                max > 0 && scroller.scrollTop >= max - 4
                  ? 1
                  : Math.min(1, Math.max(0, idx / (paragraphs.length - 1)));
            }
          }
          break;
        }
      }
    } else if (host && docFormat === 'pdf') {
      const pages = host.querySelectorAll<HTMLElement>('[data-pdf-page]');
      for (let i = 0; i < pages.length; i += 1) {
        const rect = pages[i].getBoundingClientRect();
        if (rect.bottom > scrollerRect.top + 8) {
          const pageNum = Number(pages[i].dataset.pdfPage);
          if (Number.isFinite(pageNum) && pageNum > 0) {
            saved.pdfPage = pageNum;
            saved.offsetY = Math.round(rect.top - scrollerRect.top);
            if (pages.length > 1) {
              ratio =
                max > 0 && scroller.scrollTop >= max - 4
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
    if (progressTimerRef.current) window.clearTimeout(progressTimerRef.current);
    progressTimerRef.current = window.setTimeout(() => {
      const snap = computeReadingSnapshot();
      if (!snap) return;
      setReadingProgress(snap.progress);
      lastProgressRef.current = snap;
      onProgress(book.id, snap.progress, snap.locator);
    }, 350);
  }, [book.id, computeReadingSnapshot, onProgress]);

  useEffect(() => {
    return () => {
      if (progressTimerRef.current) window.clearTimeout(progressTimerRef.current);
      if (epubDimsTimerRef.current) window.clearTimeout(epubDimsTimerRef.current);
      if (epubDimsDirtyRef.current) {
        epubDimsDirtyRef.current = false;
        void saveEpubImageDims(book.id, epubDimsRef.current);
      }
      if (lastProgressRef.current) {
        onProgress(book.id, lastProgressRef.current.progress, lastProgressRef.current.locator);
      }
    };
  }, [book.id, onProgress]);

  const handleEpubImageLoaded = useCallback(
    (imagePath?: string, width?: number, height?: number) => {
      if (!imagePath || !width || !height) return;
      const prev = epubDimsRef.current[imagePath];
      if (prev && prev[0] === width && prev[1] === height) return;
      epubDimsRef.current[imagePath] = [width, height];
      epubDimsDirtyRef.current = true;
      if (epubDimsTimerRef.current) window.clearTimeout(epubDimsTimerRef.current);
      epubDimsTimerRef.current = window.setTimeout(() => {
        epubDimsTimerRef.current = null;
        if (!epubDimsDirtyRef.current) return;
        epubDimsDirtyRef.current = false;
        void saveEpubImageDims(book.id, epubDimsRef.current);
      }, 800);
    },
    [book.id]
  );

  // Create annotation (highlight/underline, optionally with a mobile-created card or linked to existing card)
  const createAnchorAndOptionalCard = useCallback(
    (
      anchorMeta: Omit<BookAnchor, 'id' | 'badgeNumber' | 'kind' | 'targetNodeId'>,
      withCard: boolean,
      linkToExistingNodeId?: string
    ) => {
      const kind = anchorMeta.style === 'highlight' ? 'review' : 'revision';
      const anchorId = `anchor-${Date.now()}`;

      if (linkToExistingNodeId) {
        const targetCard = cardsRef.current.find((c) => c.id === linkToExistingNodeId);
        const newAnchor: BookAnchor = {
          ...anchorMeta,
          id: anchorId,
          badgeNumber: targetCard?.badgeNumber ?? 0,
          kind: targetCard?.kind ?? kind,
          targetNodeId: linkToExistingNodeId,
        };
        setAnchors((prev) => [...prev, newAnchor]);
        setActiveAnchorId(anchorId);
        showToast('已关联到已有卡片');
        return;
      }

      if (!withCard) {
        const newAnchor: BookAnchor = {
          ...anchorMeta,
          id: anchorId,
          badgeNumber: 0,
          kind,
        };
        setAnchors((prev) => [...prev, newAnchor]);
        setActiveAnchorId(anchorId);
        showToast(anchorMeta.style === 'underline' ? '已添加划线' : '已添加高亮');
        return;
      }

      const cardId = `card-${Date.now()}`;
      const badgeNumber = anchors.filter((a) => a.kind === kind && a.targetNodeId).length + 1;
      const newAnchor: BookAnchor = {
        ...anchorMeta,
        id: anchorId,
        badgeNumber,
        kind,
        targetNodeId: cardId,
      };
      const newCard: AnnotationCardItem = {
        id: cardId,
        x: 44,
        y: 0,
        kind,
        badgeNumber,
        body: '',
        status: kind === 'revision' ? 'pending' : undefined,
        anchorId,
        needsLayout: true,
      };
      setAnchors((prev) => [...prev, newAnchor]);
      setCards((prev) => [...prev, newCard]);
      setActiveAnchorId(anchorId);
      setSheetAnchorId(anchorId);
      setAutoFocusCardId(cardId);
    },
    [anchors, showToast]
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
      withCard?: boolean;
      linkToExistingNodeId?: string;
    }) => {
      const para = paragraphs.find((p) => p.id === draft.paragraphId);
      const epubCfi = para?.epubCfiBase
        ? `${para.epubCfiBase}/1:${draft.startOffset}`
        : undefined;
      createAnchorAndOptionalCard(
        {
          docFormat: 'epub',
          paragraphId: draft.paragraphId,
          epubCfi,
          quote: draft.quote,
          startOffset: draft.startOffset,
          endOffset: draft.endOffset,
          style: draft.style,
          color: draft.color,
        },
        draft.withCard !== false,
        draft.linkToExistingNodeId
      );
    },
    [paragraphs, createAnchorAndOptionalCard]
  );

  const handleCreatePdfAnnotation = useCallback(
    (draft: {
      pageNumber: number;
      quote: string;
      rects: NormalizedPdfRect[];
      style: AnnotationStyle;
      color?: AnchorColor;
      anchorScreenY: number;
      withCard?: boolean;
      linkToExistingNodeId?: string;
    }) => {
      createAnchorAndOptionalCard(
        {
          docFormat: 'pdf',
          paragraphId: `pdf-page-${draft.pageNumber}`,
          pdfPage: draft.pageNumber,
          pdfRects: draft.rects,
          quote: draft.quote,
          startOffset: 0,
          endOffset: draft.quote.length,
          style: draft.style,
          color: draft.color,
        },
        draft.withCard !== false,
        draft.linkToExistingNodeId
      );
    },
    [createAnchorAndOptionalCard]
  );

  const handleCreatePdfCropCard = useCallback(
    async (draft: {
      pageNumber: number;
      rect: NormalizedPdfRect;
      blob: Blob;
      anchorScreenY: number;
    }) => {
      const file = new File([draft.blob], `pdf-crop-p${draft.pageNumber}-${Date.now()}.png`, {
        type: 'image/png',
      });
      const imported = await importImageFiles([file]);
      if (imported.length === 0) return;

      const anchorId = `anchor-${Date.now()}`;
      const cardId = `card-${Date.now()}`;
      const badgeNumber = anchors.filter((a) => a.kind === 'thought').length + 1;
      const newAnchor: BookAnchor = {
        id: anchorId,
        docFormat: 'pdf',
        paragraphId: `pdf-page-${draft.pageNumber}`,
        pdfPage: draft.pageNumber,
        pdfRects: [draft.rect],
        quote: `PDF 第 ${draft.pageNumber} 页图表`,
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
        x: 44,
        y: 0,
        kind: 'thought',
        badgeNumber,
        body: '',
        images: imported,
        anchorId,
        needsLayout: true,
      };
      setAnchors((prev) => [...prev, newAnchor]);
      setCards((prev) => [...prev, newCard]);
      setActiveAnchorId(anchorId);
      setSheetAnchorId(anchorId);
      setAutoFocusCardId(cardId);
      showToast('已裁图建卡');
    },
    [anchors, showToast]
  );

  const handleCreateImageCard = useCallback(
    async (paragraphId: string, blob: Blob, alt: string) => {
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

      const anchorId = `anchor-${Date.now()}`;
      const cardId = `card-${Date.now()}`;
      const badgeNumber = anchors.filter((a) => a.kind === 'thought').length + 1;
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
        x: 44,
        y: 0,
        kind: 'thought',
        badgeNumber,
        body: '',
        images: imported,
        anchorId,
        needsLayout: true,
      };
      setAnchors((prev) => [...prev, newAnchor]);
      setCards((prev) => [...prev, newCard]);
      setActiveAnchorId(anchorId);
      setSheetAnchorId(anchorId);
      setAutoFocusCardId(cardId);
      showToast('已生成插图卡片');
    },
    [anchors, showToast]
  );

  const handlePromoteAnchor = useCallback(
    (anchor: BookAnchor) => {
      const kind = anchor.style === 'highlight' ? 'review' : 'revision';
      const cardId = `card-${Date.now()}`;
      const badgeNumber = anchors.filter((a) => a.kind === kind && a.targetNodeId).length + 1;
      const newCard: AnnotationCardItem = {
        id: cardId,
        x: 44,
        y: 0,
        kind,
        badgeNumber,
        body: '',
        status: kind === 'revision' ? 'pending' : undefined,
        anchorId: anchor.id,
        needsLayout: true,
      };
      setAnchors((prev) =>
        prev.map((a) =>
          a.id === anchor.id ? { ...a, targetNodeId: cardId, badgeNumber, kind } : a
        )
      );
      setCards((prev) => [...prev, newCard]);
      setAutoFocusCardId(cardId);
    },
    [anchors]
  );

  const handleUpdateAnchor = useCallback(
    (anchorId: string, patch: Partial<Pick<BookAnchor, 'color' | 'style'>>) => {
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
    []
  );

  const handleDeleteAnchor = useCallback((anchorId: string) => {
    setAnchors((prev) => prev.filter((a) => a.id !== anchorId));
    setActiveAnchorId((cur) => (cur === anchorId ? null : cur));
    setSheetAnchorId((cur) => (cur === anchorId ? null : cur));
  }, []);

  const handleChangeBody = useCallback((cardId: string, body: string) => {
    setCards((prev) => prev.map((c) => (c.id === cardId ? { ...c, body } : c)));
  }, []);

  const handleAddChildCard = useCallback((parentCardId: string) => {
    const childId = `card-${Date.now()}`;
    setCards((prev) => [
      ...prev,
      {
        id: childId,
        x: 336,
        y: 0,
        kind: 'thought',
        body: '',
        needsLayout: true,
      },
    ]);
    setEdges((prev) => [
      ...prev,
      {
        id: `edge-${parentCardId}-${childId}`,
        source: parentCardId,
        target: childId,
        color: '#3b82f6',
      },
    ]);
    setAutoFocusCardId(childId);
  }, []);

  const handleAddCardImages = useCallback(
    async (cardId: string, files: FileList | File[]) => {
      const imported = await importImageFiles(files);
      if (imported.length === 0) return;
      setCards((prev) =>
        prev.map((c) =>
          c.id === cardId ? { ...c, images: [...(c.images ?? []), ...imported] } : c
        )
      );
      showToast(`已添加 ${imported.length} 张附图`);
    },
    [showToast]
  );

  const handleRemoveCardImage = useCallback((cardId: string, imageId: string) => {
    const targetCard = cardsRef.current.find((c) => c.id === cardId);
    const targetImg = targetCard?.images?.find((img) => img.id === imageId);
    if (targetImg) void deleteStoredImage(targetImg);
    setCards((prev) =>
      prev.map((c) =>
        c.id === cardId
          ? { ...c, images: (c.images ?? []).filter((img) => img.id !== imageId) }
          : c
      )
    );
  }, []);

  const handleSaveAnnotatedImage = useCallback(
    async (file: File) => {
      if (!annotatingImage) return;
      const { cardId, imageId } = annotatingImage;
      const imported = await importImageFiles([file]);
      if (imported.length === 0) return;
      const replacement = imported[0];
      const oldCard = cardsRef.current.find((c) => c.id === cardId);
      const oldImg = oldCard?.images?.find((img) => img.id === imageId);
      setCards((prev) =>
        prev.map((c) => {
          if (c.id !== cardId) return c;
          const nextImages = (c.images ?? []).map((img) =>
            img.id === imageId ? replacement : img
          );
          return { ...c, images: nextImages };
        })
      );
      if (oldImg) void deleteStoredImage(oldImg);
      closeAnnotator();
      showToast('已保存图片标注');
    },
    [annotatingImage, closeAnnotator, showToast]
  );

  const handleDeleteCard = useCallback((cardId: string) => {
    const target = cardsRef.current.find((c) => c.id === cardId);
    if (target) {
      for (const img of target.images ?? []) void deleteStoredImage(img);
    }
    setCards((prev) => prev.filter((c) => c.id !== cardId));
    setEdges((prev) => prev.filter((e) => e.source !== cardId && e.target !== cardId));
    setAnchors((prev) => prev.filter((a) => a.targetNodeId !== cardId));
  }, []);

  const handlePreviewCardImage = useCallback(
    async (cardId: string, image: CardImage) => {
      const url = await createFullImageUrl(image);
      if (!url) return;
      setPreviewImage((prev) => {
        if (prev) revokeObjectUrlIfBlob(prev.url);
        return { url, alt: '批注附图', cardId, imageId: image.id };
      });
    },
    []
  );

  const handlePreviewBlob = useCallback(
    (blob: Blob, alt: string, epubParagraphId?: string) => {
      const url = URL.createObjectURL(blob);
      setPreviewImage((prev) => {
        if (prev) revokeObjectUrlIfBlob(prev.url);
        return {
          url,
          alt,
          epubParagraphId,
          epubBlob: epubParagraphId ? blob : undefined,
        };
      });
    },
    []
  );

  const recentCards = useMemo<LinkableCardOption[]>(() => {
    const anchorByCard = new Map<string, BookAnchor>();
    for (const a of anchors) {
      if (a.targetNodeId && !anchorByCard.has(a.targetNodeId)) {
        anchorByCard.set(a.targetNodeId, a);
      }
    }
    const sorted = [...cards].sort(
      (a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0)
    );
    return sorted.slice(0, 6).map((card) => {
      const bodyLine = card.body.trim().split('\n')[0]?.trim();
      const quoteLine = anchorByCard.get(card.id)?.quote?.trim();
      const preview =
        bodyLine ||
        quoteLine ||
        (card.images?.length ? `附图批注 (${card.images.length} 张)` : '空白批注卡');
      return {
        id: card.id,
        preview: preview.length > 48 ? `${preview.slice(0, 48)}…` : preview,
        badgeNumber: card.badgeNumber,
      };
    });
  }, [cards, anchors]);

  const scrollToSelector = useCallback((selector: string) => {
    const host = contentHostRef.current;
    const scroller = scrollRef.current;
    if (!host || !scroller) return;
    const target = host.querySelector<HTMLElement>(selector);
    if (!target) return;
    const offset =
      target.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    scroller.scrollTo({
      top: Math.max(0, scroller.scrollTop + offset - 16),
      behavior: 'smooth',
    });
  }, []);

  const handleTocJump = useCallback(
    (entry: TocEntry) => {
      const selector =
        entry.kind === 'pdf'
          ? `[data-pdf-page="${entry.target}"]`
          : `[data-paragraph-id="${entry.target}"]`;
      scrollToSelector(selector);
      setShowToc(false);
    },
    [scrollToSelector]
  );

  const handleSearchSelect = useCallback(
    (action: SearchResultAction) => {
      setShowReviewDrawer(false);
      setShowSearch(false);
      if (action.kind === 'other-book') {
        onSwitchBook?.(action.bookId);
        return;
      }
      if (action.kind === 'paragraph') {
        scrollToSelector(`[data-paragraph-id="${action.paragraphId}"]`);
        return;
      }
      if (action.kind === 'anchor') {
        setActiveAnchorId(action.anchorId);
        scrollToSelector(`[data-anchor-id="${action.anchorId}"]`);
        setSheetAnchorId(action.anchorId);
        return;
      }
      if (action.anchorId) {
        setActiveAnchorId(action.anchorId);
        scrollToSelector(`[data-anchor-id="${action.anchorId}"]`);
        setSheetAnchorId(action.anchorId);
      }
    },
    [onSwitchBook, scrollToSelector]
  );

  const sheetAnchor = useMemo(
    () => (sheetAnchorId ? anchors.find((a) => a.id === sheetAnchorId) ?? null : null),
    [sheetAnchorId, anchors]
  );

  return (
    <div className="mobile-reader">
      <header className="mobile-topbar">
        <button
          type="button"
          className="mobile-topbar__btn"
          title="返回书架"
          onClick={onBack}
        >
          <ArrowLeft size={18} />
        </button>

        <div className="mobile-topbar__doc">
          <span className="mobile-topbar__title">{bookTitle}</span>
          <span className="mobile-topbar__meta">
            {docReady ? (
              `${Math.round(readingProgress * 100)}%`
            ) : (
              <>
                <Loader2 size={11} className="topbar__spinner" /> 加载中
              </>
            )}
          </span>
        </div>

        <button
          type="button"
          className="mobile-topbar__btn"
          title="搜索"
          onClick={() => setShowSearch(true)}
        >
          <Search size={17} />
        </button>
        {syncRuntime && onOpenSync && (
          <SyncStatusBadge
            runtime={syncRuntime}
            variant="icon"
            className="mobile-topbar__btn"
            onClick={onOpenSync}
          />
        )}
        <button
          type="button"
          className="mobile-topbar__btn"
          title="阅读设置"
          onClick={onOpenSettings}
        >
          <Settings size={17} />
        </button>
      </header>

      {loadError && <div className="book-error-banner">{loadError}</div>}

      <div className="mobile-reader__stage">
        <div
          ref={scrollRef}
          className="mobile-reader__scroll"
          onScroll={handleScroll}
        >
          <div
            ref={contentHostRef}
            className="mobile-reader__content"
            style={
              {
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
                scale={1}
                containerWidth={viewportWidth}
                anchors={anchors}
                activeAnchorId={activeAnchorId}
                selectedCardId={null}
                isDraggingWireToBook={false}
                selectionMode="dock"
                recentCards={recentCards}
                cropMode={cropMode}
                onExitCropMode={() => setCropMode(false)}
                scrollContainerRef={scrollRef}
                onScroll={handleScroll}
                onPageRendered={() => {}}
                onCreatePdfAnnotation={handleCreatePdfAnnotation}
                onCreatePdfCropCard={(draft) => {
                  void handleCreatePdfCropCard(draft);
                }}
                onClickAnchor={(anchor) => {
                  setActiveAnchorId(anchor.id);
                  setSheetAnchorId(anchor.id);
                }}
                onPreviewImage={handlePreviewBlob}
                onOutline={setToc}
              />
            ) : (
              <BookPane
                paragraphs={paragraphs}
                anchors={anchors}
                activeAnchorId={activeAnchorId}
                selectedCardId={null}
                isDraggingWireToBook={false}
                selectionMode="dock"
                recentCards={recentCards}
                scrollContainerRef={scrollRef}
                epubImageLoader={epubImageLoader}
                onImageLoaded={handleEpubImageLoaded}
                onCreateImageCard={(paragraphId, blob, alt) => {
                  void handleCreateImageCard(paragraphId, blob, alt);
                }}
                onScroll={handleScroll}
                onCreateAnnotation={handleCreateTextAnnotation}
                onClickAnchor={(anchor) => {
                  setActiveAnchorId(anchor.id);
                  setSheetAnchorId(anchor.id);
                }}
                onPreviewImage={handlePreviewBlob}
              />
            )}
          </div>
        </div>

        <div className="mobile-reader__minimap">
          <AnchorMinimap
            docFormat={docFormat}
            anchors={anchors}
            paragraphs={paragraphs}
            activeAnchorId={activeAnchorId}
            onJumpAnchor={(anchor) => {
              setActiveAnchorId(anchor.id);
              scrollToSelector(`[data-anchor-id="${anchor.id}"]`);
              setSheetAnchorId(anchor.id);
            }}
          />
        </div>
      </div>

      <TtsPlayerBar
        open={showTts}
        bookId={book.id}
        bookTitle={bookTitle || book.title}
        initialLocator={book.ttsLocator}
        paragraphs={paragraphs}
        getCurrentVisibleParagraphId={() => {
          const scroller = scrollRef.current;
          const host = contentHostRef.current;
          if (!scroller || !host) return null;
          const top = scroller.getBoundingClientRect().top;
          const nodes = host.querySelectorAll<HTMLElement>('[data-paragraph-id]');
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
          if (pid) scrollToSelector(`[data-paragraph-id="${pid}"]`);
        }}
      />

      <nav className="mobile-bottom-bar" aria-label="阅读工具栏">
        <button
          type="button"
          className={`mobile-bottom-bar__item ${showToc ? 'is-active' : ''}`}
          disabled={toc.length === 0}
          onClick={() => {
            setShowReviewDrawer(false);
            setShowToc((v) => !v);
          }}
        >
          <ListTree size={18} />
          <span>目录</span>
        </button>

        <button
          type="button"
          className={`mobile-bottom-bar__item ${showReviewDrawer ? 'is-active' : ''}`}
          onClick={() => {
            setShowToc(false);
            setShowReviewDrawer((v) => !v);
          }}
        >
          <Bookmark size={18} />
          <span>批注 {anchors.length > 0 ? `(${anchors.length})` : ''}</span>
        </button>

        <button
          type="button"
          className="mobile-bottom-bar__item"
          onClick={() => {
            setShowToc(false);
            setShowReviewDrawer(false);
            setShowGallery(true);
          }}
        >
          <Images size={18} />
          <span>闪卡</span>
        </button>

        {docFormat === 'pdf' ? (
          <button
            type="button"
            className={`mobile-bottom-bar__item ${cropMode ? 'is-active' : ''}`}
            onClick={() => {
              setShowToc(false);
              setShowReviewDrawer(false);
              setCropMode((v) => !v);
            }}
          >
            <Crop size={18} />
            <span>{cropMode ? '框选中' : '框选'}</span>
          </button>
        ) : (
          <button
            type="button"
            className={`mobile-bottom-bar__item ${showTts ? 'is-active' : ''}`}
            onClick={() => setShowTts((v) => !v)}
          >
            <Headphones size={18} />
            <span>听书</span>
          </button>
        )}
      </nav>

      {showToc && (
        <div className="mobile-sheet-backdrop" onClick={() => setShowToc(false)}>
          <aside
            className="toc-panel mobile-drawer-sheet"
            aria-label="目录"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="toc-panel__header">
              <span>目录</span>
              <button
                type="button"
                className="topbar__icon-btn"
                onClick={() => setShowToc(false)}
              >
                <X size={16} />
              </button>
            </div>
            <div className="toc-panel__list">
              {toc.map((entry, index) => (
                <button
                  key={`${entry.target}-${index}`}
                  type="button"
                  className="toc-panel__item"
                  style={{ paddingLeft: `${12 + entry.depth * 14}px` }}
                  onClick={() => handleTocJump(entry)}
                >
                  {entry.label}
                </button>
              ))}
            </div>
          </aside>
        </div>
      )}

      {showReviewDrawer && (
        <div
          className="mobile-sheet-backdrop"
          onClick={() => setShowReviewDrawer(false)}
        >
          <div
            className="mobile-drawer-host"
            onClick={(e) => e.stopPropagation()}
          >
            <AnnotationDrawer
              anchors={anchors}
              cards={cards}
              paragraphs={paragraphs}
              onClose={() => setShowReviewDrawer(false)}
              onSelect={handleSearchSelect}
            />
          </div>
        </div>
      )}

      <MobileNoteSheet
        anchor={sheetAnchor}
        cards={cards}
        edges={edges}
        autoFocusCardId={autoFocusCardId}
        onAutoFocused={() => setAutoFocusCardId(null)}
        onClose={() => setSheetAnchorId(null)}
        onUpdateAnchor={handleUpdateAnchor}
        onDeleteAnchor={handleDeleteAnchor}
        onPromoteAnchor={handlePromoteAnchor}
        onChangeBody={handleChangeBody}
        onAddChildCard={handleAddChildCard}
        onDeleteCard={handleDeleteCard}
        onAddImages={(cardId, files) => void handleAddCardImages(cardId, files)}
        onRemoveImage={handleRemoveCardImage}
        onPreviewImage={(cardId, img) => void handlePreviewCardImage(cardId, img)}
      />

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

      {remoteProgressPrompt && (
        <div className="sync-progress-toast is-mobile" role="status" aria-live="polite">
          <span>
            对端已读到 {Math.round(remoteProgressPrompt.progress * 100)}%
          </span>
          <button
            type="button"
            className="sync-progress-toast__jump"
            onClick={() => {
              const parsed = parseLocator(remoteProgressPrompt.locator);
              const scroller = scrollRef.current;
              const host = contentHostRef.current;
              if (scroller && parsed) {
                if (host && parsed.paragraphId) {
                  scrollToSelector(`[data-paragraph-id="${parsed.paragraphId}"]`);
                } else if (host && parsed.pdfPage) {
                  scrollToSelector(`[data-pdf-page="${parsed.pdfPage}"]`);
                } else {
                  scroller.scrollTo({ top: parsed.top, behavior: 'smooth' });
                }
              }
              setReadingProgress(remoteProgressPrompt.progress);
              setRemoteProgressPrompt(null);
            }}
          >
            跳转
          </button>
          <button
            type="button"
            className="sync-progress-toast__close"
            title="忽略"
            onClick={() => setRemoteProgressPrompt(null)}
          >
            <X size={13} />
          </button>
        </div>
      )}

      {toastMessage && (
        <div className="mobile-toast" role="status" aria-live="polite">
          {toastMessage}
        </div>
      )}

      {previewImage && (
        <div className="image-lightbox-backdrop" onClick={closePreview}>
          <div
            className="image-lightbox-frame"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="image-lightbox-actions">
              {previewImage.cardId && previewImage.imageId && (
                <button
                  type="button"
                  className="image-lightbox-pill-btn"
                  onClick={() => {
                    const { cardId, imageId, url } = previewImage;
                    if (!cardId || !imageId) return;
                    setPreviewImage(null);
                    setAnnotatingImage({ cardId, imageId, url });
                  }}
                >
                  <Pencil size={13} />
                  <span>涂鸦标注</span>
                </button>
              )}
              {previewImage.epubParagraphId && previewImage.epubBlob && (
                <button
                  type="button"
                  className="image-lightbox-pill-btn"
                  onClick={() => {
                    const { epubParagraphId, epubBlob, alt } = previewImage;
                    if (!epubParagraphId || !epubBlob) return;
                    closePreview();
                    void handleCreateImageCard(epubParagraphId, epubBlob, alt);
                  }}
                >
                  <MessageSquarePlus size={13} />
                  <span>转成批注卡</span>
                </button>
              )}
              <button
                type="button"
                className="image-lightbox-action-btn"
                title="关闭预览"
                onClick={closePreview}
              >
                <X size={15} />
              </button>
            </div>
            <img
              src={previewImage.url}
              alt={previewImage.alt}
              className="image-lightbox-img"
            />
          </div>
        </div>
      )}

      {annotatingImage && (
        <ImageAnnotatorModal
          imageUrl={annotatingImage.url}
          onCancel={closeAnnotator}
          onSave={handleSaveAnnotatedImage}
        />
      )}
    </div>
  );
}

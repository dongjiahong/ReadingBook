import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  GitCommitHorizontal,
  LayoutGrid,
  ListTree,
  Loader2,
  PlusCircle,
  RotateCcw,
  Settings,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { AnnotationCard } from './components/AnnotationCard';
import { BookPane } from './components/BookPane';
import {
  BookToCanvasBridge,
  type MidLineRoutingMode,
} from './components/BookToCanvasBridge';
import { PdfBookPane, type PdfSource } from './components/PdfBookPane';
import type {
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
  createFullImageUrl,
  releaseImage,
  restoreThumbUrls,
} from './utils/imageStore';

const DEFAULT_FREE_CARD_TEXT = '可在右侧无限画布任意摆放，支持粘贴截图或拖入图片。';

function parseLocator(locator: string | null): { top: number; left: number } | null {
  if (!locator) return null;
  try {
    const parsed = JSON.parse(locator) as { top?: number; left?: number };
    return { top: Number(parsed.top) || 0, left: Number(parsed.left) || 0 };
  } catch {
    return null;
  }
}

interface PreviewImageState {
  id: string;
  url: string;
  alt?: string;
  zoomable?: boolean;
}

interface ReaderViewProps {
  book: BookRecord;
  settings: ReaderSettings;
  onBack: () => void;
  onOpenSettings: () => void;
  onSettingsChange: (patch: Partial<ReaderSettings>) => void;
  onProgress: (bookId: string, progress: number, locator: string) => void;
}

export default function ReaderView({
  book,
  settings,
  onBack,
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
  const restoreScrollRef = useRef<{ top: number; left: number } | null>(null);

  const [bookWidth, setBookWidth] = useState<number>(settings.bookWidth);
  const [isResizing, setIsResizing] = useState(false);
  const [docReady, setDocReady] = useState(false);
  const [toc, setToc] = useState<TocEntry[]>([]);
  const [showToc, setShowToc] = useState(false);

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

  const [activeAnchorId, setActiveAnchorId] = useState<string | null>(null);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
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
    if (current) URL.revokeObjectURL(current.url);
    previewImageRef.current = null;
    setPreviewImage(null);
  }, []);

  const releaseCardImages = useCallback((list: AnnotationCardItem[]) => {
    for (const card of list) {
      for (const image of card.images ?? []) {
        releaseImage(image.id);
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

  // Release thumbnail URLs and preview URL when the app unmounts
  useEffect(() => {
    return () => {
      const current = previewImageRef.current;
      if (current) URL.revokeObjectURL(current.url);
      previewImageRef.current = null;
      releaseCardImages(cardsRef.current);
    };
  }, [releaseCardImages]);

  // Compute dynamic infinite width for the right canvas based on the rightmost card
  const canvasMinWidth = useMemo(() => {
    let maxRight = 720;
    for (const c of cards) {
      if (c.x + 360 > maxRight) {
        maxRight = c.x + 360;
      }
    }
    return maxRight + 420;
  }, [cards]);

  // Compute dynamic minimum height so cards placed lower than short books are still reachable
  const canvasMinHeight = useMemo(() => {
    let maxBottom = 600;
    for (const c of cards) {
      if (c.y + 260 > maxBottom) {
        maxBottom = c.y + 260;
      }
    }
    return maxBottom;
  }, [cards]);

  // Compute card-to-card Bézier curves directly in right-canvas local coordinates
  const [cardEdgePaths, setCardEdgePaths] = useState<
    { id: string; d: string; color: string }[]
  >([]);

  const recomputeCardEdges = useCallback(() => {
    const canvasEl = canvasRef.current;
    if (!canvasEl) return;
    const canvasRect = canvasEl.getBoundingClientRect();

    const nextPaths: { id: string; d: string; color: string }[] = [];
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

  const handleMoveCard = useCallback((cardId: string, nextX: number, nextY: number) => {
    setCards((prev) =>
      prev.map((c) => (c.id === cardId ? { ...c, x: nextX, y: nextY } : c))
    );
  }, []);

  const handleChangeBody = useCallback((cardId: string, newBody: string) => {
    setCards((prev) =>
      prev.map((c) => (c.id === cardId ? { ...c, body: newBody } : c))
    );
  }, []);

  const handleAddImages = useCallback((cardId: string, newImages: CardImage[]) => {
    if (!cardsRef.current.some((card) => card.id === cardId)) {
      for (const image of newImages) releaseImage(image.id);
      return;
    }
    setCards((prev) =>
      prev.map((c) =>
        c.id === cardId ? { ...c, images: [...(c.images ?? []), ...newImages] } : c
      )
    );
  }, []);

  const handleRemoveImage = useCallback(
    (cardId: string, image: CardImage) => {
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
      releaseImage(image.id);
      if (previewImageRef.current?.id === image.id) {
        closePreviewImage();
      }
    },
    [closePreviewImage]
  );

  const handlePreviewImage = useCallback(async (image: CardImage) => {
    const url = await createFullImageUrl(image.id);
    if (!url) return;

    const current = previewImageRef.current;
    if (current) URL.revokeObjectURL(current.url);
    const next = { id: image.id, url, alt: '批注附图', zoomable: false };
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
    const targetEl = bookEl.querySelector<HTMLElement>(`[data-anchor-id="${anchorId}"]`);
    if (targetEl) {
      targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, []);

  const handleDeleteCard = useCallback((cardId: string) => {
    const target = cardsRef.current.find((card) => card.id === cardId);
    if (target) releaseCardImages([target]);

    setCards((prev) => prev.filter((c) => c.id !== cardId));
    setEdges((prev) => prev.filter((e) => e.source !== cardId && e.target !== cardId));
    setAnchors((prev) => prev.filter((a) => a.targetNodeId !== cardId));
  }, [releaseCardImages]);

  // Find a non-overlapping Y coordinate in the target column using actual rendered DOM heights
  const findNonOverlappingY = useCallback(
    (
      targetX: number,
      idealY: number,
      newCardEstHeight: number,
      list: AnnotationCardItem[]
    ) => {
      const GAP = 16;
      const canvasEl = canvasRef.current;
      const sameCol = list
        .filter((c) => Math.abs(c.x - targetX) < 252)
        .map((c) => {
          const el = canvasEl?.querySelector<HTMLElement>(`[data-card-id="${c.id}"]`);
          const h = el ? el.getBoundingClientRect().height : 72;
          return { top: c.y, bottom: c.y + h };
        })
        .sort((a, b) => a.top - b.top);

      let candidateY = Math.max(16, idealY);
      for (const box of sameCol) {
        const candidateBottom = candidateY + newCardEstHeight;
        if (candidateBottom + GAP > box.top && candidateY < box.bottom + GAP) {
          candidateY = box.bottom + GAP;
        }
      }
      return Math.round(candidateY);
    },
    []
  );

  const handleAddChildCard = useCallback(
    (sourceCardId: string) => {
      const childId = `card-${Date.now()}`;
      setCards((prev) => {
        const src = prev.find((c) => c.id === sourceCardId);
        if (!src) return prev;
        const nextX = src.x + 292;
        const nextY = findNonOverlappingY(nextX, src.y, 56, prev);

        return [
          ...prev,
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

  // Structured Symmetric Auto-Layout: aligns cards into neat columns and centers child groups around their parent
  const handleAutoLayoutCards = useCallback(() => {
    const canvasEl = canvasRef.current;
    const bookEl = bookStickyRef.current;
    if (!canvasEl || !bookEl || cards.length === 0) return;

    const canvasRect = canvasEl.getBoundingClientRect();

    // 1. Measure actual DOM height of every card
    const cardHeightMap = new Map<string, number>();
    for (const c of cards) {
      const el = canvasEl.querySelector<HTMLElement>(`[data-card-id="${c.id}"]`);
      cardHeightMap.set(c.id, el ? el.getBoundingClientRect().height : 64);
    }

    // 2. Measure true book anchor Y (in canvas local coordinate space) for anchored cards
    const anchorTargetYMap = new Map<string, number>();
    for (const anchor of anchors) {
      const anchorEl = bookEl.querySelector<HTMLElement>(
        `[data-anchor-id="${anchor.id}"]`
      );
      if (anchorEl) {
        const rect = anchorEl.getBoundingClientRect();
        if (rect.height > 0) {
          const localY = Math.max(20, rect.top - canvasRect.top - 10);
          anchorTargetYMap.set(anchor.targetNodeId, localY);
        }
      }
    }

    // 3. Build parent -> children graph from edges and assign column index (0, 1, 2, ...)
    const incomingMap = new Map<string, string[]>();
    const outgoingMap = new Map<string, string[]>();
    for (const edge of edges) {
      incomingMap.set(edge.target, [...(incomingMap.get(edge.target) ?? []), edge.source]);
      outgoingMap.set(edge.source, [...(outgoingMap.get(edge.source) ?? []), edge.target]);
    }

    const colMap = new Map<string, number>();
    const visited = new Set<string>();

    const roots = cards.filter(
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

    for (const c of cards) {
      if (!colMap.has(c.id)) colMap.set(c.id, 0);
    }

    // 4. Group cards by column index (0, 1, 2, ...)
    const maxCol = Math.max(0, ...Array.from(colMap.values()));
    const newPosMap = new Map<string, { x: number; y: number }>();

    // Anchor the first column to the currently visible left edge so laid-out
    // cards never end up underneath the sticky book column.
    const COL_START_X = (unifiedScrollRef.current?.scrollLeft ?? 0) + 44;
    const COL_STEP_X = 292;
    const ROW_GAP_Y = 18;

    for (let col = 0; col <= maxCol; col++) {
      const colCards = cards.filter((c) => (colMap.get(c.id) ?? 0) === col);
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

      let prevBottom = 16;
      const targetX = COL_START_X + col * COL_STEP_X;

      for (const c of colCards) {
        const idealY = desiredYMap.get(c.id) ?? c.y;
        const actualY = Math.max(idealY, prevBottom);
        newPosMap.set(c.id, { x: targetX, y: Math.round(actualY) });
        const cardH = cardHeightMap.get(c.id) ?? 64;
        prevBottom = actualY + cardH + ROW_GAP_Y;
      }
    }

    setCards((prev) =>
      prev.map((c) => {
        const pos = newPosMap.get(c.id);
        return pos ? { ...c, x: pos.x, y: pos.y } : c;
      })
    );
  }, [cards, anchors, edges]);

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
          const shouldFillQuote =
            !c.body.trim() || c.body.trim() === DEFAULT_FREE_CARD_TEXT;
          return {
            ...c,
            badgeNumber,
            anchorId,
            body: shouldFillQuote && anchorMeta.quote ? anchorMeta.quote : c.body,
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
      releaseCardImages(cardsRef.current);
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
          const parsed = await parseEpubFile(source);
          if (cancelled) return;
          disposeCurrentBook();
          setDocFormat('epub');
          setBookTitle(parsed.title);
          setParagraphs(parsed.paragraphs);
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

  // Restore the reading position once layout has settled.
  useEffect(() => {
    if (!docReady) return;
    const target = restoreScrollRef.current;
    restoreScrollRef.current = null;
    const el = unifiedScrollRef.current;
    if (!el) return;

    const apply = () => {
      if (target) {
        el.scrollTop = target.top;
        // Never restore so far right that the first card column is hidden
        // under the sticky book column.
        const minCardX = cardsRef.current.reduce(
          (min, card) => Math.min(min, card.x),
          Number.POSITIVE_INFINITY
        );
        const maxLeft = Number.isFinite(minCardX)
          ? Math.max(0, minCardX - 16)
          : target.left;
        el.scrollLeft = Math.min(target.left, maxLeft);
      } else {
        el.scrollLeft = 0;
      }
      bumpSync();
    };
    const first = window.setTimeout(apply, 120);
    const second = window.setTimeout(apply, 600);
    return () => {
      window.clearTimeout(first);
      window.clearTimeout(second);
    };
  }, [docReady, bumpSync]);

  // Persist annotations (debounced so typing stays smooth).
  useEffect(() => {
    if (!hydratedRef.current) return;
    const timer = window.setTimeout(() => {
      void saveAnnotations(book.id, {
        anchors,
        cards: cards.map((card) => ({
          ...card,
          images: card.images?.map((image) => ({
            id: image.id,
            thumbUrl: '',
            width: image.width,
            height: image.height,
          })),
        })),
        edges,
      }).catch((err) => console.warn('保存批注失败', err));
    }, 600);
    return () => window.clearTimeout(timer);
  }, [book.id, anchors, cards, edges]);

  useEffect(() => {
    if (!showToc) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowToc(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showToc]);

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

  const handleScroll = useCallback(() => {
    bumpSync();
    const el = unifiedScrollRef.current;
    if (!el) return;
    if (progressTimerRef.current) window.clearTimeout(progressTimerRef.current);
    progressTimerRef.current = window.setTimeout(() => {
      const max = el.scrollHeight - el.clientHeight;
      const ratio = max > 0 ? Math.min(1, Math.max(0, el.scrollTop / max)) : 0;
      const locator = JSON.stringify({
        top: Math.round(el.scrollTop),
        left: Math.round(el.scrollLeft),
      });
      lastProgressRef.current = { progress: ratio, locator };
      onProgress(book.id, ratio, locator);
    }, 500);
  }, [book.id, bumpSync, onProgress]);

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
        bindExistingCardToAnchor(linkToExistingNodeId, anchorMeta);
        return;
      }

      const kind = anchorMeta.style === 'highlight' ? 'review' : 'revision';
      const sameKindCount = anchors.filter((a) => a.kind === kind).length;
      const badgeNumber = sameKindCount + 1;
      const anchorId = `anchor-${Date.now()}`;
      const cardId = `card-${Date.now()}`;

      // Convert screen Y directly into unified canvas Y (same native scroll coordinate!)
      const canvasRect = canvasRef.current?.getBoundingClientRect();
      const rawY = canvasRect ? anchorScreenY - canvasRect.top - 20 : 100;
      const estLines = Math.max(1, Math.ceil(anchorMeta.quote.length / 18));
      const estHeight = 20 + estLines * 19;
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
        x: 44,
        y: candidateY,
        kind,
        badgeNumber,
        body: anchorMeta.quote,
        status: kind === 'revision' ? 'pending' : undefined,
        anchorId,
      };

      setAnchors((prev) => [...prev, newAnchor]);
      setCards((prev) => [...prev, newCard]);
      setActiveAnchorId(anchorId);
      setSelectedCardId(cardId);
    },
    [anchors, cards, bindExistingCardToAnchor, findNonOverlappingY]
  );

  const handleCreateTextAnnotation = useCallback(
    (draft: {
      paragraphId: string;
      quote: string;
      startOffset: number;
      endOffset: number;
      style: AnnotationStyle;
      anchorScreenY: number;
      linkToExistingNodeId?: string;
    }) => {
      const para = paragraphs.find((p) => p.id === draft.paragraphId);
      const epubCfi = para?.epubCfiBase
        ? `${para.epubCfiBase}/1:${draft.startOffset}`
        : undefined;

      spawnCardForAnchor(
        {
          docFormat,
          paragraphId: draft.paragraphId,
          epubCfi,
          quote: draft.quote,
          startOffset: draft.startOffset,
          endOffset: draft.endOffset,
          style: draft.style,
        },
        draft.anchorScreenY,
        draft.linkToExistingNodeId
      );
    },
    [paragraphs, docFormat, spawnCardForAnchor]
  );

  const handleCreatePdfAnnotation = useCallback(
    (draft: {
      pageNumber: number;
      quote: string;
      rects: NormalizedPdfRect[];
      style: AnnotationStyle;
      anchorScreenY: number;
      linkToExistingNodeId?: string;
    }) => {
      spawnCardForAnchor(
        {
          docFormat: 'pdf',
          paragraphId: `pdf-page-${draft.pageNumber}`,
          pdfPage: draft.pageNumber,
          pdfRects: draft.rects,
          quote: draft.quote,
          startOffset: 0,
          endOffset: draft.quote.length,
          style: draft.style,
        },
        draft.anchorScreenY,
        draft.linkToExistingNodeId
      );
    },
    [spawnCardForAnchor]
  );

  const handleClickBookAnchor = useCallback((anchor: BookAnchor) => {
    setActiveAnchorId(anchor.id);
    setSelectedCardId(anchor.targetNodeId);
    const cardEl = canvasRef.current?.querySelector<HTMLElement>(
      `[data-card-id="${anchor.targetNodeId}"]`
    );
    if (cardEl) {
      cardEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
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
        <div className="topbar__left">
          <button
            type="button"
            className="topbar__icon-btn"
            title="返回书架"
            onClick={onBack}
          >
            <ArrowLeft size={16} />
          </button>
          <div className="topbar__doc">
            <span className="topbar__title" data-tauri-drag-region>
              {bookTitle}
            </span>
            <span className="topbar__meta" data-tauri-drag-region>
              {docFormat.toUpperCase()}
              {!docReady && (
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
            <div className="topbar__zoom-group">
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
          )}

          <span className="topbar__divider" />

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

          <button
            type="button"
            className="topbar__icon-btn"
            title="自动排列：按批注层级把卡片上下对称铺开"
            onClick={handleAutoLayoutCards}
          >
            <LayoutGrid size={15} />
          </button>

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

          <span className="topbar__divider" />

          {toc.length > 0 && (
            <button
              type="button"
              className={`topbar__icon-btn ${showToc ? 'is-active' : ''}`}
              title="目录"
              onClick={() => setShowToc((visible) => !visible)}
            >
              <ListTree size={15} />
            </button>
          )}

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
                  scrollContainerRef={unifiedScrollRef}
                  onScroll={handleScroll}
                  onPageRendered={bumpSync}
                  onCreatePdfAnnotation={handleCreatePdfAnnotation}
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
                {cardEdgePaths.map((edge) => (
                  <g key={edge.id} className="card-edge-group">
                    <path
                      d={edge.d}
                      fill="none"
                      stroke={edge.color}
                      strokeWidth={1.7}
                      strokeOpacity={0.8}
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
                ))}
              </svg>

              {/* Draggable, Auto-Expanding Minimalist Cards */}
              {cards.map((card) => (
                <AnnotationCard
                  key={card.id}
                  card={card}
                  isSelected={
                    selectedCardId === card.id ||
                    (activeAnchorId !== null && card.anchorId === activeAnchorId)
                  }
                  onSelect={(id) => {
                    setSelectedCardId(id);
                    const found = cards.find((c) => c.id === id);
                    if (found?.anchorId) setActiveAnchorId(found.anchorId);
                  }}
                  onMoveCard={handleMoveCard}
                  onChangeBody={handleChangeBody}
                  onAddImages={handleAddImages}
                  onRemoveImage={handleRemoveImage}
                  onPreviewImage={handlePreviewImage}
                  onUpdateStatus={handleUpdateStatus}
                  onAddChild={handleAddChildCard}
                  onDelete={handleDeleteCard}
                  onFocusAnchor={handleFocusAnchor}
                  onStartDragToBook={handleStartDragToBook}
                  onStartDragToCard={handleStartDragToCard}
                  onLayoutChange={recomputeCardEdges}
                />
              ))}
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
      </div>

      {/* Fullscreen Image Lightbox Modal (click backdrop or press Esc to close) */}
      {previewImage && (
        <div className="image-lightbox-backdrop" onClick={closePreviewImage}>
          <div className="image-lightbox-hint">
            点击任意空白处或按 Esc 键返回
          </div>
          <button
            type="button"
            className="image-lightbox-close"
            title="关闭预览 (Esc)"
            onClick={closePreviewImage}
          >
            <X size={18} />
          </button>
          {previewImage.zoomable ? (
            <div
              className="image-lightbox-stage"
              onClick={(e) => e.stopPropagation()}
            >
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
              onClick={(e) => e.stopPropagation()}
            />
          )}
        </div>
      )}
    </div>
  );
}

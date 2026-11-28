import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Check, RotateCcw, X } from 'lucide-react';
import * as pdfjsLib from 'pdfjs-dist';
import type { AnchorColor, AnnotationStyle, BookAnchor, NormalizedPdfRect, TocEntry } from '../types';
import {
  MobileSelectionDock,
  type LinkableCardOption,
} from './MobileSelectionDock';
import { SelectionPopover } from './SelectionPopover';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

const MAX_CANVAS_PIXELS = 4_000_000;

function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}

interface PdfSelectionDraft {
  pageNumber: number;
  quote: string;
  rects: NormalizedPdfRect[];
  popupX: number;
  popupY: number;
  anchorScreenY: number;
}

interface PendingCropState {
  pageNumber: number;
  pageEl: HTMLElement;
  rect: NormalizedPdfRect;
}

type CropHandle = 'nw' | 'ne' | 'sw' | 'se' | 'move';

/** PDF bytes come from an in-memory file or straight from the library on disk. */
export type PdfSource =
  | { kind: 'file'; file: File }
  | { kind: 'disk'; path: string; size: number };

/** pdf.js transport that pulls byte ranges from disk through the Rust side. */
class DiskRangeTransport extends pdfjsLib.PDFDataRangeTransport {
  private readonly path: string;

  constructor(path: string, size: number) {
    super(size, new Uint8Array(), false);
    this.path = path;
  }

  requestDataRange(begin: number, end: number): void {
    void invoke<ArrayBuffer>('read_book_range', {
      path: this.path,
      offset: begin,
      length: end - begin,
    })
      .then((buffer) => this.onDataRange(begin, new Uint8Array(buffer)))
      .catch((err) => {
        console.warn('PDF 区间读取失败', err);
        this.onDataRange(begin, new Uint8Array());
      });
  }

  abort(): void {
    // Reads are short-lived; nothing to cancel.
  }
}

interface PdfBookPaneProps {
  source: PdfSource;
  scale: number;
  containerWidth: number;
  anchors: BookAnchor[];
  activeAnchorId: string | null;
  selectedCardId: string | null;
  isDraggingWireToBook: boolean;
  selectionMode?: 'popover' | 'dock';
  recentCards?: LinkableCardOption[];
  cropMode?: boolean;
  onExitCropMode?: () => void;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  onPageRendered: () => void;
  onCreatePdfAnnotation: (draft: {
    pageNumber: number;
    quote: string;
    rects: NormalizedPdfRect[];
    style: AnnotationStyle;
    color?: AnchorColor;
    anchorScreenY: number;
    /** false 时只做基础标注，不创建卡片。 */
    withCard?: boolean;
    linkToExistingNodeId?: string;
  }) => void;
  onCreatePdfCropCard?: (draft: {
    pageNumber: number;
    rect: NormalizedPdfRect;
    blob: Blob;
    anchorScreenY: number;
  }) => void;
  onClickAnchor: (anchor: BookAnchor, point?: { x: number; y: number }) => void;
  onPreviewImage: (blob: Blob, alt: string) => void;
  onOutline?: (entries: TocEntry[]) => void;
}

export const PdfBookPane: React.FC<PdfBookPaneProps> = memo(function PdfBookPane({
  source,
  scale,
  containerWidth,
  anchors,
  activeAnchorId,
  selectedCardId,
  isDraggingWireToBook,
  selectionMode = 'popover',
  recentCards = [],
  cropMode = false,
  onExitCropMode,
  scrollContainerRef,
  onScroll,
  onPageRendered,
  onCreatePdfAnnotation,
  onCreatePdfCropCard,
  onClickAnchor,
  onPreviewImage,
  onOutline,
}) {
  const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [pageNumbers, setPageNumbers] = useState<number[]>([]);
  const [defaultAspectRatio, setDefaultAspectRatio] = useState<number>(1.414);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [selectionDraft, setSelectionDraft] = useState<PdfSelectionDraft | null>(null);
  const selectionTimerRef = useRef<number | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const [boxDrag, setBoxDrag] = useState<{
    pageNumber: number;
    pageEl: HTMLElement;
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
  } | null>(null);
  const [pendingCrop, setPendingCrop] = useState<PendingCropState | null>(null);
  const cropAdjustRef = useRef<{
    handle: CropHandle;
    startX: number;
    startY: number;
    origRect: NormalizedPdfRect;
    pageRect: DOMRect;
  } | null>(null);

  useEffect(() => {
    if (!cropMode) {
      setBoxDrag(null);
      setPendingCrop(null);
      cropAdjustRef.current = null;
    }
  }, [cropMode]);

  // Group anchors by page once instead of filtering per page on every render
  const anchorsByPage = useMemo(() => {
    const map = new Map<number, BookAnchor[]>();
    for (const anchor of anchors) {
      if (!anchor.pdfPage) continue;
      const list = map.get(anchor.pdfPage);
      if (list) list.push(anchor);
      else map.set(anchor.pdfPage, [anchor]);
    }
    return map;
  }, [anchors]);

  useEffect(() => {
    if (selectionMode !== 'popover') return;
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.selection-popover')) {
        setSelectionDraft(null);
      }
    };
    window.addEventListener('mousedown', handleMouseDown);
    return () => window.removeEventListener('mousedown', handleMouseDown);
  }, [selectionMode]);

  useEffect(() => {
    let cancelled = false;
    let loadingTask: pdfjsLib.PDFDocumentLoadingTask | null = null;
    setErrorMsg(null);
    setPdfDoc(null);
    setPageNumbers([]);
    setSelectionDraft(null);
    setDefaultAspectRatio(1.414);

    const load = async () => {
      try {
        if (source.kind === 'disk') {
          // Ranged reads: a 100MB PDF never lands in the webview heap.
          loadingTask = pdfjsLib.getDocument({
            range: new DiskRangeTransport(source.path, source.size),
            disableStream: true,
            disableAutoFetch: true,
          });
        } else {
          loadingTask = pdfjsLib.getDocument({ data: await source.file.arrayBuffer() });
        }
        const doc = await loadingTask.promise;
        if (cancelled) {
          void loadingTask.destroy();
          return;
        }
        // Read page 1 aspect ratio once for accurate off-screen placeholder heights
        const firstPage = await doc.getPage(1);
        const vp = firstPage.getViewport({ scale: 1 });
        if (!cancelled && vp.width > 0) {
          setDefaultAspectRatio(vp.height / vp.width);
        }
        setPdfDoc(doc);
        setPageNumbers(Array.from({ length: doc.numPages }, (_, i) => i + 1));

        if (onOutline) {
          const outline = await doc.getOutline().catch(() => null);
          if (outline && !cancelled) {
            const entries: TocEntry[] = [];
            const resolvePage = async (dest: unknown): Promise<number | null> => {
              try {
                const target =
                  typeof dest === 'string' ? await doc.getDestination(dest) : dest;
                if (!Array.isArray(target) || target.length === 0) return null;
                const ref = target[0];
                if (ref && typeof ref === 'object') {
                  return (await doc.getPageIndex(ref)) + 1;
                }
                return null;
              } catch {
                return null;
              }
            };
            const walk = async (
              items: typeof outline,
              depth: number
            ): Promise<void> => {
              for (const item of items) {
                const page = await resolvePage(item.dest);
                if (page) {
                  entries.push({
                    label: item.title || `第 ${page} 页`,
                    target: String(page),
                    depth,
                    kind: 'pdf',
                  });
                }
                if (item.items?.length) await walk(item.items, depth + 1);
              }
            };
            await walk(outline, 0);
            if (!cancelled) onOutline(entries);
          }
        }
      } catch (err) {
        if (!cancelled) {
          setErrorMsg(err instanceof Error ? err.message : 'PDF 加载失败');
        }
      }
    };

    void load();

    return () => {
      cancelled = true;
      if (loadingTask) {
        void loadingTask.destroy();
      }
    };
  }, [source]);

  const readPdfSelectionDraft = useCallback(() => {
    if (cropMode) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      if (selectionMode === 'dock') setSelectionDraft(null);
      return;
    }
    const quote = sel.toString().trim();
    if (!quote) {
      if (selectionMode === 'dock') setSelectionDraft(null);
      return;
    }

    const range = sel.getRangeAt(0);
    let node: Node | null = range.startContainer;
    let pageEl: HTMLElement | null = null;
    while (node) {
      if (node instanceof HTMLElement && node.dataset.pdfPage) {
        pageEl = node;
        break;
      }
      node = node.parentNode;
    }
    if (!pageEl) {
      if (selectionMode === 'dock') setSelectionDraft(null);
      return;
    }
    if (containerRef.current && !containerRef.current.contains(pageEl)) return;

    const pageNumber = Number(pageEl.dataset.pdfPage);
    const pageRect = pageEl.getBoundingClientRect();
    const clientRects = Array.from(range.getClientRects()).filter(
      (r) => r.width > 2 && r.height > 2
    );
    if (clientRects.length === 0) return;

    const rects: NormalizedPdfRect[] = clientRects.map((r) => ({
      x: Math.max(0, Math.min(1, (r.left - pageRect.left) / pageRect.width)),
      y: Math.max(0, Math.min(1, (r.top - pageRect.top) / pageRect.height)),
      w: Math.min(1, r.width / pageRect.width),
      h: Math.min(1, r.height / pageRect.height),
    }));

    const first = clientRects[0];
    const last = clientRects[clientRects.length - 1];

    setSelectionDraft({
      pageNumber,
      quote,
      rects,
      popupX: first.left + first.width / 2,
      popupY: Math.max(56, first.top - 10),
      anchorScreenY: last.top + last.height / 2,
    });
  }, [cropMode, selectionMode]);

  useEffect(() => {
    if (selectionMode !== 'dock') return;
    const onSelectionChange = () => {
      if (selectionTimerRef.current) window.clearTimeout(selectionTimerRef.current);
      selectionTimerRef.current = window.setTimeout(() => {
        selectionTimerRef.current = null;
        readPdfSelectionDraft();
      }, 140);
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => {
      document.removeEventListener('selectionchange', onSelectionChange);
      if (selectionTimerRef.current) {
        window.clearTimeout(selectionTimerRef.current);
        selectionTimerRef.current = null;
      }
    };
  }, [selectionMode, readPdfSelectionDraft]);

  const commitCropRect = useCallback(
    (pageNumber: number, pageEl: HTMLElement, normRect: NormalizedPdfRect) => {
      const pageRect = pageEl.getBoundingClientRect();
      const top = pageRect.top + normRect.y * pageRect.height;
      const left = pageRect.left + normRect.x * pageRect.width;
      const width = normRect.w * pageRect.width;
      const height = normRect.h * pageRect.height;
      const canvas = pageEl.querySelector<HTMLCanvasElement>('canvas');
      if (canvas && canvas.width > 0 && canvas.height > 0 && onCreatePdfCropCard) {
        const sx = Math.round(normRect.x * canvas.width);
        const sy = Math.round(normRect.y * canvas.height);
        const sw = Math.max(1, Math.round(normRect.w * canvas.width));
        const sh = Math.max(1, Math.round(normRect.h * canvas.height));
        const offscreen = document.createElement('canvas');
        offscreen.width = sw;
        offscreen.height = sh;
        const ctx = offscreen.getContext('2d');
        if (ctx) {
          ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
          offscreen.toBlob((blob) => {
            if (blob) {
              onCreatePdfCropCard({
                pageNumber,
                rect: normRect,
                blob,
                anchorScreenY: top + height / 2,
              });
            }
          }, 'image/png');
          setPendingCrop(null);
          onExitCropMode?.();
          return;
        }
      }
      setPendingCrop(null);
      setSelectionDraft({
        pageNumber,
        quote: `PDF 第 ${pageNumber} 页选区批注`,
        rects: [normRect],
        popupX: left + width / 2,
        popupY: Math.max(56, top - 10),
        anchorScreenY: top + height / 2,
      });
      onExitCropMode?.();
    },
    [onCreatePdfCropCard, onExitCropMode]
  );

  const finishBoxDrag = useCallback(
    (isTouch: boolean) => {
      if (!boxDrag) return false;
      const { pageNumber, pageEl, startX, startY, currentX, currentY } = boxDrag;
      setBoxDrag(null);
      const pageRect = pageEl.getBoundingClientRect();
      const left = Math.max(pageRect.left, Math.min(startX, currentX));
      const top = Math.max(pageRect.top, Math.min(startY, currentY));
      const right = Math.min(pageRect.right, Math.max(startX, currentX));
      const bottom = Math.min(pageRect.bottom, Math.max(startY, currentY));
      const width = right - left;
      const height = bottom - top;

      if (width > 14 && height > 10) {
        const normRect: NormalizedPdfRect = {
          x: (left - pageRect.left) / pageRect.width,
          y: (top - pageRect.top) / pageRect.height,
          w: width / pageRect.width,
          h: height / pageRect.height,
        };
        if (isTouch || selectionMode === 'dock') {
          setPendingCrop({ pageNumber, pageEl, rect: normRect });
        } else {
          commitCropRect(pageNumber, pageEl, normRect);
        }
      }
      return true;
    },
    [boxDrag, selectionMode, commitCropRect]
  );

  const handleMouseUp = useCallback(() => {
    if (finishBoxDrag(false)) return;
    readPdfSelectionDraft();
  }, [finishBoxDrag, readPdfSelectionDraft]);

  const startAdjustCrop = useCallback(
    (handle: CropHandle, clientX: number, clientY: number) => {
      if (!pendingCrop) return;
      cropAdjustRef.current = {
        handle,
        startX: clientX,
        startY: clientY,
        origRect: { ...pendingCrop.rect },
        pageRect: pendingCrop.pageEl.getBoundingClientRect(),
      };
    },
    [pendingCrop]
  );

  const moveAdjustCrop = useCallback((clientX: number, clientY: number) => {
    const adj = cropAdjustRef.current;
    if (!adj) return;
    const dx = (clientX - adj.startX) / Math.max(1, adj.pageRect.width);
    const dy = (clientY - adj.startY) / Math.max(1, adj.pageRect.height);
    const r = adj.origRect;
    const minSize = 0.04;
    let x1 = r.x;
    let y1 = r.y;
    let x2 = r.x + r.w;
    let y2 = r.y + r.h;

    if (adj.handle === 'move') {
      const clampedDx = Math.max(-r.x, Math.min(1 - (r.x + r.w), dx));
      const clampedDy = Math.max(-r.y, Math.min(1 - (r.y + r.h), dy));
      x1 = r.x + clampedDx;
      y1 = r.y + clampedDy;
      x2 = x1 + r.w;
      y2 = y1 + r.h;
    } else {
      if (adj.handle === 'nw' || adj.handle === 'sw') {
        x1 = Math.max(0, Math.min(x2 - minSize, r.x + dx));
      }
      if (adj.handle === 'ne' || adj.handle === 'se') {
        x2 = Math.min(1, Math.max(x1 + minSize, r.x + r.w + dx));
      }
      if (adj.handle === 'nw' || adj.handle === 'ne') {
        y1 = Math.max(0, Math.min(y2 - minSize, r.y + dy));
      }
      if (adj.handle === 'sw' || adj.handle === 'se') {
        y2 = Math.min(1, Math.max(y1 + minSize, r.y + r.h + dy));
      }
    }

    setPendingCrop((prev) =>
      prev
        ? {
            ...prev,
            rect: { x: x1, y: y1, w: x2 - x1, h: y2 - y1 },
          }
        : null
    );
  }, []);

  const endAdjustCrop = useCallback(() => {
    cropAdjustRef.current = null;
  }, []);

  const availableWidth = Math.max(280, containerWidth - 40);

  return (
    <div
      ref={containerRef}
      className={`book-pane ${isDraggingWireToBook ? 'book-pane--drop-target' : ''} ${
        cropMode ? 'book-pane--crop-mode' : ''
      }`}
      onMouseUp={() => {
        endAdjustCrop();
        handleMouseUp();
      }}
      onTouchMove={(e) => {
        if (cropAdjustRef.current && e.touches.length > 0) {
          e.preventDefault();
          const t = e.touches[0];
          moveAdjustCrop(t.clientX, t.clientY);
          return;
        }
        if (boxDrag && e.touches.length > 0) {
          e.preventDefault();
          const t = e.touches[0];
          setBoxDrag((prev) =>
            prev ? { ...prev, currentX: t.clientX, currentY: t.clientY } : null
          );
        }
      }}
      onTouchEnd={() => {
        if (cropAdjustRef.current) {
          endAdjustCrop();
          return;
        }
        if (finishBoxDrag(true)) return;
        window.setTimeout(readPdfSelectionDraft, 120);
      }}
      onMouseMove={(e) => {
        if (cropAdjustRef.current) {
          moveAdjustCrop(e.clientX, e.clientY);
          return;
        }
        if (boxDrag) {
          setBoxDrag((prev) =>
            prev ? { ...prev, currentX: e.clientX, currentY: e.clientY } : null
          );
        }
      }}
    >
      <div className="pdf-pages-container">
        {isDraggingWireToBook && (
          <div className="pdf-drop-hint-banner">
            松开鼠标即可将卡片连接到当前指向的 PDF 句子或位置
          </div>
        )}
        {cropMode && !isDraggingWireToBook && (
          <div className="pdf-drop-hint-banner">
            {selectionMode === 'dock'
              ? pendingCrop
                ? '拖动四角或选框微调范围，点下方确认裁图建卡'
                : '单指在页面上拖拽框选图表区域，松开后可微调'
              : '拖拽框选 PDF 图表区域直接生成右侧带图卡片（也可随时按住 ⌥ 拖拽，按 Esc 退出）'}
          </div>
        )}
        {errorMsg && <div className="book-error-banner">PDF 加载失败：{errorMsg}</div>}
        {pdfDoc &&
          pageNumbers.map((pageNo) => (
            <PdfPageView
              key={pageNo}
              pdfDoc={pdfDoc}
              pageNumber={pageNo}
              scale={scale}
              availableWidth={availableWidth}
              defaultAspectRatio={defaultAspectRatio}
              cropMode={cropMode}
              pendingCropRect={
                pendingCrop && pendingCrop.pageNumber === pageNo
                  ? pendingCrop.rect
                  : null
              }
              onStartAdjustCrop={startAdjustCrop}
              scrollContainerRef={scrollContainerRef}
              anchors={anchorsByPage.get(pageNo) ?? EMPTY_ANCHORS}
              activeAnchorId={activeAnchorId}
              onClickAnchor={onClickAnchor}
              onPreviewImage={onPreviewImage}
              onPageRendered={onPageRendered}
              onStartBoxSelect={(pageEl, clientX, clientY) => {
                setPendingCrop(null);
                setBoxDrag({
                  pageNumber: pageNo,
                  pageEl,
                  startX: clientX,
                  startY: clientY,
                  currentX: clientX,
                  currentY: clientY,
                });
              }}
            />
          ))}
      </div>

      {boxDrag && (
        <div
          style={{
            position: 'fixed',
            left: Math.min(boxDrag.startX, boxDrag.currentX),
            top: Math.min(boxDrag.startY, boxDrag.currentY),
            width: Math.abs(boxDrag.currentX - boxDrag.startX),
            height: Math.abs(boxDrag.currentY - boxDrag.startY),
            border: '1.5px dashed #2563eb',
            background: 'rgba(37, 99, 235, 0.12)',
            pointerEvents: 'none',
            zIndex: 45,
          }}
        />
      )}

      {cropMode && selectionMode === 'dock' && (
        <div
          className="mobile-crop-bar"
          onTouchStart={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="mobile-crop-bar__btn"
            onClick={() => {
              setPendingCrop(null);
              setBoxDrag(null);
              onExitCropMode?.();
            }}
          >
            <X size={15} />
            <span>退出框选</span>
          </button>

          {pendingCrop && (
            <>
              <button
                type="button"
                className="mobile-crop-bar__btn"
                onClick={() => setPendingCrop(null)}
              >
                <RotateCcw size={14} />
                <span>重选</span>
              </button>
              <button
                type="button"
                className="mobile-crop-bar__btn mobile-crop-bar__btn--primary"
                onClick={() =>
                  commitCropRect(
                    pendingCrop.pageNumber,
                    pendingCrop.pageEl,
                    pendingCrop.rect
                  )
                }
              >
                <Check size={15} />
                <span>确认建卡</span>
              </button>
            </>
          )}
        </div>
      )}

      {selectionDraft &&
        (selectionMode === 'dock' ? (
          <MobileSelectionDock
            quote={selectionDraft.quote}
            recentCards={recentCards}
            onAnnotate={(options) => {
              onCreatePdfAnnotation({
                ...selectionDraft,
                style: options.style,
                color: options.color,
                withCard: options.withCard,
                linkToExistingNodeId: options.linkToExistingNodeId,
              });
              window.getSelection()?.removeAllRanges();
              setSelectionDraft(null);
            }}
            onDismiss={() => {
              window.getSelection()?.removeAllRanges();
              setSelectionDraft(null);
            }}
          />
        ) : (
          <SelectionPopover
            x={selectionDraft.popupX}
            y={selectionDraft.popupY}
            quote={selectionDraft.quote}
            selectedCardId={selectedCardId}
            onAnnotate={(options) => {
              onCreatePdfAnnotation({
                ...selectionDraft,
                style: options.style,
                color: options.color,
                withCard: options.withCard,
                linkToExistingNodeId: options.linkToExistingNodeId,
              });
              window.getSelection()?.removeAllRanges();
              setSelectionDraft(null);
            }}
            onDismiss={() => {
              window.getSelection()?.removeAllRanges();
              setSelectionDraft(null);
            }}
          />
        ))}
    </div>
  );
});

const EMPTY_ANCHORS: BookAnchor[] = [];

interface PdfPageViewProps {
  pdfDoc: pdfjsLib.PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  availableWidth: number;
  defaultAspectRatio: number;
  cropMode: boolean;
  pendingCropRect: NormalizedPdfRect | null;
  onStartAdjustCrop: (handle: CropHandle, clientX: number, clientY: number) => void;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  anchors: BookAnchor[];
  activeAnchorId: string | null;
  onClickAnchor: (anchor: BookAnchor, point?: { x: number; y: number }) => void;
  onPreviewImage: (blob: Blob, alt: string) => void;
  onPageRendered: () => void;
  onStartBoxSelect: (pageEl: HTMLElement, clientX: number, clientY: number) => void;
}

const PdfPageView: React.FC<PdfPageViewProps> = memo(function PdfPageView({
  pdfDoc,
  pageNumber,
  scale,
  availableWidth,
  defaultAspectRatio,
  cropMode,
  pendingCropRect,
  onStartAdjustCrop,
  scrollContainerRef,
  anchors,
  activeAnchorId,
  onClickAnchor,
  onPreviewImage,
  onPageRendered,
  onStartBoxSelect,
}) {
  const pageCardRef = useRef<HTMLDivElement | null>(null);
  const pageRef = useRef<pdfjsLib.PDFPageProxy | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);
  const onPageRenderedRef = useRef(onPageRendered);
  onPageRenderedRef.current = onPageRendered;

  const renderScale = useDebouncedValue(scale, 150);
  const renderWidth = useDebouncedValue(availableWidth, 150);

  const [isVisible, setIsVisible] = useState(pageNumber === 1);
  const [renderedDims, setRenderedDims] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const placeholderWidth = renderWidth * renderScale;
  const dims = renderedDims ?? {
    width: placeholderWidth,
    height: placeholderWidth * defaultAspectRatio,
  };

  // Keep every placeholder in sync with the current zoom, not just the pages
  // that have already been rendered once.
  useEffect(() => {
    setRenderedDims(null);
  }, [renderScale, renderWidth, defaultAspectRatio]);

  // Virtualize pages: only render canvas & TextLayer when near the scroll viewport
  useEffect(() => {
    const el = pageCardRef.current;
    const rootEl = scrollContainerRef.current;
    if (!el || !rootEl) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          setIsVisible(entry.isIntersecting);
        }
      },
      {
        root: rootEl,
        rootMargin: '300px 0px',
      }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [scrollContainerRef]);

  useEffect(() => {
    if (!isVisible) {
      // Release the canvas backing store, text layer nodes and pdf.js page
      // resources when the page leaves the scroll buffer.
      if (canvasRef.current) {
        canvasRef.current.width = 0;
        canvasRef.current.height = 0;
      }
      if (textLayerRef.current) {
        textLayerRef.current.replaceChildren();
      }
      try {
        pageRef.current?.cleanup();
      } catch {
        // The page may already have been cleaned up.
      }
      pageRef.current = null;
      return;
    }

    let cancelled = false;
    let renderTask: pdfjsLib.RenderTask | null = null;

    pdfDoc.getPage(pageNumber).then(async (page) => {
      if (cancelled) return;
      pageRef.current = page;

      const baseViewport = page.getViewport({ scale: 1 });
      const fitScale = (renderWidth / baseViewport.width) * renderScale;
      const viewport = page.getViewport({ scale: fitScale });
      setRenderedDims({ width: viewport.width, height: viewport.height });

      const canvas = canvasRef.current;
      if (canvas) {
        // Cap the backing store at ~4M pixels. Retina A4 pages stay near 1.9x;
        // very large pages trade a little sharpness for a bounded memory cost.
        const pixelBudgetDpr = Math.sqrt(
          MAX_CANVAS_PIXELS / Math.max(1, viewport.width * viewport.height)
        );
        const dpr = Math.max(
          0.5,
          Math.min(window.devicePixelRatio || 1, 2, pixelBudgetDpr)
        );
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          renderTask = page.render({ canvasContext: ctx, viewport, canvas });
          try {
            await renderTask.promise;
          } catch {
            // Cancelled render task when scrolling quickly
            return;
          }
        }
      }

      if (cancelled) return;
      const textContent = await page.getTextContent();
      if (cancelled || !textLayerRef.current) return;

      const container = textLayerRef.current;
      const fragment = document.createDocumentFragment();

      textContent.items.forEach((item) => {
        if (!('str' in item) || !item.str.trim()) return;
        const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
        const fontHeight = Math.max(8, Math.hypot(tx[2], tx[3]));
        const itemWidth = Math.max(fontHeight * 0.6, (item.width || 0) * viewport.scale);

        const span = document.createElement('span');
        span.textContent = item.str;
        span.dataset.pdfTextItem = 'true';
        span.style.position = 'absolute';
        span.style.left = `${tx[4]}px`;
        span.style.top = `${tx[5] - fontHeight * 0.88}px`;
        span.style.width = `${itemWidth}px`;
        span.style.height = `${fontHeight * 1.15}px`;
        span.style.fontSize = `${fontHeight}px`;
        span.style.lineHeight = '1.15';
        span.style.fontFamily = 'sans-serif';
        span.style.color = 'transparent';
        span.style.whiteSpace = 'pre';
        span.style.cursor = 'text';
        span.style.display = 'inline-block';
        fragment.appendChild(span);
      });

      container.replaceChildren(fragment);
      onPageRenderedRef.current();
    }).catch(() => {
      // The page can be cleaned up or the document destroyed while loading.
    });

    return () => {
      cancelled = true;
      if (renderTask) {
        renderTask.cancel();
      }
    };
  }, [isVisible, pdfDoc, pageNumber, renderScale, renderWidth]);

  useEffect(() => {
    return () => {
      try {
        pageRef.current?.cleanup();
      } catch {
        // The page may already have been cleaned up.
      }
      pageRef.current = null;
    };
  }, []);

  return (
    <div
      ref={pageCardRef}
      className="pdf-page-card"
      data-pdf-page={pageNumber}
      onMouseDown={(e) => {
        if ((cropMode || e.altKey) && pageCardRef.current) {
          e.preventDefault();
          onStartBoxSelect(pageCardRef.current, e.clientX, e.clientY);
        }
      }}
      onTouchStart={(e) => {
        if (cropMode && !pendingCropRect && e.touches.length === 1 && pageCardRef.current) {
          const t = e.touches[0];
          onStartBoxSelect(pageCardRef.current, t.clientX, t.clientY);
        }
      }}
      style={{
        position: 'relative',
        width: `${dims.width}px`,
        height: `${dims.height}px`,
        margin: '16px auto',
        boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
        background: '#fff',
        touchAction: cropMode ? 'none' : undefined,
      }}
    >
      {isVisible ? (
        <>
          <canvas ref={canvasRef} style={{ display: 'block' }} />
          <div
            ref={textLayerRef}
            className="pdf-text-layer"
            style={{
              position: 'absolute',
              inset: 0,
              userSelect: cropMode ? 'none' : 'text',
              pointerEvents: cropMode ? 'none' : undefined,
            }}
          />
        </>
      ) : (
        <div className="pdf-page-placeholder">第 {pageNumber} 页</div>
      )}

      {pendingCropRect && (
        <div
          className="pdf-crop-selection"
          style={{
            left: `${pendingCropRect.x * 100}%`,
            top: `${pendingCropRect.y * 100}%`,
            width: `${pendingCropRect.w * 100}%`,
            height: `${pendingCropRect.h * 100}%`,
          }}
          onMouseDown={(e) => {
            e.stopPropagation();
            onStartAdjustCrop('move', e.clientX, e.clientY);
          }}
          onTouchStart={(e) => {
            if (e.touches.length !== 1) return;
            e.stopPropagation();
            const t = e.touches[0];
            onStartAdjustCrop('move', t.clientX, t.clientY);
          }}
        >
          {(['nw', 'ne', 'sw', 'se'] as const).map((corner) => (
            <span
              key={corner}
              className={`pdf-crop-handle pdf-crop-handle--${corner}`}
              onMouseDown={(e) => {
                e.stopPropagation();
                onStartAdjustCrop(corner, e.clientX, e.clientY);
              }}
              onTouchStart={(e) => {
                if (e.touches.length !== 1) return;
                e.stopPropagation();
                const t = e.touches[0];
                onStartAdjustCrop(corner, t.clientX, t.clientY);
              }}
            />
          ))}
        </div>
      )}

      {anchors.map((anchor) => {
        const rects = anchor.pdfRects || [];
        const isActive = activeAnchorId === anchor.id;
        return rects.map((r, idx) => {
          const isFirstRect = idx === 0;
          const isPin = anchor.style === 'pin';
          return (
            <div
              key={`${anchor.id}-${idx}`}
              data-anchor-id={isFirstRect ? anchor.id : undefined}
              data-anchor-group={anchor.id}
              onClick={(e) =>
                onClickAnchor(anchor, { x: e.clientX, y: e.clientY })
              }
              title={
                anchor.quote
                  ? anchor.targetNodeId
                    ? '点击聚焦右侧关联批注卡片'
                    : '点击管理该标注'
                  : '点击聚焦右侧关联批注卡片'
              }
              style={{
                position: 'absolute',
                left: `${r.x * 100}%`,
                top: `${r.y * 100}%`,
                width: `${r.w * 100}%`,
                height: `${r.h * 100}%`,
                background: isPin
                  ? 'rgba(37, 99, 235, 0.18)'
                  : (() => {
                      const c = anchor.color ?? (anchor.style === 'highlight' ? 'amber' : 'green');
                      const bgMap = {
                        amber: isActive ? 'rgba(235, 198, 92, 0.58)' : 'rgba(235, 198, 92, 0.35)',
                        green: isActive ? 'rgba(22, 163, 74, 0.36)' : 'rgba(22, 163, 74, 0.2)',
                        rose: isActive ? 'rgba(225, 29, 72, 0.34)' : 'rgba(225, 29, 72, 0.18)',
                        blue: isActive ? 'rgba(37, 99, 235, 0.34)' : 'rgba(37, 99, 235, 0.18)',
                      };
                      if (anchor.style === 'highlight') return bgMap[c];
                      return isActive ? bgMap[c] : 'transparent';
                    })(),
                border: isPin ? '1.5px solid #2563eb' : undefined,
                borderRadius: isPin ? '4px' : '2px',
                borderBottom: isPin
                  ? undefined
                  : (() => {
                      const c = anchor.color ?? (anchor.style === 'highlight' ? 'amber' : 'green');
                      const lineMap = {
                        amber: '#d49b1a',
                        green: '#1a8f5c',
                        rose: '#e11d48',
                        blue: '#2563eb',
                      };
                      return anchor.style === 'highlight'
                        ? `2px solid ${lineMap[c]}`
                        : `1.5px dashed ${lineMap[c]}`;
                    })(),
                cursor: 'pointer',
                pointerEvents: 'auto',
              }}
            />
          );
        });
      })}
    </div>
  );
});

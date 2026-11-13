import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Highlighter, Link2, Underline, ZoomIn } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import * as pdfjsLib from 'pdfjs-dist';
import type { AnnotationStyle, BookAnchor, NormalizedPdfRect, TocEntry } from '../types';

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
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  onPageRendered: () => void;
  onCreatePdfAnnotation: (draft: {
    pageNumber: number;
    quote: string;
    rects: NormalizedPdfRect[];
    style: AnnotationStyle;
    anchorScreenY: number;
    linkToExistingNodeId?: string;
  }) => void;
  onClickAnchor: (anchor: BookAnchor) => void;
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
  scrollContainerRef,
  onScroll,
  onPageRendered,
  onCreatePdfAnnotation,
  onClickAnchor,
  onPreviewImage,
  onOutline,
}) {
  const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [pageNumbers, setPageNumbers] = useState<number[]>([]);
  const [defaultAspectRatio, setDefaultAspectRatio] = useState<number>(1.414);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [selectionDraft, setSelectionDraft] = useState<PdfSelectionDraft | null>(null);

  const [boxDrag, setBoxDrag] = useState<{
    pageNumber: number;
    pageEl: HTMLElement;
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
  } | null>(null);

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
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.selection-popover')) {
        setSelectionDraft(null);
      }
    };
    window.addEventListener('mousedown', handleMouseDown);
    return () => window.removeEventListener('mousedown', handleMouseDown);
  }, []);

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

  const handleMouseUp = useCallback(() => {
    if (boxDrag) {
      const { pageNumber, pageEl, startX, startY, currentX, currentY } = boxDrag;
      setBoxDrag(null);
      const pageRect = pageEl.getBoundingClientRect();
      const left = Math.min(startX, currentX);
      const top = Math.min(startY, currentY);
      const width = Math.abs(currentX - startX);
      const height = Math.abs(currentY - startY);

      if (width > 14 && height > 10) {
        const normRect: NormalizedPdfRect = {
          x: (left - pageRect.left) / pageRect.width,
          y: (top - pageRect.top) / pageRect.height,
          w: width / pageRect.width,
          h: height / pageRect.height,
        };
        setSelectionDraft({
          pageNumber,
          quote: `PDF 第 ${pageNumber} 页选区批注`,
          rects: [normRect],
          popupX: left + width / 2,
          popupY: Math.max(56, top - 10),
          anchorScreenY: top + height / 2,
        });
        return;
      }
    }

    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const quote = sel.toString().trim();
    if (!quote) return;

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
    if (!pageEl) return;

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
  }, [boxDrag]);

  const availableWidth = Math.max(280, containerWidth - 40);

  return (
    <div
      className={`book-pane ${isDraggingWireToBook ? 'book-pane--drop-target' : ''}`}
      onMouseUp={handleMouseUp}
      onMouseMove={(e) => {
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
              scrollContainerRef={scrollContainerRef}
              anchors={anchorsByPage.get(pageNo) ?? EMPTY_ANCHORS}
              activeAnchorId={activeAnchorId}
              onClickAnchor={onClickAnchor}
              onPreviewImage={onPreviewImage}
              onPageRendered={onPageRendered}
              onStartBoxSelect={(pageEl, clientX, clientY) => {
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

      {selectionDraft && (
        <div
          className="selection-popover"
          style={{ left: `${selectionDraft.popupX}px`, top: `${selectionDraft.popupY}px` }}
        >
          <button
            type="button"
            className="selection-popover__btn selection-popover__btn--review"
            onClick={() => {
              onCreatePdfAnnotation({ ...selectionDraft, style: 'highlight' });
              window.getSelection()?.removeAllRanges();
              setSelectionDraft(null);
            }}
          >
            <Highlighter size={14} />
            <span>高亮新建</span>
          </button>
          <div className="selection-popover__sep" />
          <button
            type="button"
            className="selection-popover__btn selection-popover__btn--revision"
            onClick={() => {
              onCreatePdfAnnotation({ ...selectionDraft, style: 'underline' });
              window.getSelection()?.removeAllRanges();
              setSelectionDraft(null);
            }}
          >
            <Underline size={14} />
            <span>划线新建</span>
          </button>
          {selectedCardId && (
            <>
              <div className="selection-popover__sep" />
              <button
                type="button"
                className="selection-popover__btn selection-popover__btn--link"
                onClick={() => {
                  onCreatePdfAnnotation({
                    ...selectionDraft,
                    style: 'highlight',
                    linkToExistingNodeId: selectedCardId,
                  });
                  window.getSelection()?.removeAllRanges();
                  setSelectionDraft(null);
                }}
              >
                <Link2 size={14} />
                <span>连到选中卡片</span>
              </button>
            </>
          )}
        </div>
      )}
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
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  anchors: BookAnchor[];
  activeAnchorId: string | null;
  onClickAnchor: (anchor: BookAnchor) => void;
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
        if (e.altKey && pageCardRef.current) {
          e.preventDefault();
          onStartBoxSelect(pageCardRef.current, e.clientX, e.clientY);
        }
      }}
      style={{
        position: 'relative',
        width: `${dims.width}px`,
        height: `${dims.height}px`,
        margin: '16px auto',
        boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
        background: '#fff',
      }}
    >
      {isVisible ? (
        <>
          <canvas ref={canvasRef} style={{ display: 'block' }} />
          <div
            ref={textLayerRef}
            className="pdf-text-layer"
            style={{ position: 'absolute', inset: 0, userSelect: 'text' }}
          />
        </>
      ) : (
        <div className="pdf-page-placeholder">第 {pageNumber} 页</div>
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
              onClick={() => onClickAnchor(anchor)}
              title={anchor.quote || '点击聚焦右侧关联批注卡片'}
              style={{
                position: 'absolute',
                left: `${r.x * 100}%`,
                top: `${r.y * 100}%`,
                width: `${r.w * 100}%`,
                height: `${r.h * 100}%`,
                background: isPin
                  ? 'rgba(37, 99, 235, 0.18)'
                  : anchor.style === 'highlight'
                    ? isActive
                      ? 'rgba(235, 198, 92, 0.55)'
                      : 'rgba(235, 198, 92, 0.35)'
                    : isActive
                      ? 'rgba(26, 143, 92, 0.12)'
                      : 'transparent',
                border: isPin ? '1.5px solid #2563eb' : undefined,
                borderRadius: isPin ? '4px' : '2px',
                borderBottom: isPin
                  ? undefined
                  : anchor.style === 'highlight'
                    ? '2px solid #d49b1a'
                    : '1.5px dashed #1a8f5c',
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

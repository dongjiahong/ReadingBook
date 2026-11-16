import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Highlighter, Link2, Underline } from 'lucide-react';
import type { AnnotationStyle, BookAnchor, BookParagraph } from '../types';
import type { EpubImageLoader } from '../utils/epubLoader';

interface SelectionDraft {
  paragraphId: string;
  quote: string;
  startOffset: number;
  endOffset: number;
  popupX: number;
  popupY: number;
  anchorScreenY: number;
}

interface BookPaneProps {
  paragraphs: BookParagraph[];
  anchors: BookAnchor[];
  activeAnchorId: string | null;
  selectedCardId: string | null;
  isDraggingWireToBook: boolean;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  epubImageLoader?: EpubImageLoader | null;
  onPreviewImage?: (blob: Blob, alt: string) => void;
  onScroll: () => void;
  onCreateAnnotation: (draft: {
    paragraphId: string;
    quote: string;
    startOffset: number;
    endOffset: number;
    style: AnnotationStyle;
    anchorScreenY: number;
    /** false 时只做基础标注，不创建卡片。 */
    withCard?: boolean;
    linkToExistingNodeId?: string;
  }) => void;
  onClickAnchor: (anchor: BookAnchor, point?: { x: number; y: number }) => void;
}

export const BookPane: React.FC<BookPaneProps> = ({
  paragraphs,
  anchors,
  activeAnchorId,
  selectedCardId,
  isDraggingWireToBook,
  scrollContainerRef,
  epubImageLoader,
  onPreviewImage,
  onScroll,
  onCreateAnnotation,
  onClickAnchor,
}) => {
  const [selectionDraft, setSelectionDraft] = useState<SelectionDraft | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

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

  const handleMouseUp = useCallback(() => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      return;
    }

    const range = selection.getRangeAt(0);
    const selectedText = selection.toString().trim();
    if (!selectedText) return;

    let node: Node | null = range.startContainer;
    let paragraphEl: HTMLElement | null = null;
    while (node) {
      if (node instanceof HTMLElement && node.dataset.paragraphId) {
        paragraphEl = node;
        break;
      }
      node = node.parentNode;
    }

    let endNode: Node | null = range.endContainer;
    let endParagraphEl: HTMLElement | null = null;
    while (endNode) {
      if (endNode instanceof HTMLElement && endNode.dataset.paragraphId) {
        endParagraphEl = endNode;
        break;
      }
      endNode = endNode.parentNode;
    }

    if (!paragraphEl || paragraphEl !== endParagraphEl) {
      return;
    }

    const paragraphId = paragraphEl.dataset.paragraphId!;

    const preRange = document.createRange();
    preRange.selectNodeContents(paragraphEl);
    preRange.setEnd(range.startContainer, range.startOffset);
    const rawStart = preRange.toString().length;

    const fullSelected = range.toString();
    const leadingSpaces = fullSelected.length - fullSelected.trimStart().length;
    const startOffset = rawStart + leadingSpaces;
    const endOffset = startOffset + selectedText.length;

    const rects = range.getClientRects();
    const firstRect = rects[0] ?? range.getBoundingClientRect();
    const lastRect = rects[rects.length - 1] ?? firstRect;

    setSelectionDraft({
      paragraphId,
      quote: selectedText,
      startOffset,
      endOffset,
      popupX: firstRect.left + firstRect.width / 2,
      popupY: Math.max(56, firstRect.top - 10),
      anchorScreenY: lastRect.top + lastRect.height / 2,
    });
  }, []);

  const handleChooseStyle = (
    style: AnnotationStyle,
    linkToExistingNodeId?: string,
    withCard = true
  ) => {
    if (!selectionDraft) return;
    onCreateAnnotation({
      paragraphId: selectionDraft.paragraphId,
      quote: selectionDraft.quote,
      startOffset: selectionDraft.startOffset,
      endOffset: selectionDraft.endOffset,
      style,
      anchorScreenY: selectionDraft.anchorScreenY,
      withCard,
      linkToExistingNodeId,
    });
    window.getSelection()?.removeAllRanges();
    setSelectionDraft(null);
  };

  // Splits a text range into styled fragments using the paragraph's inline runs.
  const renderFormattedSlice = (
    paragraph: BookParagraph,
    from: number,
    to: number,
    keyPrefix: string
  ): React.ReactNode[] => {
    const text = paragraph.text ?? '';
    const runs = paragraph.runs?.length ? paragraph.runs : [{ text }];
    const nodes: React.ReactNode[] = [];
    let offset = 0;

    for (let i = 0; i < runs.length; i += 1) {
      const run = runs[i];
      const start = Math.max(from, offset);
      const end = Math.min(to, offset + run.text.length);
      offset += run.text.length;
      if (end <= start) continue;

      let node: React.ReactNode = text.slice(start, end);
      if (run.sup) node = <sup>{node}</sup>;
      else if (run.sub) node = <sub>{node}</sub>;
      if (run.bold) node = <strong>{node}</strong>;
      if (run.italic) node = <em>{node}</em>;
      nodes.push(<React.Fragment key={`${keyPrefix}-${i}`}>{node}</React.Fragment>);
    }

    return nodes;
  };

  const renderTextWithAnchors = (paragraph: BookParagraph) => {
    const text = paragraph.text ?? '';
    const paraAnchors = anchors
      .filter((a) => a.paragraphId === paragraph.id)
      .sort((a, b) => a.startOffset - b.startOffset);

    if (paraAnchors.length === 0) {
      return renderFormattedSlice(paragraph, 0, text.length, 'fmt');
    }

    const segments: React.ReactNode[] = [];
    let cursor = 0;

    for (const anchor of paraAnchors) {
      const start = Math.max(cursor, Math.min(anchor.startOffset, text.length));
      const end = Math.max(start, Math.min(anchor.endOffset, text.length));

      if (start > cursor) {
        segments.push(
          <React.Fragment key={`plain-${cursor}`}>
            {renderFormattedSlice(paragraph, cursor, start, `p-${cursor}`)}
          </React.Fragment>
        );
      }

      if (end > start) {
        const isActive = activeAnchorId === anchor.id;
        segments.push(
          <span
            key={anchor.id}
            data-anchor-id={anchor.id}
            className={[
              'book-anchor',
              anchor.style === 'highlight' ? 'book-anchor--highlight' : 'book-anchor--underline',
              isActive ? 'book-anchor--active' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            onClick={(e) => {
              e.stopPropagation();
              onClickAnchor(anchor, { x: e.clientX, y: e.clientY });
            }}
            title={
              anchor.targetNodeId
                ? '点击聚焦右侧关联批注卡片'
                : '点击管理该标注'
            }
          >
            {renderFormattedSlice(paragraph, start, end, `a-${anchor.id}`)}
          </span>
        );
      }

      cursor = end;
    }

    if (cursor < text.length) {
      segments.push(
        <React.Fragment key={`plain-end-${cursor}`}>
          {renderFormattedSlice(paragraph, cursor, text.length, `e-${cursor}`)}
        </React.Fragment>
      );
    }

    return segments;
  };

  return (
    <div
      className={`book-pane ${isDraggingWireToBook ? 'book-pane--drop-target' : ''}`}
      onMouseUp={handleMouseUp}
    >
      {isDraggingWireToBook && (
        <div className="pdf-drop-hint-banner">
          松开鼠标即可将卡片连接到当前指向的书籍段落
        </div>
      )}
      <div ref={contentRef} className="book-page">
        {paragraphs.map((p) => {
          if (p.type === 'image') {
            return (
              <EpubImage
                key={p.id}
                paragraph={p}
                loader={epubImageLoader ?? null}
                scrollContainerRef={scrollContainerRef}
                onPreviewImage={onPreviewImage}
              />
            );
          }

          if (p.type === 'heading') {
            return (
              <div key={p.id} className="book-heading-wrap">
                <h2 className="book-heading" data-paragraph-id={p.id}>
                  {renderTextWithAnchors(p)}
                </h2>
                <div className="book-divider" />
              </div>
            );
          }

          if (p.type === 'stage') {
            return (
              <p key={p.id} className="book-stage" data-paragraph-id={p.id}>
                <em>A room in the castle.</em> Enter <strong>Hamlet.</strong>
              </p>
            );
          }

          if (p.type === 'quote' && p.lines) {
            return (
              <blockquote key={p.id} className="book-quote-box">
                {p.lines.map((line) => (
                  <div
                    key={line.id}
                    className="book-quote-line"
                    data-paragraph-id={line.id}
                  >
                    {renderTextWithAnchors({
                      id: line.id,
                      type: 'prose',
                      text: line.text,
                    })}
                  </div>
                ))}
              </blockquote>
            );
          }

          if (p.type === 'prose') {
            return (
              <p key={p.id} className="book-prose" data-paragraph-id={p.id}>
                {renderTextWithAnchors(p)}
              </p>
            );
          }

          if (p.type === 'table' && p.rows) {
            return (
              <div key={p.id} className="book-table-wrap">
                <table className="book-table">
                  <thead>
                    <tr>
                      <th>Line</th>
                      <th>Image</th>
                      <th>Reading</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.rows.map((row) => (
                      <tr key={row.line}>
                        <td>{row.line}</td>
                        <td>{row.image}</td>
                        <td>{row.reading}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          }

          return null;
        })}
      </div>

      {selectionDraft && (
        <div
          className="selection-popover"
          style={{
            left: `${selectionDraft.popupX}px`,
            top: `${selectionDraft.popupY}px`,
          }}
        >
          <button
            type="button"
            className="selection-popover__btn selection-popover__btn--review"
            title="只在书页上高亮，不创建卡片"
            onClick={() => handleChooseStyle('highlight', undefined, false)}
          >
            <Highlighter size={14} />
            <span>仅高亮</span>
          </button>
          <button
            type="button"
            className="selection-popover__btn selection-popover__btn--revision"
            title="只在书页上划线，不创建卡片"
            onClick={() => handleChooseStyle('underline', undefined, false)}
          >
            <Underline size={14} />
            <span>仅划线</span>
          </button>
          <div className="selection-popover__sep" />
          <button
            type="button"
            className="selection-popover__btn selection-popover__btn--review"
            title="高亮并创建批注卡片"
            onClick={() => handleChooseStyle('highlight', undefined, true)}
          >
            <Highlighter size={14} />
            <span>高亮+卡</span>
          </button>
          <button
            type="button"
            className="selection-popover__btn selection-popover__btn--revision"
            title="划线并创建批注卡片"
            onClick={() => handleChooseStyle('underline', undefined, true)}
          >
            <Underline size={14} />
            <span>划线+卡</span>
          </button>
          {selectedCardId && (
            <>
              <div className="selection-popover__sep" />
              <button
                type="button"
                className="selection-popover__btn selection-popover__btn--link"
                onClick={() => handleChooseStyle('highlight', selectedCardId)}
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
};

interface EpubImageProps {
  paragraph: BookParagraph;
  loader: EpubImageLoader | null;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  onPreviewImage?: (blob: Blob, alt: string) => void;
}

const EpubImage: React.FC<EpubImageProps> = ({
  paragraph,
  loader,
  scrollContainerRef,
  onPreviewImage,
}) => {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const blobRef = useRef<Blob | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  // 只在首次进入视口时触发一次加载；滚出视口后保留已加载的图片，
  // 避免它被卸载又重载，导致书页高度反复变化（闪烁 + 卡片错位）。
  const [shouldLoad, setShouldLoad] = useState(false);
  const [src, setSrc] = useState<string | null>(paragraph.imageSrc ?? null);
  const [failed, setFailed] = useState(false);

  // 卸载时释放唯一的 object URL
  useEffect(() => {
    return () => {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (paragraph.imageSrc) {
      blobRef.current = null;
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
      setSrc(paragraph.imageSrc);
      setFailed(false);
      setShouldLoad(false);
      return;
    }

    if (shouldLoad) return;

    const el = wrapperRef.current;
    const root = scrollContainerRef.current;
    if (!el || !root) {
      setShouldLoad(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setShouldLoad(true);
          observer.disconnect();
        }
      },
      {
        root,
        rootMargin: '500px 0px',
      }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [paragraph.imageSrc, scrollContainerRef, shouldLoad]);

  useEffect(() => {
    if (!shouldLoad || paragraph.imageSrc || !paragraph.imagePath) return;
    if (!loader) {
      setFailed(true);
      return;
    }

    let cancelled = false;
    setFailed(false);

    loader
      .readImage(paragraph.imagePath)
      .then((blob) => {
        if (cancelled) return;
        if (!blob) {
          setFailed(true);
          return;
        }
        blobRef.current = blob;
        if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
        const url = URL.createObjectURL(blob);
        objectUrlRef.current = url;
        setSrc(url);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [shouldLoad, loader, paragraph.imagePath, paragraph.imageSrc]);

  const aspectRatio =
    paragraph.imageWidth && paragraph.imageHeight
      ? `${paragraph.imageWidth} / ${paragraph.imageHeight}`
      : undefined;
  const isInlineImage =
    paragraph.imageWidth !== undefined && paragraph.imageWidth <= 64;
  const inlineSize = isInlineImage ? paragraph.imageWidth : undefined;

  return (
    <div
      ref={wrapperRef}
      className={`book-epub-image ${
        isInlineImage ? 'book-epub-image--inline' : ''
      } ${!isInlineImage && aspectRatio ? 'book-epub-image--sized' : ''}`}
      data-paragraph-id={paragraph.id}
      style={
        !isInlineImage && aspectRatio ? { aspectRatio } : undefined
      }
    >
      {src ? (
        <img
          className="book-epub-image__img"
          src={src}
          alt={paragraph.imageAlt || ''}
          loading="eager"
          decoding="async"
          title={onPreviewImage ? '点击放大查看' : undefined}
          style={
            inlineSize
              ? { width: `${inlineSize}px`, height: 'auto' }
              : undefined
          }
          onClick={(e) => {
            e.stopPropagation();
            if (!onPreviewImage) return;
            if (blobRef.current) {
              onPreviewImage(blobRef.current, paragraph.imageAlt || '');
              return;
            }
            if (paragraph.imageSrc) {
              fetch(paragraph.imageSrc)
                .then((res) => res.blob())
                .then((blob) => onPreviewImage(blob, paragraph.imageAlt || ''))
                .catch(() => {});
            }
          }}
          onError={() => {
            setSrc(null);
            setFailed(true);
          }}
        />
      ) : (
        <div
          className={`book-epub-image__placeholder ${
            failed ? 'book-epub-image__placeholder--error' : ''
          }`}
          style={
            isInlineImage
              ? { width: `${inlineSize}px`, height: `${inlineSize}px`, minHeight: 0 }
              : aspectRatio
                ? { aspectRatio }
                : undefined
          }
        >
          {isInlineImage ? '' : failed ? '图片无法显示' : '图片加载中…'}
        </div>
      )}
    </div>
  );
};

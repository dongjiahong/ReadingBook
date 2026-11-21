import React, { useEffect, useRef } from 'react';
import type { BookAnchor, DraggingWireState } from '../types';

export type MidLineRoutingMode = 'interline' | 'margin-align';

interface BookToCanvasBridgeProps {
  anchors: BookAnchor[];
  activeAnchorId: string | null;
  draggingWire: DraggingWireState | null;
  midLineMode?: MidLineRoutingMode;
  workspaceOuterRef: React.RefObject<HTMLDivElement | null>;
  bookStickyRef: React.RefObject<HTMLDivElement | null>;
  bridgeTriggerRef: React.MutableRefObject<() => void>;
}

/**
 * Given all line rects of an annotation (1 or multiple lines),
 * pick the best line rect to attach the connector:
 * - If multiple lines exist, filter to the lines that reach near the rightmost edge
 *   (within 24px of the max right among this annotation's lines), and pick the one
 *   closest to the vertical middle of the highlight.
 */
function pickBestAnchorLineRect(rects: DOMRect[]): DOMRect {
  if (rects.length === 1) return rects[0];

  const maxRight = Math.max(...rects.map((r) => r.right));
  const rightmostCandidates = rects.filter((r) => r.right >= maxRight - 24);
  const pool = rightmostCandidates.length > 0 ? rightmostCandidates : rects;

  const overallMidY = (rects[0].top + rects[rects.length - 1].bottom) / 2;
  let best = pool[0];
  let bestDist = Math.abs((best.top + best.bottom) / 2 - overallMidY);

  for (let i = 1; i < pool.length; i++) {
    const r = pool[i];
    const dist = Math.abs((r.top + r.bottom) / 2 - overallMidY);
    if (dist < bestDist) {
      best = r;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * Detect whether there is still text to the right of `chosenRect` on the same line,
 * and return the X coordinate of the end of that text line (`lineEndX`).
 */
function detectSameLineRightEdge(
  anchorEl: HTMLElement,
  chosenRect: DOMRect,
  bookRect: DOMRect
): { isMidLine: boolean; lineEndX: number } {
  const midY = (chosenRect.top + chosenRect.bottom) / 2;
  const pageEl = anchorEl.closest<HTMLElement>('[data-pdf-page]');

  if (pageEl) {
    // PDF mode: inspect text spans on the same horizontal line
    const spans = pageEl.querySelectorAll<HTMLElement>('[data-pdf-text-item="true"]');
    let maxLineRight = chosenRect.right;
    const tolerance = Math.max(6, chosenRect.height * 0.55);

    for (let i = 0; i < spans.length; i++) {
      const sr = spans[i].getBoundingClientRect();
      if (sr.width <= 0 || sr.height <= 0) continue;
      const sMidY = (sr.top + sr.bottom) / 2;
      if (Math.abs(sMidY - midY) <= tolerance && sr.right > maxLineRight) {
        maxLineRight = sr.right;
      }
    }

    const isMidLine = maxLineRight > chosenRect.right + 14;
    return {
      isMidLine,
      lineEndX: Math.min(maxLineRight + 6, bookRect.right - 8),
    };
  }

  // EPUB / HTML mode: check containing paragraph or quote line
  const blockEl = anchorEl.closest<HTMLElement>('[data-paragraph-id]');
  if (blockEl) {
    const blockRect = blockEl.getBoundingClientRect();
    const isMidLine = blockRect.right > chosenRect.right + 28;
    return {
      isMidLine,
      lineEndX: Math.min(blockRect.right + 4, bookRect.right - 8),
    };
  }

  return { isMidLine: false, lineEndX: chosenRect.right + 4 };
}

export const BookToCanvasBridge: React.FC<BookToCanvasBridgeProps> = React.memo(
  ({
    anchors,
    activeAnchorId,
    draggingWire,
    midLineMode = 'interline',
    workspaceOuterRef,
    bookStickyRef,
    bridgeTriggerRef,
  }) => {
    const svgRef = useRef<SVGSVGElement | null>(null);
    const rafIdRef = useRef<number | null>(null);
    const latestPropsRef = useRef({ anchors, activeAnchorId, midLineMode });
    latestPropsRef.current = { anchors, activeAnchorId, midLineMode };

    useEffect(() => {
      const updateSvgDom = () => {
        rafIdRef.current = null;
        const svgEl = svgRef.current;
        const outerEl = workspaceOuterRef.current;
        const bookEl = bookStickyRef.current;
        if (!svgEl || !outerEl || !bookEl) return;

        const outerRect = outerEl.getBoundingClientRect();
        const bookRect = bookEl.getBoundingClientRect();
        const {
          anchors: curAnchors,
          activeAnchorId: curActiveId,
          midLineMode: curMode,
        } = latestPropsRef.current;

        const topLimit = outerRect.top + 14;
        const bottomLimit = outerRect.bottom - 14;
        const minCardX = bookRect.right - outerRect.left - 8;

        for (const anchor of curAnchors) {
          const group = svgEl.querySelector<SVGGElement>(
            `[data-bridge-id="${anchor.id}"]`
          );
          if (!group) continue;

          const pathEl = group.querySelector('path');
          const circleEl = group.querySelector('circle');
          if (!pathEl || !circleEl) continue;

          // Collect all line rects for this anchor (supports both multi-rect PDF and multi-line HTML spans)
          const groupEls = bookEl.querySelectorAll<HTMLElement>(
            `[data-anchor-group="${anchor.id}"]`
          );
          const primaryEl =
            groupEls[0] ??
            bookEl.querySelector<HTMLElement>(`[data-anchor-id="${anchor.id}"]`) ??
            (anchor.style === 'pin'
              ? bookEl.querySelector<HTMLElement>(
                  `[data-paragraph-id="${anchor.paragraphId}"]`
                )
              : null);

          const handleEl = outerEl.querySelector<HTMLElement>(
            `[data-card-handle-id="${anchor.targetNodeId}"]`
          );

          if (!primaryEl || !handleEl) {
            group.style.display = 'none';
            continue;
          }

          const lineRects: DOMRect[] = [];
          if (groupEls.length > 0) {
            groupEls.forEach((el) => {
              const r = el.getBoundingClientRect();
              if (r.width > 0 && r.height > 0) lineRects.push(r);
            });
          } else {
            const rects = primaryEl.getClientRects();
            for (let i = 0; i < rects.length; i++) {
              if (rects[i].width > 0 && rects[i].height > 0) {
                lineRects.push(rects[i]);
              }
            }
          }

          if (lineRects.length === 0) {
            group.style.display = 'none';
            continue;
          }

          const chosenRect = pickBestAnchorLineRect(lineRects);
          const handleRect = handleEl.getBoundingClientRect();
          const x2 = handleRect.left + handleRect.width / 2 - outerRect.left;
          const y2 = handleRect.top + handleRect.height / 2 - outerRect.top;

          if (x2 < minCardX) {
            group.style.display = 'none';
            continue;
          }

          if (
            (chosenRect.bottom < outerRect.top - 100 &&
              handleRect.bottom < outerRect.top - 100) ||
            (chosenRect.top > outerRect.bottom + 100 &&
              handleRect.top > outerRect.bottom + 100)
          ) {
            group.style.display = 'none';
            continue;
          }

          const { isMidLine, lineEndX } = detectSameLineRightEdge(
            primaryEl,
            chosenRect,
            bookRect
          );

          // Determine starting Y and X based on whether the highlight ends mid-line
          const preferBottomY = isMidLine && curMode === 'interline';
          let rawY1 = preferBottomY
            ? chosenRect.bottom + 1.5
            : chosenRect.top + chosenRect.height / 2;

          let clamped = false;
          if (rawY1 < topLimit) {
            rawY1 = topLimit;
            clamped = true;
          } else if (rawY1 > bottomLimit) {
            rawY1 = bottomLimit;
            clamped = true;
          }

          let rawX1: number;
          if (clamped) {
            rawX1 = bookRect.right - 10;
          } else if (isMidLine && curMode === 'margin-align') {
            rawX1 = lineEndX;
          } else {
            rawX1 = Math.min(chosenRect.right + 2, bookRect.right - 6);
          }

          const x1 = rawX1 - outerRect.left;
          const y1 = rawY1 - outerRect.top;

          let d: string;
          if (!clamped && isMidLine && curMode === 'interline') {
            // Route horizontally along the inter-line gap below the text until clearing the line's right edge,
            // then curve smoothly with a cubic Bézier to the card!
            const corridorX = Math.max(x1 + 8, lineEndX - outerRect.left);
            const dx = Math.max(36, Math.abs(x2 - corridorX) * 0.5);
            const cx1 = corridorX + dx;
            const cx2 = x2 - dx;
            d = `M ${x1.toFixed(1)} ${y1.toFixed(1)} L ${corridorX.toFixed(1)} ${y1.toFixed(1)} C ${cx1.toFixed(1)} ${y1.toFixed(1)}, ${cx2.toFixed(1)} ${y2.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}`;
          } else {
            const dx = Math.max(40, Math.abs(x2 - x1) * 0.5);
            const cx1 = x1 + dx;
            const cx2 = x2 - dx;
            d = `M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${cx1.toFixed(1)} ${y1.toFixed(1)}, ${cx2.toFixed(1)} ${y2.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}`;
          }

          const isActive = curActiveId === anchor.id;
          const isDimmed = Boolean(curActiveId) && !isActive;
          group.style.display = '';

          pathEl.setAttribute('d', d);
          pathEl.setAttribute('stroke-width', isActive ? '2.4' : '1.5');
          pathEl.setAttribute(
            'stroke-opacity',
            isDimmed ? '0.2' : clamped ? '0.45' : isActive ? '1' : '0.78'
          );
          if (clamped) {
            pathEl.setAttribute('stroke-dasharray', '4 4');
          } else {
            pathEl.removeAttribute('stroke-dasharray');
          }

          circleEl.setAttribute('cx', x1.toFixed(1));
          circleEl.setAttribute('cy', y1.toFixed(1));
          circleEl.setAttribute('r', isActive ? '3.6' : '2.6');
          circleEl.setAttribute(
            'fill-opacity',
            isDimmed ? '0.24' : clamped ? '0.5' : '0.95'
          );
        }
      };

      const scheduleUpdate = () => {
        if (rafIdRef.current !== null) return;
        rafIdRef.current = requestAnimationFrame(updateSvgDom);
      };

      bridgeTriggerRef.current = scheduleUpdate;
      scheduleUpdate();

      return () => {
        if (rafIdRef.current !== null) {
          cancelAnimationFrame(rafIdRef.current);
          rafIdRef.current = null;
        }
      };
    }, [
      anchors,
      activeAnchorId,
      midLineMode,
      workspaceOuterRef,
      bookStickyRef,
      bridgeTriggerRef,
    ]);

    let liveDragPath: string | null = null;
    if (draggingWire) {
      const { startX, startY, currentX, currentY } = draggingWire;
      if (draggingWire.mode === 'to-book') {
        const dx = Math.max(40, Math.abs(startX - currentX) * 0.5);
        const cx1 = currentX + dx;
        const cx2 = startX - dx;
        liveDragPath = `M ${currentX.toFixed(1)} ${currentY.toFixed(1)} C ${cx1.toFixed(1)} ${currentY.toFixed(1)}, ${cx2.toFixed(1)} ${startY.toFixed(1)}, ${startX.toFixed(1)} ${startY.toFixed(1)}`;
      } else {
        const dx = Math.max(40, Math.abs(currentX - startX) * 0.5);
        const cx1 = startX + dx;
        const cx2 = currentX - dx;
        liveDragPath = `M ${startX.toFixed(1)} ${startY.toFixed(1)} C ${cx1.toFixed(1)} ${startY.toFixed(1)}, ${cx2.toFixed(1)} ${currentY.toFixed(1)}, ${currentX.toFixed(1)} ${currentY.toFixed(1)}`;
      }
    }

    return (
      <svg ref={svgRef} className="bridge-svg-layer" aria-hidden="true">
        {anchors.map((anchor) => {
          const color =
            anchor.color === 'amber'
              ? '#c99b26'
              : anchor.color === 'green'
                ? '#1a8f5c'
                : anchor.color === 'rose'
                  ? '#e11d48'
                  : anchor.color === 'blue'
                    ? '#2563eb'
                    : anchor.kind === 'review'
                      ? '#c99b26'
                      : anchor.kind === 'revision'
                        ? '#1a8f5c'
                        : '#2563eb';
          return (
            <g key={anchor.id} data-bridge-id={anchor.id} style={{ display: 'none' }}>
              <path fill="none" stroke={color} strokeLinecap="round" strokeLinejoin="round" />
              <circle fill={color} />
            </g>
          );
        })}

        {draggingWire && liveDragPath && (
          <g>
            <path
              d={liveDragPath}
              fill="none"
              stroke="#2563eb"
              strokeWidth={2.2}
              strokeDasharray="5 4"
            />
            <circle
              cx={draggingWire.currentX}
              cy={draggingWire.currentY}
              r={5}
              fill="#2563eb"
              fillOpacity={0.25}
              stroke="#2563eb"
              strokeWidth={1.5}
            />
            <circle cx={draggingWire.startX} cy={draggingWire.startY} r={3.5} fill="#2563eb" />
          </g>
        )}
      </svg>
    );
  }
);

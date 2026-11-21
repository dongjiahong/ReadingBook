import React, { useMemo } from 'react';
import type { AnchorColor, BookAnchor, BookParagraph, DocFormat } from '../types';

interface AnchorMinimapProps {
  docFormat: DocFormat;
  anchors: BookAnchor[];
  paragraphs: BookParagraph[];
  activeAnchorId: string | null;
  onJumpAnchor: (anchor: BookAnchor) => void;
}

const COLOR_HEX: Record<AnchorColor, string> = {
  amber: '#eab308',
  green: '#16a34a',
  rose: '#e11d48',
  blue: '#2563eb',
};

function resolveColor(anchor: BookAnchor): AnchorColor {
  if (anchor.color) return anchor.color;
  if (anchor.style === 'underline' || anchor.kind === 'revision') return 'green';
  if (anchor.kind === 'thought') return 'blue';
  return 'amber';
}

export const AnchorMinimap: React.FC<AnchorMinimapProps> = ({
  docFormat,
  anchors,
  paragraphs,
  activeAnchorId,
  onJumpAnchor,
}) => {
  const ticks = useMemo(() => {
    if (anchors.length === 0) return [];
    const paraIndex = new Map<string, number>();
    paragraphs.forEach((p, idx) => paraIndex.set(p.id, idx));
    const totalParas = Math.max(1, paragraphs.length - 1);

    let maxPdfPage = 1;
    if (docFormat === 'pdf') {
      for (const a of anchors) {
        if (a.pdfPage && a.pdfPage > maxPdfPage) maxPdfPage = a.pdfPage;
      }
    }

    return anchors.map((anchor) => {
      let ratio = 0.5;
      if (docFormat === 'pdf' && anchor.pdfPage) {
        const yInPage = anchor.pdfRects?.[0]?.y ?? 0.5;
        ratio =
          maxPdfPage <= 1
            ? yInPage
            : (anchor.pdfPage - 1 + yInPage) / Math.max(1, maxPdfPage);
      } else {
        const idx = paraIndex.get(anchor.paragraphId);
        if (idx !== undefined) ratio = idx / totalParas;
      }
      const clamped = Math.min(0.98, Math.max(0.02, ratio));
      return {
        anchor,
        topPct: clamped * 100,
        color: COLOR_HEX[resolveColor(anchor)],
      };
    });
  }, [anchors, paragraphs, docFormat]);

  if (ticks.length === 0) return null;

  return (
    <div className="anchor-minimap" aria-label="全书批注热力分布">
      {ticks.map(({ anchor, topPct, color }) => {
        const isActive = anchor.id === activeAnchorId;
        return (
          <button
            key={anchor.id}
            type="button"
            className={`anchor-minimap__tick ${isActive ? 'is-active' : ''}`}
            style={{
              top: `${topPct.toFixed(2)}%`,
              background: color,
            }}
            title={anchor.quote ? `${anchor.quote.slice(0, 60)}` : '跳转到此批注'}
            onClick={(e) => {
              e.stopPropagation();
              onJumpAnchor(anchor);
            }}
          />
        );
      })}
    </div>
  );
};

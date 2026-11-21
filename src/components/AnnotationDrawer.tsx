import React, { useMemo, useState } from 'react';
import { Image as ImageIcon, X } from 'lucide-react';
import { ANCHOR_COLORS } from './SelectionPopover';
import type {
  AnchorColor,
  AnnotationCardItem,
  BookAnchor,
  BookParagraph,
} from '../types';
import type { SearchResultAction } from './SearchModal';

interface AnnotationDrawerProps {
  anchors: BookAnchor[];
  cards: AnnotationCardItem[];
  paragraphs: BookParagraph[];
  onClose: () => void;
  onSelect: (action: SearchResultAction) => void;
}

type ColorFilter = 'all' | AnchorColor;

interface ReviewEntry {
  key: string;
  color: AnchorColor;
  quote: string;
  note: string;
  imageCount: number;
  thumbUrl?: string;
  isPlainAnchor: boolean;
  locationLabel: string;
  orderKey: number;
  action: SearchResultAction;
}

function resolveAnchorColor(anchor?: BookAnchor): AnchorColor {
  if (!anchor) return 'blue';
  if (anchor.color) return anchor.color;
  if (anchor.style === 'underline' || anchor.kind === 'revision') return 'green';
  if (anchor.kind === 'thought') return 'blue';
  return 'amber';
}

const SWATCH_MAP: Record<AnchorColor, string> = {
  amber: '#eab308',
  green: '#16a34a',
  rose: '#e11d48',
  blue: '#2563eb',
};

export const AnnotationDrawer: React.FC<AnnotationDrawerProps> = ({
  anchors,
  cards,
  paragraphs,
  onClose,
  onSelect,
}) => {
  const [colorFilter, setColorFilter] = useState<ColorFilter>('all');
  const [imagesOnly, setImagesOnly] = useState(false);
  const [cardsOnly, setCardsOnly] = useState(false);

  const allEntries = useMemo<ReviewEntry[]>(() => {
    const paraIndex = new Map<string, number>();
    paragraphs.forEach((p, idx) => paraIndex.set(p.id, idx));

    const anchorById = new Map<string, BookAnchor>();
    for (const a of anchors) anchorById.set(a.id, a);

    const list: ReviewEntry[] = [];

    for (const card of cards) {
      const anchor = card.anchorId ? anchorById.get(card.anchorId) : undefined;
      const color = resolveAnchorColor(anchor);
      const orderKey = anchor
        ? anchor.pdfPage
          ? anchor.pdfPage * 10000
          : (paraIndex.get(anchor.paragraphId) ?? 900000) * 1000 + anchor.startOffset
        : 990000000 + Math.round(card.y);
      const locationLabel = anchor?.pdfPage
        ? `P.${anchor.pdfPage}`
        : anchor
          ? '书页批注'
          : '自由卡片';

      list.push({
        key: `card-${card.id}`,
        color,
        quote: anchor?.quote?.trim() || '',
        note: card.body.trim(),
        imageCount: card.images?.length ?? 0,
        thumbUrl: card.images?.[0]?.thumbUrl || undefined,
        isPlainAnchor: false,
        locationLabel,
        orderKey,
        action: { kind: 'card', cardId: card.id, anchorId: card.anchorId },
      });
    }

    for (const anchor of anchors) {
      if (anchor.targetNodeId) continue;
      const color = resolveAnchorColor(anchor);
      const orderKey = anchor.pdfPage
        ? anchor.pdfPage * 10000
        : (paraIndex.get(anchor.paragraphId) ?? 900000) * 1000 + anchor.startOffset;

      list.push({
        key: `anchor-${anchor.id}`,
        color,
        quote: anchor.quote.trim(),
        note: '',
        imageCount: 0,
        isPlainAnchor: true,
        locationLabel: anchor.pdfPage
          ? `P.${anchor.pdfPage} · ${anchor.style === 'highlight' ? '高亮' : '划线'}`
          : anchor.style === 'highlight'
            ? '纯高亮'
            : '纯划线',
        orderKey,
        action: { kind: 'anchor', anchorId: anchor.id },
      });
    }

    list.sort((a, b) => a.orderKey - b.orderKey);
    return list;
  }, [anchors, cards, paragraphs]);

  const countsByColor = useMemo(() => {
    const counts: Record<AnchorColor, number> = {
      amber: 0,
      green: 0,
      rose: 0,
      blue: 0,
    };
    for (const e of allEntries) counts[e.color] += 1;
    return counts;
  }, [allEntries]);

  const filtered = useMemo(() => {
    return allEntries.filter((item) => {
      if (colorFilter !== 'all' && item.color !== colorFilter) return false;
      if (imagesOnly && item.imageCount === 0) return false;
      if (cardsOnly && item.isPlainAnchor) return false;
      return true;
    });
  }, [allEntries, colorFilter, imagesOnly, cardsOnly]);

  return (
    <aside className="review-drawer" aria-label="批注复盘列表">
      <div className="review-drawer__header">
        <div className="review-drawer__title">
          <span>批注复盘</span>
          <span className="review-drawer__count">{filtered.length}</span>
        </div>
        <button
          type="button"
          className="topbar__icon-btn"
          title="关闭批注列表 (Esc)"
          onClick={onClose}
        >
          <X size={14} />
        </button>
      </div>

      <div className="review-drawer__filters">
        <div className="review-drawer__color-row">
          <button
            type="button"
            className={`review-chip ${colorFilter === 'all' ? 'is-active' : ''}`}
            onClick={() => setColorFilter('all')}
          >
            全部 {allEntries.length}
          </button>
          {ANCHOR_COLORS.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`review-chip ${colorFilter === c.id ? 'is-active' : ''}`}
              title={`仅看${c.label}`}
              onClick={() =>
                setColorFilter((prev) => (prev === c.id ? 'all' : c.id))
              }
            >
              <span
                className="review-chip__dot"
                style={{ background: c.swatch }}
              />
              <span>{countsByColor[c.id]}</span>
            </button>
          ))}
        </div>

        <div className="review-drawer__toggle-row">
          <button
            type="button"
            className={`review-chip ${imagesOnly ? 'is-active' : ''}`}
            onClick={() => setImagesOnly((v) => !v)}
          >
            <ImageIcon size={11} />
            <span>仅看附图</span>
          </button>
          <button
            type="button"
            className={`review-chip ${cardsOnly ? 'is-active' : ''}`}
            onClick={() => setCardsOnly((v) => !v)}
          >
            <span>仅看卡片</span>
          </button>
        </div>
      </div>

      <div className="review-drawer__list">
        {filtered.length === 0 ? (
          <div className="review-drawer__empty">当前筛选条件下没有批注</div>
        ) : (
          filtered.map((item) => (
            <button
              key={item.key}
              type="button"
              className="review-item"
              onClick={() => onSelect(item.action)}
            >
              <div className="review-item__meta">
                <span
                  className="review-item__dot"
                  style={{ background: SWATCH_MAP[item.color] }}
                />
                <span className="review-item__loc">{item.locationLabel}</span>
                {item.imageCount > 0 && (
                  <span className="review-item__img-badge">
                    <ImageIcon size={10} />×{item.imageCount}
                  </span>
                )}
              </div>

              {item.note && (
                <div className="review-item__note">{item.note}</div>
              )}

              {item.quote && (
                <div className="review-item__quote">“{item.quote}”</div>
              )}

              {item.thumbUrl && (
                <img
                  src={item.thumbUrl}
                  alt="附图缩略图"
                  className="review-item__thumb"
                  loading="lazy"
                />
              )}
            </button>
          ))
        )}
      </div>
    </aside>
  );
};

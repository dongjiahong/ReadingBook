import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Images,
  X,
} from 'lucide-react';
import { ANCHOR_COLORS } from './SelectionPopover';
import { useBackHandler } from '../utils/backStack';
import { createFullImageUrl, revokeObjectUrlIfBlob } from '../utils/imageStore';
import type {
  AnchorColor,
  AnnotationCardItem,
  BookAnchor,
  BookParagraph,
  CardImage,
} from '../types';
import type { SearchResultAction } from './SearchModal';

interface GalleryModalProps {
  open: boolean;
  bookTitle: string;
  anchors: BookAnchor[];
  cards: AnnotationCardItem[];
  paragraphs: BookParagraph[];
  onClose: () => void;
  onJump: (action: SearchResultAction) => void;
}

interface GalleryItem {
  key: string;
  card: AnnotationCardItem;
  anchor?: BookAnchor;
  image: CardImage;
  imageIndex: number;
  imageTotal: number;
  color: AnchorColor;
  tags: string[];
  locationLabel: string;
  orderKey: number;
}

const COLOR_HEX: Record<AnchorColor, string> = {
  amber: '#eab308',
  green: '#16a34a',
  rose: '#e11d48',
  blue: '#2563eb',
};

function resolveColor(anchor?: BookAnchor): AnchorColor {
  if (!anchor) return 'blue';
  if (anchor.color) return anchor.color;
  if (anchor.style === 'underline' || anchor.kind === 'revision') return 'green';
  if (anchor.kind === 'thought') return 'blue';
  return 'amber';
}

function extractTags(text: string): string[] {
  const matches = text.match(/#[\w\u4e00-\u9fa5/-]+/g);
  if (!matches) return [];
  return Array.from(new Set(matches));
}

export const GalleryModal: React.FC<GalleryModalProps> = ({
  open,
  bookTitle,
  anchors,
  cards,
  paragraphs,
  onClose,
  onJump,
}) => {
  const [colorFilter, setColorFilter] = useState<'all' | AnchorColor>('all');
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [fullUrl, setFullUrl] = useState<string | null>(null);

  const allItems = useMemo<GalleryItem[]>(() => {
    const paraIndex = new Map<string, number>();
    paragraphs.forEach((p, idx) => paraIndex.set(p.id, idx));

    const anchorById = new Map<string, BookAnchor>();
    for (const a of anchors) anchorById.set(a.id, a);

    const list: GalleryItem[] = [];
    for (const card of cards) {
      const imgs = card.images ?? [];
      if (imgs.length === 0) continue;
      const anchor = card.anchorId ? anchorById.get(card.anchorId) : undefined;
      const color = resolveColor(anchor);
      const tags = extractTags(card.body);
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

      imgs.forEach((img, idx) => {
        list.push({
          key: `${card.id}-${img.id}`,
          card,
          anchor,
          image: img,
          imageIndex: idx + 1,
          imageTotal: imgs.length,
          color,
          tags,
          locationLabel,
          orderKey: orderKey + idx,
        });
      });
    }

    list.sort((a, b) => a.orderKey - b.orderKey);
    return list;
  }, [anchors, cards, paragraphs]);

  const allTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of allItems) {
      for (const tag of item.tags) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12);
  }, [allItems]);

  const filtered = useMemo(() => {
    return allItems.filter((item) => {
      if (colorFilter !== 'all' && item.color !== colorFilter) return false;
      if (tagFilter && !item.tags.includes(tagFilter)) return false;
      return true;
    });
  }, [allItems, colorFilter, tagFilter]);

  const activeItem =
    activeIndex !== null && activeIndex >= 0 && activeIndex < filtered.length
      ? filtered[activeIndex]
      : null;

  // Load full-resolution image when entering flashcard view
  useEffect(() => {
    if (!open || !activeItem) {
      setFullUrl((prev) => {
        if (prev) revokeObjectUrlIfBlob(prev);
        return null;
      });
      return;
    }
    let alive = true;
    let createdUrl: string | null = null;
    void createFullImageUrl(activeItem.image).then((url) => {
      if (!alive) {
        if (url) revokeObjectUrlIfBlob(url);
        return;
      }
      createdUrl = url;
      setFullUrl((prev) => {
        if (prev && prev !== url) revokeObjectUrlIfBlob(prev);
        return url ?? activeItem.image.thumbUrl;
      });
    });
    return () => {
      alive = false;
      if (createdUrl) revokeObjectUrlIfBlob(createdUrl);
    };
  }, [open, activeItem]);

  useBackHandler(open, onClose);
  useBackHandler(open && activeIndex !== null, () => setActiveIndex(null));

  useEffect(() => {
    if (!open) {
      setActiveIndex(null);
      return;
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (activeIndex !== null) setActiveIndex(null);
        else onClose();
      } else if (activeIndex !== null && filtered.length > 0) {
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          setActiveIndex((idx) =>
            idx === null ? 0 : (idx + 1) % filtered.length
          );
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault();
          setActiveIndex((idx) =>
            idx === null ? 0 : (idx - 1 + filtered.length) % filtered.length
          );
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, activeIndex, filtered.length, onClose]);

  if (!open) return null;

  return (
    <div
      className="gallery-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="gallery-modal" onMouseDown={(e) => e.stopPropagation()}>
        <header className="gallery-header">
          <div className="gallery-header__left">
            {activeItem ? (
              <button
                type="button"
                className="gallery-back-btn"
                onClick={() => setActiveIndex(null)}
              >
                <ArrowLeft size={14} />
                <span>返回画廊</span>
              </button>
            ) : (
              <Images size={16} className="gallery-header__icon" />
            )}
            <h2>
              {activeItem
                ? `闪卡复盘 (${(activeIndex ?? 0) + 1} / ${filtered.length})`
                : `图卡复盘画廊 · 《${bookTitle}》`}
            </h2>
            {!activeItem && (
              <span className="review-drawer__count">{filtered.length} 张</span>
            )}
          </div>

          <button
            type="button"
            className="topbar__icon-btn"
            title="关闭 (Esc)"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>

        {!activeItem && (
          <div className="gallery-filters">
            <div className="review-drawer__color-row">
              <button
                type="button"
                className={`review-chip ${colorFilter === 'all' ? 'is-active' : ''}`}
                onClick={() => setColorFilter('all')}
              >
                全部 {allItems.length}
              </button>
              {ANCHOR_COLORS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={`review-chip ${colorFilter === c.id ? 'is-active' : ''}`}
                  onClick={() =>
                    setColorFilter((prev) => (prev === c.id ? 'all' : c.id))
                  }
                >
                  <span
                    className="review-chip__dot"
                    style={{ background: c.swatch }}
                  />
                  <span>{c.label}</span>
                </button>
              ))}
            </div>

            {allTags.length > 0 && (
              <div className="review-drawer__toggle-row">
                {allTags.map(([tag, count]) => (
                  <button
                    key={tag}
                    type="button"
                    className={`review-chip ${tagFilter === tag ? 'is-active' : ''}`}
                    onClick={() =>
                      setTagFilter((prev) => (prev === tag ? null : tag))
                    }
                  >
                    <span>
                      {tag} ({count})
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {activeItem ? (
          <div className="gallery-flashcard">
            <button
              type="button"
              className="gallery-nav-btn gallery-nav-btn--prev"
              title="上一张 (←)"
              disabled={filtered.length <= 1}
              onClick={() =>
                setActiveIndex((idx) =>
                  idx === null ? 0 : (idx - 1 + filtered.length) % filtered.length
                )
              }
            >
              <ChevronLeft size={20} />
            </button>

            <div className="gallery-flashcard__stage">
              <div className="gallery-flashcard__img-wrap">
                <img
                  src={fullUrl ?? activeItem.image.thumbUrl}
                  alt="复盘图表"
                  className="gallery-flashcard__img"
                />
              </div>

              <div className="gallery-flashcard__sidebar">
                <div className="gallery-flashcard__meta">
                  <span
                    className="review-item__dot"
                    style={{ background: COLOR_HEX[activeItem.color] }}
                  />
                  <span>{activeItem.locationLabel}</span>
                  {activeItem.imageTotal > 1 && (
                    <span className="review-item__img-badge">
                      图 {activeItem.imageIndex}/{activeItem.imageTotal}
                    </span>
                  )}
                </div>

                {activeItem.card.body.trim() ? (
                  <div className="gallery-flashcard__note">
                    {activeItem.card.body.trim()}
                  </div>
                ) : (
                  <div className="gallery-flashcard__note gallery-flashcard__note--empty">
                    （暂无文字笔记）
                  </div>
                )}

                {activeItem.anchor?.quote?.trim() && (
                  <blockquote className="gallery-flashcard__quote">
                    {activeItem.anchor.quote.trim()}
                  </blockquote>
                )}

                <button
                  type="button"
                  className="gallery-jump-btn"
                  onClick={() => {
                    onClose();
                    onJump({
                      kind: 'card',
                      cardId: activeItem.card.id,
                      anchorId: activeItem.card.anchorId,
                    });
                  }}
                >
                  <BookOpen size={14} />
                  <span>跳回原书位置</span>
                </button>
              </div>
            </div>

            <button
              type="button"
              className="gallery-nav-btn gallery-nav-btn--next"
              title="下一张 (→)"
              disabled={filtered.length <= 1}
              onClick={() =>
                setActiveIndex((idx) =>
                  idx === null ? 0 : (idx + 1) % filtered.length
                )
              }
            >
              <ChevronRight size={20} />
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="gallery-empty">
            暂无带图批注卡片。在书页插图上点「转成卡片」、PDF 框选截图或粘贴截图到卡片后即可在此画廊复盘。
          </div>
        ) : (
          <div className="gallery-grid">
            {filtered.map((item, idx) => (
              <button
                key={item.key}
                type="button"
                className="gallery-card"
                onClick={() => setActiveIndex(idx)}
              >
                <div className="gallery-card__media">
                  <img
                    src={item.image.thumbUrl}
                    alt="图卡缩略图"
                    loading="lazy"
                  />
                  <span
                    className="gallery-card__dot"
                    style={{ background: COLOR_HEX[item.color] }}
                  />
                </div>
                <div className="gallery-card__body">
                  <div className="gallery-card__note">
                    {item.card.body.trim() || item.anchor?.quote?.trim() || '图片批注'}
                  </div>
                  <div className="gallery-card__foot">
                    <span>{item.locationLabel}</span>
                    {item.tags.length > 0 && (
                      <span className="gallery-card__tag">{item.tags[0]}</span>
                    )}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

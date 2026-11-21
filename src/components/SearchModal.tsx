import React, { useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, FileText, Search, StickyNote, X } from 'lucide-react';
import { loadAllBookAnnotations, type BookAnnotationsSummary } from '../services/db';
import { isDesktop } from '../services/library';
import type { AnnotationCardItem, BookAnchor, BookParagraph } from '../types';

type SearchScope = 'notes' | 'book' | 'all';

export type SearchResultAction =
  | { kind: 'card'; cardId: string; anchorId?: string }
  | { kind: 'anchor'; anchorId: string }
  | { kind: 'paragraph'; paragraphId: string }
  | { kind: 'other-book'; bookId: string };

interface SearchResultItem {
  id: string;
  title: string;
  subtitle?: string;
  badge: string;
  action: SearchResultAction;
}

interface SearchModalProps {
  open: boolean;
  currentBookId: string;
  currentBookTitle: string;
  paragraphs: BookParagraph[];
  anchors: BookAnchor[];
  cards: AnnotationCardItem[];
  onClose: () => void;
  onSelect: (action: SearchResultAction) => void;
}

function buildSnippet(text: string, query: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!query) return clean.slice(0, 90);
  const idx = clean.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return clean.slice(0, 90);
  const start = Math.max(0, idx - 24);
  const end = Math.min(clean.length, idx + query.length + 56);
  return `${start > 0 ? '…' : ''}${clean.slice(start, end)}${end < clean.length ? '…' : ''}`;
}

export const SearchModal: React.FC<SearchModalProps> = ({
  open,
  currentBookId,
  currentBookTitle,
  paragraphs,
  anchors,
  cards,
  onClose,
  onSelect,
}) => {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<SearchScope>('notes');
  const [activeIndex, setActiveIndex] = useState(0);
  const [allBooksData, setAllBooksData] = useState<BookAnnotationsSummary[] | null>(null);

  useEffect(() => {
    if (!open) return;
    setActiveIndex(0);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 20);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open || scope !== 'all' || !isDesktop()) return;
    let alive = true;
    void loadAllBookAnnotations()
      .then((rows) => {
        if (alive) setAllBooksData(rows);
      })
      .catch(() => {
        if (alive) setAllBooksData([]);
      });
    return () => {
      alive = false;
    };
  }, [open, scope]);

  const results = useMemo<SearchResultItem[]>(() => {
    const q = query.trim().toLowerCase();
    const items: SearchResultItem[] = [];

    if (scope === 'notes') {
      const anchorById = new Map(anchors.map((a) => [a.id, a]));
      for (const card of cards) {
        const anchor = card.anchorId ? anchorById.get(card.anchorId) : undefined;
        const body = card.body.trim();
        const quote = anchor?.quote.trim() ?? '';
        const haystack = `${body}\n${quote}`.toLowerCase();
        if (q && !haystack.includes(q)) continue;
        const label =
          body ||
          quote ||
          ((card.images?.length ?? 0) > 0 ? `图片卡片 ×${card.images?.length}` : '空卡片');
        items.push({
          id: `card-${card.id}`,
          title: buildSnippet(label, q),
          subtitle: quote && body && quote !== body ? `原文：${buildSnippet(quote, q)}` : undefined,
          badge: (card.images?.length ?? 0) > 0 ? `图×${card.images?.length}` : '卡片',
          action: { kind: 'card', cardId: card.id, anchorId: card.anchorId },
        });
      }
      for (const anchor of anchors) {
        if (anchor.targetNodeId) continue;
        const quote = anchor.quote.trim();
        if (!quote) continue;
        if (q && !quote.toLowerCase().includes(q)) continue;
        items.push({
          id: `anc-${anchor.id}`,
          title: buildSnippet(quote, q),
          badge: anchor.style === 'highlight' ? '高亮' : '划线',
          action: { kind: 'anchor', anchorId: anchor.id },
        });
      }
      return items.slice(0, 60);
    }

    if (scope === 'book') {
      if (!q) return [];
      for (const p of paragraphs) {
        const text = p.text?.trim();
        if (!text) continue;
        if (!text.toLowerCase().includes(q)) continue;
        items.push({
          id: `para-${p.id}`,
          title: buildSnippet(text, q),
          badge: p.type === 'heading' ? '标题' : '正文',
          action: { kind: 'paragraph', paragraphId: p.id },
        });
        if (items.length >= 45) break;
      }
      return items;
    }

    // scope === 'all'（跨书批注搜索）
    const dataset: BookAnnotationsSummary[] = allBooksData ?? [
      {
        bookId: currentBookId,
        bookTitle: currentBookTitle,
        annotations: { anchors, cards, edges: [] },
      },
    ];
    for (const entry of dataset) {
      const anchorById = new Map(entry.annotations.anchors.map((a) => [a.id, a]));
      for (const card of entry.annotations.cards) {
        const anchor = card.anchorId ? anchorById.get(card.anchorId) : undefined;
        const body = card.body.trim();
        const quote = anchor?.quote.trim() ?? '';
        const haystack = `${entry.bookTitle}\n${body}\n${quote}`.toLowerCase();
        if (q && !haystack.includes(q)) continue;
        const label = body || quote || ((card.images?.length ?? 0) > 0 ? '图片卡片' : '');
        if (!label) continue;
        const isCurrent = entry.bookId === currentBookId;
        items.push({
          id: `all-${entry.bookId}-${card.id}`,
          title: buildSnippet(label, q),
          subtitle: `《${entry.bookTitle}》`,
          badge: isCurrent ? '本书' : '切换书',
          action: isCurrent
            ? { kind: 'card', cardId: card.id, anchorId: card.anchorId }
            : { kind: 'other-book', bookId: entry.bookId },
        });
        if (items.length >= 60) return items;
      }
    }
    return items;
  }, [query, scope, anchors, cards, paragraphs, allBooksData, currentBookId, currentBookTitle]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, scope]);

  if (!open) return null;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((prev) => Math.min(Math.max(0, results.length - 1), prev + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((prev) => Math.max(0, prev - 1));
    } else if (e.key === 'Enter' && results[activeIndex]) {
      e.preventDefault();
      onSelect(results[activeIndex].action);
      onClose();
    }
  };

  return (
    <div
      className="search-modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="search-modal" onKeyDown={handleKeyDown}>
        <div className="search-modal__input-row">
          <Search size={15} className="search-modal__icon" />
          <input
            ref={inputRef}
            type="text"
            className="search-modal__input"
            placeholder={
              scope === 'book'
                ? '输入关键词搜索本书原文段落…'
                : scope === 'all'
                  ? '搜索书库中所有书籍的批注卡片…'
                  : '搜索当前书的批注卡片与划线…'
            }
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button
            type="button"
            className="topbar__icon-btn"
            title="关闭 (Esc)"
            onClick={onClose}
          >
            <X size={14} />
          </button>
        </div>

        <div className="search-modal__tabs">
          <button
            type="button"
            className={`search-modal__tab ${scope === 'notes' ? 'is-active' : ''}`}
            onClick={() => setScope('notes')}
          >
            <StickyNote size={12} />
            <span>本书批注</span>
          </button>
          <button
            type="button"
            className={`search-modal__tab ${scope === 'book' ? 'is-active' : ''}`}
            onClick={() => setScope('book')}
          >
            <FileText size={12} />
            <span>本书原文</span>
          </button>
          {isDesktop() && (
            <button
              type="button"
              className={`search-modal__tab ${scope === 'all' ? 'is-active' : ''}`}
              onClick={() => setScope('all')}
            >
              <BookOpen size={12} />
              <span>全部书籍批注</span>
            </button>
          )}
        </div>

        <div className="search-modal__list">
          {results.length === 0 ? (
            <div className="search-modal__empty">
              {scope === 'book' && !query.trim()
                ? '输入关键词开始搜索正文内容'
                : '没有找到匹配的结果'}
            </div>
          ) : (
            results.map((item, idx) => (
              <button
                key={item.id}
                type="button"
                className={`search-modal__item ${idx === activeIndex ? 'is-active' : ''}`}
                onMouseEnter={() => setActiveIndex(idx)}
                onClick={() => {
                  onSelect(item.action);
                  onClose();
                }}
              >
                <div className="search-modal__item-main">
                  <span className="search-modal__item-title">{item.title}</span>
                  {item.subtitle && (
                    <span className="search-modal__item-sub">{item.subtitle}</span>
                  )}
                </div>
                <span className="search-modal__badge">{item.badge}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
};

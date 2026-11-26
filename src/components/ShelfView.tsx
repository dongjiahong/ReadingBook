import React, { useEffect, useState } from 'react';
import {
  ArrowRight,
  BookOpen,
  Loader2,
  Plus,
  Settings,
  Trash2,
  Upload,
} from 'lucide-react';
import { loadAllBookAnnotations } from '../services/db';
import { getCoverUrl } from '../services/library';
import type { SyncRuntimeSnapshot } from '../services/sync';
import type { BookRecord } from '../types';
import { SyncStatusBadge } from './SyncStatusBadge';

interface ShelfViewProps {
  books: BookRecord[];
  desktop: boolean;
  isMobile?: boolean;
  importing: boolean;
  error: string | null;
  isDragOver?: boolean;
  syncRuntime: SyncRuntimeSnapshot;
  onImport: () => void;
  onOpen: (book: BookRecord) => void;
  onDelete: (book: BookRecord) => void;
  onOpenSettings: () => void;
  onOpenSync: () => void;
}

interface BookStats {
  cards: number;
  images: number;
  anchors: number;
}

export const ShelfView: React.FC<ShelfViewProps> = ({
  books,
  desktop,
  isMobile = false,
  importing,
  error,
  isDragOver = false,
  syncRuntime,
  onImport,
  onOpen,
  onDelete,
  onOpenSettings,
  onOpenSync,
}) => {
  const [statsByBook, setStatsByBook] = useState<Record<string, BookStats>>({});

  useEffect(() => {
    if (!desktop || books.length === 0) return;
    let alive = true;
    void loadAllBookAnnotations()
      .then((list) => {
        if (!alive) return;
        const map: Record<string, BookStats> = {};
        for (const item of list) {
          const images = item.annotations.cards.reduce(
            (sum, c) => sum + (c.images?.length ?? 0),
            0
          );
          map[item.bookId] = {
            cards: item.annotations.cards.length,
            images,
            anchors: item.annotations.anchors.length,
          };
        }
        setStatsByBook(map);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [desktop, books]);

  const recentBook = books.find((b) => b.lastOpenedAt !== null) ?? books[0] ?? null;

  return (
    <div className="shelf">
      <header className="shelf__header" data-tauri-drag-region>
        <div className="shelf__brand" data-tauri-drag-region>
          <BookOpen size={16} />
          <h1>书架</h1>
          <span className="shelf__count">{books.length} 本</span>
        </div>
        <div className="shelf__actions">
          <button
            type="button"
            className="shelf__import"
            onClick={onImport}
            disabled={!desktop || importing}
          >
            {importing ? (
              <Loader2 size={14} className="topbar__spinner" />
            ) : (
              <Plus size={14} />
            )}
            {importing ? '导入中…' : '导入书籍'}
          </button>
          {desktop && (
            <SyncStatusBadge
              runtime={syncRuntime}
              variant={isMobile ? 'icon' : 'pill'}
              onClick={onOpenSync}
            />
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

      {isDragOver && (
        <div className="shelf-drop-overlay" aria-live="polite">
          <div className="shelf-drop-overlay__card">
            <Upload size={26} />
            <strong>松开鼠标导入书籍</strong>
            <span>支持将 .epub / .pdf 直接拖入书架</span>
          </div>
        </div>
      )}

      <main className="shelf__body">
        {!desktop && (
          <div className="shelf__notice">
            书架与本地文件需要桌面版（Tauri）。当前是浏览器预览模式，可先用示例文档体验批注工作台。
          </div>
        )}
        {error && <div className="shelf__error">{error}</div>}

        {recentBook && (
          <ContinueReadingHero
            book={recentBook}
            stats={statsByBook[recentBook.id]}
            onOpen={() => onOpen(recentBook)}
          />
        )}

        {books.length > 0 && (
          <div className="shelf__section-head">
            <span>全部书籍</span>
          </div>
        )}

        <div className="shelf__grid">
          {books.map((book) => (
            <BookCard
              key={book.id}
              book={book}
              stats={statsByBook[book.id]}
              onOpen={() => onOpen(book)}
              onDelete={onDelete}
            />
          ))}
          {desktop && (
            <button
              type="button"
              className="shelf__add-tile"
              onClick={onImport}
              disabled={importing}
            >
              <Plus size={20} />
              <span>导入 EPUB / PDF</span>
            </button>
          )}
        </div>

        {desktop && books.length === 0 && (
          <p className="shelf__hint">
            书库是空的。点击上方导入或直接将 .epub / .pdf 拖到窗口中，批注与进度均保存在本地 SQLite。
          </p>
        )}
      </main>
    </div>
  );
};

interface ContinueReadingHeroProps {
  book: BookRecord;
  stats?: BookStats;
  onOpen: () => void;
}

const ContinueReadingHero: React.FC<ContinueReadingHeroProps> = ({
  book,
  stats,
  onOpen,
}) => {
  const [coverUrl, setCoverUrl] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    if (book.coverPath) {
      void getCoverUrl(book)
        .then((url) => {
          if (alive) setCoverUrl(url);
        })
        .catch(() => {});
    } else {
      setCoverUrl(null);
    }
    return () => {
      alive = false;
    };
  }, [book.id, book.coverPath]);

  const percent = Math.round((book.progress ?? 0) * 100);

  return (
    <section
      className="shelf-hero"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="shelf-hero__cover">
        {coverUrl ? (
          <img src={coverUrl} alt={`${book.title} 封面`} />
        ) : (
          <div className="book-card__cover-fallback">
            <BookOpen size={24} />
          </div>
        )}
        <span className="book-card__spine" aria-hidden="true" />
      </div>

      <div className="shelf-hero__content">
        <div className="shelf-hero__eyebrow-row">
          <span className="shelf-hero__eyebrow">继续阅读</span>
          <span className="shelf-hero__format-badge">{book.format.toUpperCase()}</span>
        </div>
        <h2 className="shelf-hero__title">{book.title}</h2>
        <div className="shelf-hero__author">{book.author || '未知作者'}</div>

        <div className="shelf-hero__progress-row">
          <div className="shelf-hero__progress-bar">
            <span style={{ width: `${Math.min(100, percent)}%` }} />
          </div>
          <span className="shelf-hero__progress-text">
            {percent > 0 ? `已读 ${percent}%` : '刚开读 · 0%'}
          </span>
        </div>
      </div>

      <div className="shelf-hero__right">
        <div className="shelf-hero__metrics">
          <div className="shelf-hero__metric">
            <span className="shelf-hero__metric-num">{stats?.anchors ?? 0}</span>
            <span className="shelf-hero__metric-label">高亮</span>
          </div>
          <div className="shelf-hero__metric">
            <span className="shelf-hero__metric-num">{stats?.cards ?? 0}</span>
            <span className="shelf-hero__metric-label">批注卡</span>
          </div>
          <div className="shelf-hero__metric">
            <span className="shelf-hero__metric-num">{stats?.images ?? 0}</span>
            <span className="shelf-hero__metric-label">图表</span>
          </div>
        </div>

        <span className="shelf-hero__cta">
          <span>继续阅读</span>
          <ArrowRight size={14} />
        </span>
      </div>
    </section>
  );
};

interface BookCardProps {
  book: BookRecord;
  stats?: BookStats;
  onOpen: () => void;
  onDelete: (book: BookRecord) => void;
}

const BookCard: React.FC<BookCardProps> = ({ book, stats, onOpen, onDelete }) => {
  const [coverUrl, setCoverUrl] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    if (book.coverPath) {
      void getCoverUrl(book)
        .then((url) => {
          if (alive) setCoverUrl(url);
        })
        .catch(() => {});
    } else {
      setCoverUrl(null);
    }
    return () => {
      alive = false;
    };
  }, [book.id, book.coverPath]);

  const percent = Math.round((book.progress ?? 0) * 100);

  return (
    <div
      className="book-card"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="book-card__cover">
        {coverUrl ? (
          <img src={coverUrl} alt={`${book.title} 封面`} loading="lazy" />
        ) : (
          <div className="book-card__cover-fallback">
            <BookOpen size={22} />
          </div>
        )}
        <span className="book-card__spine" aria-hidden="true" />
        <button
          type="button"
          className="book-card__delete"
          title="从书架移除"
          onClick={(event) => {
            event.stopPropagation();
            onDelete(book);
          }}
        >
          <Trash2 size={13} />
        </button>
        {book.format === 'pdf' && <span className="book-card__format">PDF</span>}
      </div>

      <div className="book-card__info">
        <div className="book-card__title" title={book.title}>
          {book.title}
        </div>
        <div className="book-card__author">{book.author || '未知作者'}</div>
        <div className="book-card__progress">
          <span style={{ width: `${Math.min(100, percent)}%` }} />
        </div>
        <div className="book-card__meta">
          {percent > 0 ? `已读 ${percent}%` : '尚未开始'}
          {stats && stats.cards > 0 ? ` · ${stats.cards} 笔记` : ''}
        </div>
      </div>
    </div>
  );
};

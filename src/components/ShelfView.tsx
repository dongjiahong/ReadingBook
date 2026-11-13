import React, { useEffect, useState } from 'react';
import { BookOpen, Loader2, Plus, Settings, Trash2 } from 'lucide-react';
import { getCoverUrl } from '../services/library';
import type { BookRecord } from '../types';

interface ShelfViewProps {
  books: BookRecord[];
  desktop: boolean;
  importing: boolean;
  error: string | null;
  onImport: () => void;
  onOpen: (book: BookRecord) => void;
  onDelete: (book: BookRecord) => void;
  onOpenSettings: () => void;
}

export const ShelfView: React.FC<ShelfViewProps> = ({
  books,
  desktop,
  importing,
  error,
  onImport,
  onOpen,
  onDelete,
  onOpenSettings,
}) => {
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

      <main className="shelf__body">
        {!desktop && (
          <div className="shelf__notice">
            书架与本地文件需要桌面版（Tauri）。当前是浏览器预览模式，可先用示例文档体验批注工作台。
          </div>
        )}
        {error && <div className="shelf__error">{error}</div>}

        <div className="shelf__grid">
          {books.map((book) => (
            <BookCard
              key={book.id}
              book={book}
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
            书库是空的。导入的书会复制到应用数据目录，批注、阅读进度和设置都保存在本地 SQLite。
          </p>
        )}
      </main>
    </div>
  );
};

interface BookCardProps {
  book: BookRecord;
  onOpen: () => void;
  onDelete: (book: BookRecord) => void;
}

const BookCard: React.FC<BookCardProps> = ({ book, onOpen, onDelete }) => {
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
        <div className="book-card__author">
          {book.author || '未知作者'}
        </div>
        <div className="book-card__progress">
          <span style={{ width: `${Math.min(100, percent)}%` }} />
        </div>
        <div className="book-card__meta">
          {percent > 0 ? `已读 ${percent}%` : '尚未开始'}
        </div>
      </div>
    </div>
  );
};

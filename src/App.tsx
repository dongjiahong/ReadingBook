import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import MobileReaderView from './MobileReaderView';
import ReaderView from './ReaderView';
import { ShelfView } from './components/ShelfView';
import { SettingsPanel } from './components/SettingsPanel';
import { SyncModal } from './components/SyncModal';
import {
  deleteBookRecord,
  listBooks,
  loadAnnotations,
  loadSettings,
  saveSettings,
  updateBookProgress,
} from './services/db';
import {
  deleteBookFromDisk,
  importBookFromDisk,
  importBookFromPath,
  isDesktop,
  markBookOpenedNow,
} from './services/library';
import { initSyncHost } from './services/sync';
import type { BookRecord, ReaderSettings } from './types';
import { deleteStoredImage } from './utils/imageStore';
import { isMacDesktopRuntime, useIsMobileLayout } from './utils/platform';

const DEFAULT_SETTINGS: ReaderSettings = {
  theme: 'light',
  fontSize: 15,
  lineHeight: 1.85,
  bookWidth: 580,
  fontFamily: 'system',
  cardScale: 1,
};

export default function App() {
  const desktop = isDesktop();
  const isMobile = useIsMobileLayout();
  const isMacDesktop = isMacDesktopRuntime();
  const [settings, setSettings] = useState<ReaderSettings>(DEFAULT_SETTINGS);
  const [books, setBooks] = useState<BookRecord[]>([]);
  const [activeBookId, setActiveBookId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showSync, setShowSync] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<BookRecord | null>(null);
  const progressTimerRef = useRef<number | null>(null);

  const refreshBooks = useCallback(async () => {
    if (!desktop) return;
    try {
      setBooks(await listBooks());
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取书架失败');
    }
  }, [desktop]);

  useEffect(() => {
    if (!desktop) return;
    let alive = true;
    void (async () => {
      try {
        const stored = await loadSettings();
        if (alive && stored) {
          setSettings({ ...DEFAULT_SETTINGS, ...stored });
        }
      } catch (err) {
        console.warn('读取设置失败', err);
      }
      await refreshBooks();
    })();
    return () => {
      alive = false;
    };
  }, [desktop, refreshBooks]);

  useEffect(() => {
    if (!desktop) return;
    const timer = window.setTimeout(() => {
      void saveSettings(settings).catch((err) => console.warn('保存设置失败', err));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [desktop, settings]);

  // Start WiFi LAN sync host (UDP discovery + embedded HTTP server) on Tauri runtimes
  useEffect(() => {
    if (!desktop) return;
    let cleanup: (() => void) | null = null;
    let disposed = false;
    void initSyncHost(() => {
      void refreshBooks();
    })
      .then((fn) => {
        if (disposed) {
          fn();
        } else {
          cleanup = fn;
        }
      })
      .catch((err) => console.warn('启动局域网同步服务失败', err));
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [desktop, refreshBooks]);

  // Support dragging .epub / .pdf files directly onto the bookshelf window (macOS Finder)
  useEffect(() => {
    if (!desktop || activeBookId !== null) {
      setIsDragOver(false);
      return;
    }
    let unlisten: (() => void) | null = null;
    let disposed = false;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === 'enter' || payload.type === 'over') {
          setIsDragOver(true);
        } else if (payload.type === 'leave') {
          setIsDragOver(false);
        } else if (payload.type === 'drop') {
          setIsDragOver(false);
          const bookPaths = payload.paths.filter((p) => /\.(epub|pdf)$/i.test(p));
          if (bookPaths.length === 0) {
            setError('仅支持拖入 .epub 或 .pdf 电子书文件');
            return;
          }
          setImporting(true);
          setError(null);
          void (async () => {
            try {
              for (const path of bookPaths) {
                await importBookFromPath(path);
              }
              await refreshBooks();
            } catch (err) {
              setError(err instanceof Error ? err.message : '拖拽导入失败');
            } finally {
              setImporting(false);
            }
          })();
        }
      })
      .then((fn) => {
        if (disposed) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [desktop, activeBookId, refreshBooks]);

  const updateSettings = useCallback((patch: Partial<ReaderSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }));
  }, []);

  const handleOpenBook = useCallback(
    async (book: BookRecord) => {
      setError(null);
      await markBookOpenedNow(book).catch(() => {});
    setActiveBookId(book.id);
    },
    [desktop]
  );

  const handleImport = useCallback(async () => {
    if (!desktop || importing) return;
    setImporting(true);
    setError(null);
    try {
      const book = await importBookFromDisk();
      await refreshBooks();
      if (book) setActiveBookId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '导入失败');
    } finally {
      setImporting(false);
    }
  }, [desktop, importing, refreshBooks]);

  const handleDeleteBook = useCallback((book: BookRecord) => {
    setPendingDelete(book);
  }, []);

  const confirmDeleteBook = useCallback(async () => {
    const book = pendingDelete;
    if (!book) return;
    setPendingDelete(null);
    try {
      const saved = await loadAnnotations(book.id);
      for (const card of saved?.cards ?? []) {
        for (const image of card.images ?? []) void deleteStoredImage(image);
      }
      await deleteBookFromDisk(book);
      await deleteBookRecord(book.id);
      if (activeBookId === book.id) setActiveBookId(null);
      await refreshBooks();
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败');
    }
  }, [pendingDelete, activeBookId, refreshBooks]);

  // Only persist progress. Updating `books` here would hand ReaderView a new
  // book object on every scroll and reload the whole document.
  const handleProgress = useCallback(
    (bookId: string, progress: number, locator: string) => {
      if (!desktop) return;
      if (progressTimerRef.current) window.clearTimeout(progressTimerRef.current);
      progressTimerRef.current = window.setTimeout(() => {
        void updateBookProgress(bookId, progress, locator).catch((err) =>
          console.warn('保存阅读进度失败', err)
        );
      }, 400);
    },
    [desktop]
  );

  const activeBook =
    activeBookId === null
      ? null
      : (books.find((item) => item.id === activeBookId) ?? null);

  return (
    <div
      className={`app-root theme-${settings.theme} ${isMacDesktop ? 'is-desktop' : ''} ${
        isMobile ? 'is-mobile' : ''
      }`}
    >
      {activeBook ? (
        isMobile ? (
          <MobileReaderView
            key={activeBook.id}
            book={activeBook}
            settings={settings}
            onBack={() => {
              setActiveBookId(null);
              void refreshBooks();
            }}
            onSwitchBook={(bookId) => {
              const target = books.find((item) => item.id === bookId);
              if (target) void handleOpenBook(target);
            }}
            onOpenSettings={() => setShowSettings(true)}
            onProgress={handleProgress}
          />
        ) : (
          <ReaderView
            key={activeBook.id}
            book={activeBook}
            settings={settings}
            onBack={() => {
              setActiveBookId(null);
              void refreshBooks();
            }}
            onSwitchBook={(bookId) => {
              const target = books.find((item) => item.id === bookId);
              if (target) void handleOpenBook(target);
            }}
            onOpenSettings={() => setShowSettings(true)}
            onSettingsChange={updateSettings}
            onProgress={handleProgress}
          />
        )
      ) : (
        <ShelfView
          books={books}
          desktop={desktop}
          importing={importing}
          error={error}
          isDragOver={isDragOver}
          onImport={handleImport}
          onOpen={handleOpenBook}
          onDelete={handleDeleteBook}
          onOpenSettings={() => setShowSettings(true)}
          onOpenSync={() => setShowSync(true)}
        />
      )}

      <SettingsPanel
        open={showSettings}
        settings={settings}
        onClose={() => setShowSettings(false)}
        onChange={updateSettings}
        defaults={DEFAULT_SETTINGS}
      />

      <SyncModal
        open={showSync}
        onClose={() => setShowSync(false)}
        onSynced={() => void refreshBooks()}
      />

      {pendingDelete && (
        <div className="settings-backdrop" onClick={() => setPendingDelete(null)}>
          <div
            className="confirm-dialog"
            role="dialog"
            aria-label="移除书籍"
            onClick={(event) => event.stopPropagation()}
          >
            <h2>从书架移除？</h2>
            <p>
              《{pendingDelete.title}》的书籍文件、批注与阅读进度都会被删除，且无法恢复。
            </p>
            <div className="confirm-dialog__actions">
              <button
                type="button"
                className="confirm-dialog__cancel"
                onClick={() => setPendingDelete(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="confirm-dialog__danger"
                onClick={confirmDeleteBook}
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

import { convertFileSrc } from '@tauri-apps/api/core';
import { appDataDir, basename, join } from '@tauri-apps/api/path';
import { open } from '@tauri-apps/plugin-dialog';
import {
  BaseDirectory,
  mkdir,
  readFile,
  remove,
  writeFile,
} from '@tauri-apps/plugin-fs';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { BookRecord } from '../types';
import { parseEpubFile, readEpubEntry } from '../utils/epubLoader';
import { insertBook, markBookOpened } from './db';

export function isDesktop(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

// pdf.js is ~1MB of JS; only pull it in when a PDF is actually inspected so
// the bookshelf stays light.
type PdfModule = typeof import('pdfjs-dist');
let pdfModulePromise: Promise<PdfModule> | null = null;

function loadPdfjs(): Promise<PdfModule> {
  if (!pdfModulePromise) {
    pdfModulePromise = import('pdfjs-dist').then((module) => {
      module.GlobalWorkerOptions.workerSrc = new URL(
        'pdfjs-dist/build/pdf.worker.min.mjs',
        import.meta.url
      ).toString();
      return module;
    });
  }
  return pdfModulePromise;
}

const EPUB_MIME = 'application/epub+zip';
const PDF_MIME = 'application/pdf';

async function ensureLibraryDirs(): Promise<void> {
  await mkdir('books', { baseDir: BaseDirectory.AppData, recursive: true });
  await mkdir('covers', { baseDir: BaseDirectory.AppData, recursive: true });
}

function newBookId(): string {
  return `book-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function inspectPdf(file: File): Promise<{
  title: string;
  author: string;
  cover: Blob | null;
}> {
  const pdfjs = await loadPdfjs();
  const loadingTask = pdfjs.getDocument({ data: await file.arrayBuffer() });
  let doc: PDFDocumentProxy | null = null;
  try {
    doc = await loadingTask.promise;
    const meta = await doc.getMetadata().catch(() => null);
    const info = meta?.info as { Title?: string; Author?: string } | undefined;

    const page = await doc.getPage(1);
    const baseViewport = page.getViewport({ scale: 1 });
    // Thumbnail-sized cover keeps the shelf light: ~360px wide JPEG.
    const viewport = page.getViewport({ scale: 360 / baseViewport.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    const ctx = canvas.getContext('2d');
    let cover: Blob | null = null;
    if (ctx) {
      await page.render({ canvasContext: ctx, viewport, canvas }).promise;
      cover = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/jpeg', 0.82)
      );
    }
    canvas.width = 0;
    canvas.height = 0;
    page.cleanup();

    return {
      title: info?.Title?.trim() || file.name.replace(/\.pdf$/i, ''),
      author: info?.Author?.trim() || '',
      cover,
    };
  } finally {
    await loadingTask.destroy();
  }
}

/**
 * Shelf covers are decoded at display size, so every cover is re-encoded to a
 * small JPEG. Keeps memory flat no matter how large the original cover is.
 */
async function toShelfCover(bytes: Uint8Array, mime: string): Promise<Uint8Array | null> {
  try {
    const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
    try {
      const scale = Math.min(1, 480 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const output = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/jpeg', 0.84)
      );
      canvas.width = 0;
      canvas.height = 0;
      return output ? new Uint8Array(await output.arrayBuffer()) : null;
    } finally {
      bitmap.close();
    }
  } catch {
    // SVG covers (or unsupported codecs) keep their original bytes.
    return null;
  }
}

/**
 * Validates a book file at the given path (or Android content:// URI), copies
 * it into the app data folder, and records it in SQLite.
 */
export async function importBookFromPath(sourcePath: string): Promise<BookRecord> {
  const rawBaseName = await basename(sourcePath).catch(() => 'book');
  const fileName = decodeURIComponent(rawBaseName);
  const bytes = await readFile(sourcePath);

  const lower = fileName.toLowerCase();
  let format: 'pdf' | 'epub' | null = lower.endsWith('.pdf')
    ? 'pdf'
    : lower.endsWith('.epub')
      ? 'epub'
      : null;

  // Android Storage Access Framework URIs (content://...) may omit file extensions;
  // fall back to magic bytes (%PDF- vs ZIP PK\x03\x04).
  if (!format && bytes.length >= 4) {
    if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
      format = 'pdf';
    } else if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
      format = 'epub';
    }
  }

  if (!format) {
    throw new Error('请选择 .epub 或 .pdf 文件');
  }

  const file = new File([bytes], fileName, {
    type: format === 'pdf' ? PDF_MIME : EPUB_MIME,
  });

  const id = newBookId();
  let title = fileName.replace(/\.(epub|pdf)$/i, '') || '未命名书籍';
  let author = '';
  let totalParagraphs = 0;
  let coverBytes: Uint8Array | null = null;
  let coverExt = 'jpg';

  if (format === 'epub') {
    const parsed = await parseEpubFile({ file });
    title = parsed.title;
    author = parsed.author;
    totalParagraphs = parsed.paragraphs.length;
    if (parsed.coverPath) {
      const cover = await readEpubEntry({ file }, parsed.coverPath);
      if (cover) {
        const normalized = await toShelfCover(cover.bytes, cover.mime);
        if (normalized) {
          coverBytes = normalized;
          coverExt = 'jpg';
        } else {
          coverBytes = cover.bytes;
          coverExt = parsed.coverPath.split('.').pop()?.toLowerCase() || 'jpg';
        }
      }
    }
  } else {
    const inspected = await inspectPdf(file);
    title = inspected.title;
    author = inspected.author;
    if (inspected.cover) {
      coverBytes = new Uint8Array(await inspected.cover.arrayBuffer());
      coverExt = 'jpg';
    }
  }

  await ensureLibraryDirs();

  const fileNameOnDisk = `books/${id}.${format}`;
  await writeFile(fileNameOnDisk, bytes, {
    baseDir: BaseDirectory.AppData,
  });

  let coverPath: string | null = null;
  if (coverBytes) {
    coverPath = `covers/${id}.${coverExt}`;
    await writeFile(coverPath, coverBytes, { baseDir: BaseDirectory.AppData });
  }

  const book: BookRecord = {
    id,
    title,
    author,
    format,
    filePath: fileNameOnDisk,
    coverPath,
    totalParagraphs,
    addedAt: Date.now(),
    lastOpenedAt: null,
    progress: 0,
    locator: null,
  };
  await insertBook(book);
  return book;
}

/**
 * Opens a file dialog, validates the book, copies it into the app data folder
 * and records it in SQLite. Returns null when the user cancels.
 */
export async function importBookFromDisk(): Promise<BookRecord | null> {
  const selected = await open({
    multiple: false,
    directory: false,
    filters: [
      { name: '电子书', extensions: ['epub', 'pdf'] },
      { name: 'EPUB', extensions: ['epub'] },
      { name: 'PDF', extensions: ['pdf'] },
    ],
  });
  if (!selected || Array.isArray(selected)) return null;
  return importBookFromPath(selected);
}

export async function getCoverUrl(book: BookRecord): Promise<string | null> {
  if (!book.coverPath) return null;
  const absolute = await join(await appDataDir(), book.coverPath);
  return convertFileSrc(absolute);
}

export async function markBookOpenedNow(book: BookRecord): Promise<void> {
  book.lastOpenedAt = Date.now();
  await markBookOpened(book.id, book.lastOpenedAt);
}

export async function deleteBookFromDisk(book: BookRecord): Promise<void> {
  await remove(book.filePath, { baseDir: BaseDirectory.AppData }).catch(() => {});
  if (book.coverPath) {
    await remove(book.coverPath, { baseDir: BaseDirectory.AppData }).catch(() => {});
  }
}

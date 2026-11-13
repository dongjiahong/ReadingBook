import Database from '@tauri-apps/plugin-sql';
import type { BookAnnotations, BookRecord, ReaderSettings } from '../types';

const DB_URL = 'sqlite:readingbook.db';

let dbPromise: Promise<Database> | null = null;

function getDb(): Promise<Database> {
  if (!dbPromise) {
    dbPromise = Database.load(DB_URL).catch((err) => {
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

interface BookRow {
  id: string;
  title: string;
  author: string;
  format: string;
  file_path: string;
  cover_path: string | null;
  total_paragraphs: number;
  added_at: number;
  last_opened_at: number | null;
  progress: number;
  progress_locator: string | null;
}

function toBookRecord(row: BookRow): BookRecord {
  return {
    id: row.id,
    title: row.title,
    author: row.author,
    format: row.format === 'pdf' ? 'pdf' : 'epub',
    filePath: row.file_path,
    coverPath: row.cover_path,
    totalParagraphs: row.total_paragraphs,
    addedAt: row.added_at,
    lastOpenedAt: row.last_opened_at,
    progress: row.progress,
    locator: row.progress_locator,
  };
}

export async function listBooks(): Promise<BookRecord[]> {
  const db = await getDb();
  const rows = await db.select<BookRow[]>(
    'SELECT * FROM books ORDER BY COALESCE(last_opened_at, 0) DESC, added_at DESC'
  );
  return rows.map(toBookRecord);
}

export async function insertBook(book: BookRecord): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO books
       (id, title, author, format, file_path, cover_path, total_paragraphs,
        added_at, last_opened_at, progress, progress_locator)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      book.id,
      book.title,
      book.author,
      book.format,
      book.filePath,
      book.coverPath,
      book.totalParagraphs,
      book.addedAt,
      book.lastOpenedAt,
      book.progress,
      book.locator,
    ]
  );
}

export async function deleteBookRecord(id: string): Promise<void> {
  const db = await getDb();
  await db.execute('DELETE FROM book_annotations WHERE book_id = $1', [id]);
  await db.execute('DELETE FROM books WHERE id = $1', [id]);
}

export async function markBookOpened(id: string, timestamp: number): Promise<void> {
  const db = await getDb();
  await db.execute('UPDATE books SET last_opened_at = $1 WHERE id = $2', [
    timestamp,
    id,
  ]);
}

export async function updateBookProgress(
  id: string,
  progress: number,
  locator: string
): Promise<void> {
  const db = await getDb();
  await db.execute(
    'UPDATE books SET progress = $1, progress_locator = $2 WHERE id = $3',
    [progress, locator, id]
  );
}

export async function loadAnnotations(bookId: string): Promise<BookAnnotations | null> {
  const db = await getDb();
  const rows = await db.select<
    { anchors_json: string; cards_json: string; edges_json: string }[]
  >(
    'SELECT anchors_json, cards_json, edges_json FROM book_annotations WHERE book_id = $1',
    [bookId]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    anchors: JSON.parse(row.anchors_json),
    cards: JSON.parse(row.cards_json),
    edges: JSON.parse(row.edges_json),
  };
}

export async function saveAnnotations(
  bookId: string,
  annotations: BookAnnotations
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO book_annotations (book_id, anchors_json, cards_json, edges_json, updated_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT(book_id) DO UPDATE SET
       anchors_json = excluded.anchors_json,
       cards_json = excluded.cards_json,
       edges_json = excluded.edges_json,
       updated_at = excluded.updated_at`,
    [
      bookId,
      JSON.stringify(annotations.anchors),
      JSON.stringify(annotations.cards),
      JSON.stringify(annotations.edges),
      Date.now(),
    ]
  );
}

export async function loadSettings(): Promise<Partial<ReaderSettings> | null> {
  const db = await getDb();
  const rows = await db.select<{ value: string }[]>(
    "SELECT value FROM settings WHERE key = 'reader'"
  );
  if (!rows[0]) return null;
  try {
    return JSON.parse(rows[0].value) as Partial<ReaderSettings>;
  } catch {
    return null;
  }
}

export async function saveSettings(settings: ReaderSettings): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO settings (key, value) VALUES ('reader', $1)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [JSON.stringify(settings)]
  );
}

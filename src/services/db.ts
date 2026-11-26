import Database from '@tauri-apps/plugin-sql';
import type {
  AnnotationCardItem,
  AnnotationStyle,
  AnchorColor,
  BookAnchor,
  BookAnnotations,
  BookRecord,
  CardEdge,
  CardImage,
  CardKind,
  DocFormat,
  NormalizedPdfRect,
  ReaderSettings,
} from '../types';

const DB_URL = 'sqlite:readingbook.db';

export type LocalDataChangeKind = 'content' | 'progress' | 'layout';

type LocalChangeListener = (event: { kind: LocalDataChangeKind; bookId?: string }) => void;
const localChangeListeners = new Set<LocalChangeListener>();

export function subscribeLocalDataChange(listener: LocalChangeListener): () => void {
  localChangeListeners.add(listener);
  return () => {
    localChangeListeners.delete(listener);
  };
}

function emitLocalDataChange(kind: LocalDataChangeKind, bookId?: string): void {
  for (const listener of localChangeListeners) {
    try {
      listener({ kind, bookId });
    } catch {
      // ignore listener errors
    }
  }
}

let dbPromise: Promise<Database> | null = null;
const saveQueues = new Map<string, Promise<void>>();

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
  file_sha256: string | null;
  cover_path: string | null;
  cover_sha256: string | null;
  total_paragraphs: number;
  added_at: number;
  last_opened_at: number | null;
  progress: number;
  progress_locator: string | null;
  progress_updated_at: number | null;
  tts_locator: string | null;
  updated_at: number;
  deleted_at: number | null;
}

interface AnchorRow {
  id: string;
  book_id: string;
  doc_format: string | null;
  paragraph_id: string;
  epub_cfi: string | null;
  pdf_page: number | null;
  pdf_rects_json: string | null;
  quote: string;
  start_offset: number;
  end_offset: number;
  style: string;
  color: string | null;
  badge_number: number;
  kind: string;
  target_node_id: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

interface CardRow {
  id: string;
  book_id: string;
  anchor_id: string | null;
  kind: string;
  badge_number: number | null;
  body: string;
  images_json: string;
  status: string | null;
  collapsed: number;
  x: number;
  y: number;
  width: number | null;
  anchor_offset_y: number | null;
  needs_layout: number;
  layout_updated_at: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

interface EdgeRow {
  id: string;
  book_id: string;
  source_card_id: string;
  target_card_id: string;
  color: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

function toBookRecord(row: BookRow): BookRecord {
  return {
    id: row.id,
    title: row.title,
    author: row.author,
    format: row.format === 'pdf' ? 'pdf' : 'epub',
    filePath: row.file_path,
    fileSha256: row.file_sha256,
    coverPath: row.cover_path,
    coverSha256: row.cover_sha256,
    totalParagraphs: row.total_paragraphs,
    addedAt: row.added_at,
    lastOpenedAt: row.last_opened_at,
    progress: row.progress,
    locator: row.progress_locator,
    progressUpdatedAt: row.progress_updated_at,
    ttsLocator: row.tts_locator,
    updatedAt: row.updated_at,
  };
}

function toBookAnchor(row: AnchorRow): BookAnchor {
  let pdfRects: NormalizedPdfRect[] | undefined;
  if (row.pdf_rects_json) {
    try {
      const parsed = JSON.parse(row.pdf_rects_json) as NormalizedPdfRect[];
      if (Array.isArray(parsed) && parsed.length > 0) pdfRects = parsed;
    } catch {
      pdfRects = undefined;
    }
  }
  const anchor: BookAnchor = {
    id: row.id,
    paragraphId: row.paragraph_id,
    quote: row.quote,
    startOffset: row.start_offset,
    endOffset: row.end_offset,
    style: (row.style || 'highlight') as AnnotationStyle,
    badgeNumber: row.badge_number,
    kind: (row.kind || 'thought') as CardKind,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.doc_format) anchor.docFormat = row.doc_format as DocFormat;
  if (row.epub_cfi) anchor.epubCfi = row.epub_cfi;
  if (row.pdf_page !== null && row.pdf_page !== undefined) anchor.pdfPage = row.pdf_page;
  if (pdfRects) anchor.pdfRects = pdfRects;
  if (row.color) anchor.color = row.color as AnchorColor;
  if (row.target_node_id) anchor.targetNodeId = row.target_node_id;
  return anchor;
}

function toCardItem(row: CardRow): AnnotationCardItem {
  let images: CardImage[] | undefined;
  if (row.images_json && row.images_json !== '[]') {
    try {
      const parsed = JSON.parse(row.images_json) as CardImage[];
      if (Array.isArray(parsed) && parsed.length > 0) images = parsed;
    } catch {
      images = undefined;
    }
  }
  const card: AnnotationCardItem = {
    id: row.id,
    x: row.x,
    y: row.y,
    kind: (row.kind || 'thought') as CardKind,
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    layoutUpdatedAt: row.layout_updated_at,
  };
  if (row.badge_number !== null && row.badge_number !== undefined) {
    card.badgeNumber = row.badge_number;
  }
  if (images) card.images = images;
  if (row.status) card.status = row.status as AnnotationCardItem['status'];
  if (row.anchor_id) card.anchorId = row.anchor_id;
  if (row.anchor_offset_y !== null && row.anchor_offset_y !== undefined) {
    card.anchorOffsetY = row.anchor_offset_y;
  }
  if (row.collapsed) card.collapsed = true;
  if (row.width !== null && row.width !== undefined) card.width = row.width;
  if (row.needs_layout) card.needsLayout = true;
  return card;
}

function toCardEdge(row: EdgeRow): CardEdge {
  const edge: CardEdge = {
    id: row.id,
    source: row.source_card_id,
    target: row.target_card_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.color) edge.color = row.color;
  return edge;
}

function serializeImages(images?: CardImage[]): string {
  if (!images || images.length === 0) return '[]';
  const cleaned = images.map((img) => ({
    id: img.id,
    thumbUrl: '',
    width: img.width,
    height: img.height,
    ...(img.filePath ? { filePath: img.filePath } : {}),
    ...(img.thumbPath ? { thumbPath: img.thumbPath } : {}),
    ...(img.sha256 ? { sha256: img.sha256 } : {}),
  }));
  return JSON.stringify(cleaned);
}

function serializePdfRects(rects?: NormalizedPdfRect[]): string | null {
  if (!rects || rects.length === 0) return null;
  return JSON.stringify(rects);
}

function anchorChanged(prev: AnchorRow, next: BookAnchor, rectsJson: string | null): boolean {
  return (
    prev.deleted_at !== null ||
    (prev.doc_format ?? null) !== (next.docFormat ?? null) ||
    prev.paragraph_id !== next.paragraphId ||
    (prev.epub_cfi ?? null) !== (next.epubCfi ?? null) ||
    (prev.pdf_page ?? null) !== (next.pdfPage ?? null) ||
    (prev.pdf_rects_json ?? null) !== rectsJson ||
    prev.quote !== next.quote ||
    prev.start_offset !== next.startOffset ||
    prev.end_offset !== next.endOffset ||
    prev.style !== next.style ||
    (prev.color ?? null) !== (next.color ?? null) ||
    prev.badge_number !== next.badgeNumber ||
    prev.kind !== next.kind ||
    (prev.target_node_id ?? null) !== (next.targetNodeId ?? null)
  );
}

function cardContentChanged(
  prev: CardRow,
  next: AnnotationCardItem,
  imagesJson: string
): boolean {
  return (
    prev.deleted_at !== null ||
    (prev.anchor_id ?? null) !== (next.anchorId ?? null) ||
    prev.kind !== next.kind ||
    (prev.badge_number ?? null) !== (next.badgeNumber ?? null) ||
    prev.body !== next.body ||
    prev.images_json !== imagesJson ||
    (prev.status ?? null) !== (next.status ?? null) ||
    prev.collapsed !== (next.collapsed ? 1 : 0)
  );
}

function cardLayoutChanged(prev: CardRow, next: AnnotationCardItem): boolean {
  return (
    prev.x !== next.x ||
    prev.y !== next.y ||
    (prev.width ?? null) !== (next.width ?? null) ||
    (prev.anchor_offset_y ?? null) !== (next.anchorOffsetY ?? null) ||
    prev.needs_layout !== (next.needsLayout ? 1 : 0)
  );
}

function edgeChanged(prev: EdgeRow, next: CardEdge): boolean {
  return (
    prev.deleted_at !== null ||
    prev.source_card_id !== next.source ||
    prev.target_card_id !== next.target ||
    (prev.color ?? null) !== (next.color ?? null)
  );
}

export async function listBooks(): Promise<BookRecord[]> {
  const db = await getDb();
  const rows = await db.select<BookRow[]>(
    'SELECT * FROM books WHERE deleted_at IS NULL ORDER BY COALESCE(last_opened_at, 0) DESC, added_at DESC'
  );
  return rows.map(toBookRecord);
}

export async function insertBook(book: BookRecord): Promise<void> {
  const db = await getDb();
  const now = book.updatedAt ?? book.addedAt ?? Date.now();
  await db.execute(
    `INSERT INTO books
       (id, title, author, format, file_path, file_sha256, cover_path, cover_sha256,
        total_paragraphs, added_at, last_opened_at, progress, progress_locator,
        progress_updated_at, tts_locator, updated_at, deleted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NULL)`,
    [
      book.id,
      book.title,
      book.author,
      book.format,
      book.filePath,
      book.fileSha256 ?? null,
      book.coverPath,
      book.coverSha256 ?? null,
      book.totalParagraphs,
      book.addedAt,
      book.lastOpenedAt,
      book.progress,
      book.locator,
      book.progressUpdatedAt ?? null,
      book.ttsLocator ?? null,
      now,
    ]
  );
  emitLocalDataChange('content', book.id);
}

export async function deleteBookRecord(id: string): Promise<void> {
  const db = await getDb();
  const now = Date.now();
  await db.execute(
    'UPDATE anchors SET deleted_at = $1, updated_at = $1 WHERE book_id = $2 AND deleted_at IS NULL',
    [now, id]
  );
  await db.execute(
    'UPDATE cards SET deleted_at = $1, updated_at = $1 WHERE book_id = $2 AND deleted_at IS NULL',
    [now, id]
  );
  await db.execute(
    'UPDATE edges SET deleted_at = $1, updated_at = $1 WHERE book_id = $2 AND deleted_at IS NULL',
    [now, id]
  );
  await db.execute(
    'UPDATE books SET deleted_at = $1, updated_at = $1 WHERE id = $2',
    [now, id]
  );
  emitLocalDataChange('content', id);
}

export async function markBookOpened(id: string, timestamp: number): Promise<void> {
  const db = await getDb();
  await db.execute(
    'UPDATE books SET last_opened_at = $1, updated_at = $1 WHERE id = $2',
    [timestamp, id]
  );
}

export async function updateBookProgress(
  id: string,
  progress: number,
  locator: string
): Promise<void> {
  const db = await getDb();
  const now = Date.now();
  await db.execute(
    'UPDATE books SET progress = $1, progress_locator = $2, progress_updated_at = $3, updated_at = $3 WHERE id = $4',
    [progress, locator, now, id]
  );
  emitLocalDataChange('progress', id);
}

export async function updateBookTtsLocator(
  id: string,
  ttsLocator: string | null
): Promise<void> {
  const db = await getDb();
  const now = Date.now();
  await db.execute(
    'UPDATE books SET tts_locator = $1, updated_at = $2 WHERE id = $3',
    [ttsLocator, now, id]
  );
  emitLocalDataChange('progress', id);
}

export async function loadAnnotations(bookId: string): Promise<BookAnnotations | null> {
  const db = await getDb();
  const [anchorRows, cardRows, edgeRows] = await Promise.all([
    db.select<AnchorRow[]>(
      'SELECT * FROM anchors WHERE book_id = $1 AND deleted_at IS NULL ORDER BY created_at ASC, id ASC',
      [bookId]
    ),
    db.select<CardRow[]>(
      'SELECT * FROM cards WHERE book_id = $1 AND deleted_at IS NULL ORDER BY created_at ASC, id ASC',
      [bookId]
    ),
    db.select<EdgeRow[]>(
      'SELECT * FROM edges WHERE book_id = $1 AND deleted_at IS NULL ORDER BY created_at ASC, id ASC',
      [bookId]
    ),
  ]);
  if (anchorRows.length === 0 && cardRows.length === 0 && edgeRows.length === 0) {
    return null;
  }
  return {
    anchors: anchorRows.map(toBookAnchor),
    cards: cardRows.map(toCardItem),
    edges: edgeRows.map(toCardEdge),
  };
}

export interface BookAnnotationsSummary {
  bookId: string;
  bookTitle: string;
  annotations: BookAnnotations;
}

export async function loadAllBookAnnotations(): Promise<BookAnnotationsSummary[]> {
  const db = await getDb();
  const [bookRows, anchorRows, cardRows, edgeRows] = await Promise.all([
    db.select<{ id: string; title: string }[]>(
      'SELECT id, title FROM books WHERE deleted_at IS NULL ORDER BY updated_at DESC'
    ),
    db.select<AnchorRow[]>(
      'SELECT * FROM anchors WHERE deleted_at IS NULL ORDER BY created_at ASC, id ASC'
    ),
    db.select<CardRow[]>(
      'SELECT * FROM cards WHERE deleted_at IS NULL ORDER BY created_at ASC, id ASC'
    ),
    db.select<EdgeRow[]>(
      'SELECT * FROM edges WHERE deleted_at IS NULL ORDER BY created_at ASC, id ASC'
    ),
  ]);

  const byBook = new Map<string, BookAnnotations>();
  const ensure = (bookId: string): BookAnnotations => {
    let entry = byBook.get(bookId);
    if (!entry) {
      entry = { anchors: [], cards: [], edges: [] };
      byBook.set(bookId, entry);
    }
    return entry;
  };

  for (const row of anchorRows) ensure(row.book_id).anchors.push(toBookAnchor(row));
  for (const row of cardRows) ensure(row.book_id).cards.push(toCardItem(row));
  for (const row of edgeRows) ensure(row.book_id).edges.push(toCardEdge(row));

  const results: BookAnnotationsSummary[] = [];
  for (const book of bookRows) {
    const ann = byBook.get(book.id);
    if (!ann) continue;
    results.push({
      bookId: book.id,
      bookTitle: book.title,
      annotations: ann,
    });
  }
  return results;
}

async function performSaveAnnotations(
  bookId: string,
  annotations: BookAnnotations
): Promise<void> {
  const db = await getDb();
  const now = Date.now();

  const [existingAnchors, existingCards, existingEdges] = await Promise.all([
    db.select<AnchorRow[]>('SELECT * FROM anchors WHERE book_id = $1', [bookId]),
    db.select<CardRow[]>('SELECT * FROM cards WHERE book_id = $1', [bookId]),
    db.select<EdgeRow[]>('SELECT * FROM edges WHERE book_id = $1', [bookId]),
  ]);

  const anchorMap = new Map(existingAnchors.map((r) => [r.id, r]));
  const cardMap = new Map(existingCards.map((r) => [r.id, r]));
  const edgeMap = new Map(existingEdges.map((r) => [r.id, r]));

  const nextAnchorIds = new Set<string>();
  const nextCardIds = new Set<string>();
  const nextEdgeIds = new Set<string>();
  let hasContentChange = false;
  let hasLayoutChange = false;

  for (const anchor of annotations.anchors) {
    nextAnchorIds.add(anchor.id);
    const rectsJson = serializePdfRects(anchor.pdfRects);
    const prev = anchorMap.get(anchor.id);
    if (!prev) {
      const createdAt = anchor.createdAt ?? now;
      await db.execute(
        `INSERT INTO anchors
           (id, book_id, doc_format, paragraph_id, epub_cfi, pdf_page, pdf_rects_json,
            quote, start_offset, end_offset, style, color, badge_number, kind,
            target_node_id, created_at, updated_at, deleted_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NULL)`,
        [
          anchor.id,
          bookId,
          anchor.docFormat ?? null,
          anchor.paragraphId,
          anchor.epubCfi ?? null,
          anchor.pdfPage ?? null,
          rectsJson,
          anchor.quote,
          anchor.startOffset,
          anchor.endOffset,
          anchor.style,
          anchor.color ?? null,
          anchor.badgeNumber,
          anchor.kind,
          anchor.targetNodeId ?? null,
          createdAt,
          now,
        ]
      );
      hasContentChange = true;
    } else if (anchorChanged(prev, anchor, rectsJson)) {
      await db.execute(
        `UPDATE anchors SET
           doc_format = $1, paragraph_id = $2, epub_cfi = $3, pdf_page = $4,
           pdf_rects_json = $5, quote = $6, start_offset = $7, end_offset = $8,
           style = $9, color = $10, badge_number = $11, kind = $12,
           target_node_id = $13, updated_at = $14, deleted_at = NULL
         WHERE id = $15`,
        [
          anchor.docFormat ?? null,
          anchor.paragraphId,
          anchor.epubCfi ?? null,
          anchor.pdfPage ?? null,
          rectsJson,
          anchor.quote,
          anchor.startOffset,
          anchor.endOffset,
          anchor.style,
          anchor.color ?? null,
          anchor.badgeNumber,
          anchor.kind,
          anchor.targetNodeId ?? null,
          now,
          anchor.id,
        ]
      );
      hasContentChange = true;
    }
  }

  for (const prev of existingAnchors) {
    if (prev.deleted_at === null && !nextAnchorIds.has(prev.id)) {
      await db.execute(
        'UPDATE anchors SET deleted_at = $1, updated_at = $1 WHERE id = $2',
        [now, prev.id]
      );
      hasContentChange = true;
    }
  }

  for (const card of annotations.cards) {
    nextCardIds.add(card.id);
    const imagesJson = serializeImages(card.images);
    const prev = cardMap.get(card.id);
    if (!prev) {
      const createdAt = card.createdAt ?? now;
      await db.execute(
        `INSERT INTO cards
           (id, book_id, anchor_id, kind, badge_number, body, images_json, status,
            collapsed, x, y, width, anchor_offset_y, needs_layout, layout_updated_at,
            created_at, updated_at, deleted_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NULL)`,
        [
          card.id,
          bookId,
          card.anchorId ?? null,
          card.kind,
          card.badgeNumber ?? null,
          card.body,
          imagesJson,
          card.status ?? null,
          card.collapsed ? 1 : 0,
          card.x,
          card.y,
          card.width ?? null,
          card.anchorOffsetY ?? null,
          card.needsLayout ? 1 : 0,
          card.layoutUpdatedAt ?? now,
          createdAt,
          now,
        ]
      );
      hasContentChange = true;
    } else {
      const contentDiff = cardContentChanged(prev, card, imagesJson);
      const layoutDiff = cardLayoutChanged(prev, card);
      if (contentDiff || layoutDiff) {
        const nextUpdatedAt = contentDiff ? now : prev.updated_at;
        const nextLayoutUpdatedAt = layoutDiff ? now : prev.layout_updated_at;
        await db.execute(
          `UPDATE cards SET
             anchor_id = $1, kind = $2, badge_number = $3, body = $4,
             images_json = $5, status = $6, collapsed = $7,
             x = $8, y = $9, width = $10, anchor_offset_y = $11, needs_layout = $12,
             layout_updated_at = $13, updated_at = $14, deleted_at = NULL
           WHERE id = $15`,
          [
            card.anchorId ?? null,
            card.kind,
            card.badgeNumber ?? null,
            card.body,
            imagesJson,
            card.status ?? null,
            card.collapsed ? 1 : 0,
            card.x,
            card.y,
            card.width ?? null,
            card.anchorOffsetY ?? null,
            card.needsLayout ? 1 : 0,
            nextLayoutUpdatedAt,
            nextUpdatedAt,
            card.id,
          ]
        );
        if (contentDiff) hasContentChange = true;
        else hasLayoutChange = true;
      }
    }
  }

  for (const prev of existingCards) {
    if (prev.deleted_at === null && !nextCardIds.has(prev.id)) {
      await db.execute(
        'UPDATE cards SET deleted_at = $1, updated_at = $1 WHERE id = $2',
        [now, prev.id]
      );
      hasContentChange = true;
    }
  }

  for (const edge of annotations.edges) {
    nextEdgeIds.add(edge.id);
    const prev = edgeMap.get(edge.id);
    if (!prev) {
      const createdAt = edge.createdAt ?? now;
      await db.execute(
        `INSERT INTO edges
           (id, book_id, source_card_id, target_card_id, color, created_at, updated_at, deleted_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NULL)`,
        [edge.id, bookId, edge.source, edge.target, edge.color ?? null, createdAt, now]
      );
      hasContentChange = true;
    } else if (edgeChanged(prev, edge)) {
      await db.execute(
        `UPDATE edges SET
           source_card_id = $1, target_card_id = $2, color = $3,
           updated_at = $4, deleted_at = NULL
         WHERE id = $5`,
        [edge.source, edge.target, edge.color ?? null, now, edge.id]
      );
      hasContentChange = true;
    }
  }

  for (const prev of existingEdges) {
    if (prev.deleted_at === null && !nextEdgeIds.has(prev.id)) {
      await db.execute(
        'UPDATE edges SET deleted_at = $1, updated_at = $1 WHERE id = $2',
        [now, prev.id]
      );
      hasContentChange = true;
    }
  }

  if (hasContentChange) {
    emitLocalDataChange('content', bookId);
  } else if (hasLayoutChange) {
    emitLocalDataChange('layout', bookId);
  }
}

export async function saveAnnotations(
  bookId: string,
  annotations: BookAnnotations
): Promise<void> {
  const prev = saveQueues.get(bookId) ?? Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(() => performSaveAnnotations(bookId, annotations));
  saveQueues.set(bookId, next);
  try {
    await next;
  } finally {
    if (saveQueues.get(bookId) === next) {
      saveQueues.delete(bookId);
    }
  }
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

export interface ReferencedImageRefs {
  ids: Set<string>;
  filenames: Set<string>;
}

/**
 * 收集数据库中所有未删除书籍、未删除卡片正在引用的图片 ID 与文件名，
 * 供孤儿图片垃圾回收比对使用。
 */
export async function listReferencedImageRefs(): Promise<ReferencedImageRefs> {
  const db = await getDb();
  const rows = await db.select<{ images_json: string }[]>(
    `SELECT c.images_json
     FROM cards c
     INNER JOIN books b ON b.id = c.book_id
     WHERE c.deleted_at IS NULL
       AND b.deleted_at IS NULL
       AND c.images_json IS NOT NULL
       AND c.images_json != ''
       AND c.images_json != '[]'`
  );

  const ids = new Set<string>();
  const filenames = new Set<string>();

  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.images_json) as Partial<CardImage>[];
      if (!Array.isArray(parsed)) continue;
      for (const img of parsed) {
        if (typeof img?.id === 'string' && img.id.length > 0) {
          ids.add(img.id);
        }
        if (typeof img?.filePath === 'string' && img.filePath.length > 0) {
          const base = img.filePath.split('/').pop();
          if (base) filenames.add(base);
        }
        if (typeof img?.thumbPath === 'string' && img.thumbPath.length > 0) {
          const base = img.thumbPath.split('/').pop();
          if (base) filenames.add(base);
        }
      }
    } catch {
      // 忽略单行异常 JSON，不影响其余记录
    }
  }

  return { ids, filenames };
}

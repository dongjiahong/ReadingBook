/**
 * Persistent TTS MP3 audio cache backed by IndexedDB.
 *
 * Eviction policy:
 * - Unplayed prefetched chunks (`playedAt === null`) are kept until played.
 * - Once a chunk finishes playing, `playedAt` is stamped; it is automatically
 *   deleted 2 hours (`PLAYED_TTL_MS`) after playback.
 */

const DB_NAME = 'readingbook-tts-cache';
const DB_VERSION = 1;
const STORE_NAME = 'chunks';
export const PLAYED_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

interface CachedTtsChunk {
  key: string;
  bookId: string;
  voice: string;
  blob: Blob;
  createdAt: number;
  playedAt: number | null;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openCacheDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
          store.createIndex('playedAt', 'playedAt', { unique: false });
          store.createIndex('bookId', 'bookId', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

export function buildTtsCacheKey(
  bookId: string,
  voice: string,
  paragraphId: string,
  sentenceInParagraph: number
): string {
  return `${bookId}|${voice}|${paragraphId}|${sentenceInParagraph}`;
}

export async function getCachedTtsBlob(key: string): Promise<Blob | null> {
  const db = await openCacheDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => {
        const rec = req.result as CachedTtsChunk | undefined;
        if (!rec) {
          resolve(null);
          return;
        }
        // If already past 2h played TTL, treat as expired
        if (rec.playedAt !== null && Date.now() - rec.playedAt >= PLAYED_TTL_MS) {
          resolve(null);
          return;
        }
        resolve(rec.blob);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function putCachedTtsBlob(
  key: string,
  bookId: string,
  voice: string,
  blob: Blob
): Promise<void> {
  const db = await openCacheDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const record: CachedTtsChunk = {
        key,
        bookId,
        voice,
        blob,
        createdAt: Date.now(),
        playedAt: null,
      };
      tx.objectStore(STORE_NAME).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function markTtsChunkPlayed(key: string): Promise<void> {
  const db = await openCacheDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const getReq = store.get(key);
      getReq.onsuccess = () => {
        const rec = getReq.result as CachedTtsChunk | undefined;
        if (rec && rec.playedAt === null) {
          rec.playedAt = Date.now();
          store.put(rec);
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

/**
 * Deletes only chunks that have been played AND whose `playedAt` is older than 2 hours.
 * Unplayed prefetched chunks (`playedAt === null`) are untouched.
 */
export async function pruneExpiredTtsCache(now = Date.now()): Promise<number> {
  const db = await openCacheDb();
  if (!db) return 0;
  const cutoff = now - PLAYED_TTL_MS;
  return new Promise((resolve) => {
    let deleted = 0;
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const cursorReq = store.openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) return;
        const rec = cursor.value as CachedTtsChunk;
        if (rec.playedAt !== null && rec.playedAt <= cutoff) {
          cursor.delete();
          deleted += 1;
        }
        cursor.continue();
      };
      tx.oncomplete = () => resolve(deleted);
      tx.onerror = () => resolve(deleted);
      tx.onabort = () => resolve(deleted);
    } catch {
      resolve(0);
    }
  });
}

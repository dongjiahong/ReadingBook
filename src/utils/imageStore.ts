import type { AnnotationCardItem, CardImage } from '../types';

const DB_NAME = 'readingbook-images';
const DB_VERSION = 1;
const STORE_NAME = 'images';
const THUMB_MAX_EDGE = 480;
const THUMB_TYPE = 'image/webp';
const THUMB_QUALITY = 0.84;

interface StoredImage {
  id: string;
  full: Blob;
  thumb: Blob;
  width: number;
  height: number;
  createdAt: number;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;
let useMemoryFallback = false;
const memoryImages = new Map<string, StoredImage>();
const thumbUrls = new Map<string, string>();

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      useMemoryFallback = true;
      resolve(null);
      return;
    }

    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        useMemoryFallback = true;
        resolve(null);
      };
      request.onblocked = () => {
        useMemoryFallback = true;
        resolve(null);
      };
    } catch {
      useMemoryFallback = true;
      resolve(null);
    }
  });

  return dbPromise;
}

async function putImage(record: StoredImage): Promise<void> {
  const db = await openDb();
  if (!db || useMemoryFallback) {
    memoryImages.set(record.id, record);
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function getImage(id: string): Promise<StoredImage | undefined> {
  const db = await openDb();
  if (!db || useMemoryFallback) {
    return memoryImages.get(id);
  }

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get(id);
    request.onsuccess = () => resolve(request.result as StoredImage | undefined);
    request.onerror = () => reject(request.error);
  });
}

async function deleteImage(id: string): Promise<void> {
  const db = await openDb();
  if (!db || useMemoryFallback) {
    memoryImages.delete(id);
    return;
  }

  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('缩略图生成失败'));
      },
      type,
      quality
    );
  });
}

async function makeThumbnail(file: Blob): Promise<{
  blob: Blob;
  width: number;
  height: number;
}> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, THUMB_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建缩略图画布');
    ctx.drawImage(bitmap, 0, 0, width, height);

    return {
      blob: await canvasToBlob(canvas, THUMB_TYPE, THUMB_QUALITY),
      width: bitmap.width,
      height: bitmap.height,
    };
  } finally {
    bitmap.close();
  }
}

export async function importImageFiles(files: FileList | File[]): Promise<CardImage[]> {
  const imageFiles = Array.from(files).filter((file) => file.type.startsWith('image/'));
  const imported: CardImage[] = [];

  // Decode one image at a time so a multi-image paste does not spike memory.
  for (const file of imageFiles) {
    try {
      const { blob: thumb, width, height } = await makeThumbnail(file);
      const id = `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const record: StoredImage = {
        id,
        full: file,
        thumb,
        width,
        height,
        createdAt: Date.now(),
      };

      await putImage(record);

      const thumbUrl = URL.createObjectURL(thumb);
      thumbUrls.set(id, thumbUrl);
      imported.push({ id, thumbUrl, width, height });
    } catch (err) {
      console.warn('图片导入失败', err);
    }
  }

  return imported;
}

export async function createFullImageUrl(id: string): Promise<string | null> {
  try {
    const record = await getImage(id);
    return record ? URL.createObjectURL(record.full) : null;
  } catch (err) {
    console.warn('读取原图失败', err);
    return null;
  }
}

export function releaseImage(id: string): void {
  const url = thumbUrls.get(id);
  if (url) {
    URL.revokeObjectURL(url);
    thumbUrls.delete(id);
  }
  void deleteImage(id).catch(() => {});
}

/**
 * Cards persisted in SQLite keep only image ids, so object URLs are rebuilt
 * from IndexedDB each time a book is reopened. Missing records are dropped.
 */
export async function restoreThumbUrls(
  cards: AnnotationCardItem[]
): Promise<AnnotationCardItem[]> {
  const restored: AnnotationCardItem[] = [];
  for (const card of cards) {
    if (!card.images?.length) {
      restored.push(card);
      continue;
    }
    const images: CardImage[] = [];
    for (const image of card.images) {
      try {
        const record = await getImage(image.id);
        if (!record) continue;
        let url = thumbUrls.get(image.id);
        if (!url) {
          url = URL.createObjectURL(record.thumb);
          thumbUrls.set(image.id, url);
        }
        images.push({
          id: image.id,
          thumbUrl: url,
          width: record.width,
          height: record.height,
        });
      } catch {
        // Skip images that can no longer be read.
      }
    }
    restored.push({ ...card, images });
  }
  return restored;
}


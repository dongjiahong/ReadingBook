import { convertFileSrc } from '@tauri-apps/api/core';
import { appDataDir, join } from '@tauri-apps/api/path';
import {
  BaseDirectory,
  exists,
  mkdir,
  readDir,
  remove,
  writeFile,
} from '@tauri-apps/plugin-fs';
import { isDesktop } from '../services/library';
import type { AnnotationCardItem, CardImage } from '../types';

const DB_NAME = 'readingbook-images';
const DB_VERSION = 1;
const STORE_NAME = 'images';
const IMAGES_DIR = 'images';
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
let appDataDirPromise: Promise<string> | null = null;
let imagesDirReadyPromise: Promise<void> | null = null;

function getAppDataDir(): Promise<string> {
  if (appDataDirPromise) return appDataDirPromise;
  const pending = appDataDir().catch((err: unknown) => {
    appDataDirPromise = null;
    throw err;
  });
  appDataDirPromise = pending;
  return pending;
}

function ensureImagesDir(): Promise<void> {
  if (imagesDirReadyPromise) return imagesDirReadyPromise;
  const pending = mkdir(IMAGES_DIR, {
    baseDir: BaseDirectory.AppData,
    recursive: true,
  }).catch((err: unknown) => {
    imagesDirReadyPromise = null;
    throw err;
  });
  imagesDirReadyPromise = pending;
  return pending;
}

function extFromMime(mime: string | undefined, fallback = 'png'): string {
  const normalized = (mime ?? '').toLowerCase().split(';')[0].trim();
  switch (normalized) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    case 'image/svg+xml':
      return 'svg';
    case 'image/bmp':
      return 'bmp';
    case 'image/avif':
      return 'avif';
    default:
      return fallback;
  }
}

async function toDesktopAssetUrl(relativePath: string): Promise<string> {
  const abs = await join(await getAppDataDir(), relativePath);
  return convertFileSrc(abs);
}

async function writeImageToDisk(
  id: string,
  full: Blob,
  thumb: Blob
): Promise<{ filePath: string; thumbPath: string }> {
  await ensureImagesDir();
  const fullExt = extFromMime(full.type, 'png');
  const thumbExt = extFromMime(thumb.type, 'png');
  const filePath = `${IMAGES_DIR}/${id}.${fullExt}`;
  const thumbPath = `${IMAGES_DIR}/${id}.thumb.${thumbExt}`;

  const [fullBytes, thumbBytes] = await Promise.all([
    full.arrayBuffer(),
    thumb.arrayBuffer(),
  ]);

  await Promise.all([
    writeFile(filePath, new Uint8Array(fullBytes), {
      baseDir: BaseDirectory.AppData,
    }),
    writeFile(thumbPath, new Uint8Array(thumbBytes), {
      baseDir: BaseDirectory.AppData,
    }),
  ]);

  return { filePath, thumbPath };
}

async function findDiskImageFiles(
  id: string,
  entries?: string[]
): Promise<{ filePath?: string; thumbPath?: string }> {
  let names: string[];
  if (entries) {
    names = entries;
  } else {
    try {
      await ensureImagesDir();
      const dir = await readDir(IMAGES_DIR, { baseDir: BaseDirectory.AppData });
      names = dir
        .map((entry) => entry.name)
        .filter((n): n is string => typeof n === 'string' && n.length > 0);
    } catch {
      return {};
    }
  }

  let filePath: string | undefined;
  let thumbPath: string | undefined;
  const thumbPrefix = `${id}.thumb.`;
  const fullPrefix = `${id}.`;

  for (const name of names) {
    if (name.startsWith(thumbPrefix)) {
      thumbPath = `${IMAGES_DIR}/${name}`;
    } else if (name.startsWith(fullPrefix)) {
      filePath = `${IMAGES_DIR}/${name}`;
    }
  }
  return { filePath, thumbPath };
}

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

async function putImageInIdb(record: StoredImage): Promise<void> {
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

async function getImageFromIdb(id: string): Promise<StoredImage | undefined> {
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

async function deleteImageFromIdb(id: string): Promise<void> {
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

export function revokeObjectUrlIfBlob(url: string | null | undefined): void {
  if (url && url.startsWith('blob:')) {
    URL.revokeObjectURL(url);
  }
}

export async function importImageFiles(files: FileList | File[]): Promise<CardImage[]> {
  const imageFiles = Array.from(files).filter((file) => file.type.startsWith('image/'));
  const imported: CardImage[] = [];
  const desktop = isDesktop();

  // Decode one image at a time so a multi-image paste does not spike memory.
  for (const file of imageFiles) {
    try {
      const { blob: thumb, width, height } = await makeThumbnail(file);
      const id = `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      if (desktop) {
        const { filePath, thumbPath } = await writeImageToDisk(id, file, thumb);
        const thumbUrl = await toDesktopAssetUrl(thumbPath);
        imported.push({ id, thumbUrl, width, height, filePath, thumbPath });
      } else {
        const record: StoredImage = {
          id,
          full: file,
          thumb,
          width,
          height,
          createdAt: Date.now(),
        };
        await putImageInIdb(record);
        const thumbUrl = URL.createObjectURL(thumb);
        thumbUrls.set(id, thumbUrl);
        imported.push({ id, thumbUrl, width, height });
      }
    } catch (err) {
      console.warn('图片导入失败', err);
    }
  }

  return imported;
}

export async function createFullImageUrl(
  image: Pick<CardImage, 'id' | 'filePath'>
): Promise<string | null> {
  try {
    if (isDesktop()) {
      let fullPath = image.filePath;
      if (fullPath) {
        const ok = await exists(fullPath, { baseDir: BaseDirectory.AppData }).catch(
          () => false
        );
        if (!ok) fullPath = undefined;
      }
      if (!fullPath) {
        const found = await findDiskImageFiles(image.id);
        fullPath = found.filePath ?? found.thumbPath;
      }
      if (fullPath) {
        return await toDesktopAssetUrl(fullPath);
      }
    }

    const record = await getImageFromIdb(image.id);
    return record ? URL.createObjectURL(record.full) : null;
  } catch (err) {
    console.warn('读取原图失败', err);
    return null;
  }
}

/**
 * 仅释放内存中的 ObjectURL，不会删除磁盘或 IndexedDB 中持久化的图片。
 * 用于切换书籍、返回书架或组件卸载时的内存清理。
 */
export function revokeImageUrl(id: string): void {
  const url = thumbUrls.get(id);
  if (url) {
    revokeObjectUrlIfBlob(url);
    thumbUrls.delete(id);
  }
}

/**
 * 永久删除持久化存储的图片（磁盘文件与旧版 IndexedDB 记录），
 * 仅在用户主动移除图片、删除卡片或删除书籍时调用。
 */
export async function deleteStoredImage(
  image: Pick<CardImage, 'id' | 'filePath' | 'thumbPath'>
): Promise<void> {
  revokeImageUrl(image.id);

  if (isDesktop()) {
    const targets = new Set<string>();
    if (image.filePath) targets.add(image.filePath);
    if (image.thumbPath) targets.add(image.thumbPath);
    if (targets.size === 0) {
      const found = await findDiskImageFiles(image.id);
      if (found.filePath) targets.add(found.filePath);
      if (found.thumbPath) targets.add(found.thumbPath);
    }
    await Promise.all(
      Array.from(targets).map((path) =>
        remove(path, { baseDir: BaseDirectory.AppData }).catch(() => {})
      )
    );
  }

  await deleteImageFromIdb(image.id).catch(() => {});
}

/**
 * Rebuilds display URLs for persisted card images when opening a book.
 * On desktop, prefers `$APPDATA/images/` on disk and automatically migrates
 * any legacy IndexedDB records into `$APPDATA/images/`.
 */
export async function restoreThumbUrls(
  cards: AnnotationCardItem[]
): Promise<AnnotationCardItem[]> {
  const desktop = isDesktop();
  let diskEntries: string[] | undefined;

  if (desktop) {
    try {
      await ensureImagesDir();
      const dir = await readDir(IMAGES_DIR, { baseDir: BaseDirectory.AppData });
      diskEntries = dir
        .map((entry) => entry.name)
        .filter((name): name is string => Boolean(name));
    } catch {
      diskEntries = [];
    }
  }

  const restored: AnnotationCardItem[] = [];
  for (const card of cards) {
    if (!card.images?.length) {
      restored.push(card);
      continue;
    }

    const images: CardImage[] = [];
    for (const image of card.images) {
      try {
        if (desktop) {
          let filePath = image.filePath;
          let thumbPath = image.thumbPath;

          if (thumbPath && !(await exists(thumbPath, { baseDir: BaseDirectory.AppData }).catch(() => false))) {
            thumbPath = undefined;
          }
          if (filePath && !(await exists(filePath, { baseDir: BaseDirectory.AppData }).catch(() => false))) {
            filePath = undefined;
          }

          if (!thumbPath || !filePath) {
            const found = await findDiskImageFiles(image.id, diskEntries);
            filePath = filePath ?? found.filePath;
            thumbPath = thumbPath ?? found.thumbPath;
          }

          if (thumbPath || filePath) {
            const displayPath = thumbPath ?? filePath!;
            images.push({
              id: image.id,
              thumbUrl: await toDesktopAssetUrl(displayPath),
              width: image.width,
              height: image.height,
              filePath: filePath ?? displayPath,
              thumbPath: displayPath,
            });
            continue;
          }

          // 兼容旧版：尝试从 IndexedDB 迁移到 $APPDATA/images/
          const legacy = await getImageFromIdb(image.id).catch(() => undefined);
          if (legacy) {
            const migrated = await writeImageToDisk(image.id, legacy.full, legacy.thumb);
            const thumbUrl = await toDesktopAssetUrl(migrated.thumbPath);
            images.push({
              id: image.id,
              thumbUrl,
              width: legacy.width,
              height: legacy.height,
              filePath: migrated.filePath,
              thumbPath: migrated.thumbPath,
            });
            continue;
          }

          // 未找到图片文件时跳过，避免渲染损坏占位图
          continue;
        }

        const record = await getImageFromIdb(image.id);
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
      } catch (err) {
        console.warn('恢复卡片图片失败', image.id, err);
      }
    }
    restored.push({ ...card, images });
  }
  return restored;
}

function extractImageIdFromFilename(filename: string): string | null {
  const thumbIdx = filename.indexOf('.thumb.');
  if (thumbIdx > 0) return filename.slice(0, thumbIdx);
  const dotIdx = filename.lastIndexOf('.');
  if (dotIdx > 0) return filename.slice(0, dotIdx);
  return null;
}

function extractTimestampFromImageId(id: string): number | null {
  const match = /^img-(\d{10,})-/.exec(id);
  if (!match) return null;
  const ts = Number(match[1]);
  return Number.isFinite(ts) ? ts : null;
}

async function listAllIdbImageIds(): Promise<string[]> {
  const db = await openDb();
  if (!db || useMemoryFallback) {
    return Array.from(memoryImages.keys());
  }
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).getAllKeys();
    request.onsuccess = () => {
      const keys = Array.isArray(request.result)
        ? request.result.filter((k): k is string => typeof k === 'string')
        : [];
      resolve(keys);
    };
    request.onerror = () => resolve([]);
  });
}

export interface OrphanCleanupResult {
  removedDiskFiles: number;
  removedIdbRecords: number;
}

/**
 * 扫描并删除磁盘（$APPDATA/images/）与 IndexedDB 中不再被任何活跃卡片引用的孤儿图片。
 * 通过 minAgeMs 冷却期跳过刚刚写入的图片，避免误删尚未落盘或正在编辑中的图片。
 */
export async function cleanupOrphanImages(
  referencedIds: Set<string>,
  referencedFilenames: Set<string>,
  options?: { minAgeMs?: number }
): Promise<OrphanCleanupResult> {
  const minAgeMs = options?.minAgeMs ?? 60_000;
  const now = Date.now();
  let removedDiskFiles = 0;
  let removedIdbRecords = 0;

  if (isDesktop()) {
    try {
      const dirExists = await exists(IMAGES_DIR, { baseDir: BaseDirectory.AppData }).catch(
        () => false
      );
      if (dirExists) {
        const entries = await readDir(IMAGES_DIR, { baseDir: BaseDirectory.AppData });
        for (const entry of entries) {
          if (!entry.name || entry.name.startsWith('.') || entry.isDirectory) continue;
          if (referencedFilenames.has(entry.name)) continue;

          const id = extractImageIdFromFilename(entry.name);
          if (!id) continue;
          if (referencedIds.has(id)) continue;

          if (minAgeMs > 0) {
            const createdTs = extractTimestampFromImageId(id);
            if (createdTs !== null && now - createdTs < minAgeMs) continue;
          }

          try {
            await remove(`${IMAGES_DIR}/${entry.name}`, {
              baseDir: BaseDirectory.AppData,
            });
            revokeImageUrl(id);
            removedDiskFiles += 1;
          } catch {
            // 忽略单个文件删除失败
          }
        }
      }
    } catch (err) {
      console.warn('扫描磁盘孤儿图片失败', err);
    }
  }

  try {
    const idbIds = await listAllIdbImageIds();
    for (const id of idbIds) {
      if (referencedIds.has(id)) continue;
      if (minAgeMs > 0) {
        const createdTs = extractTimestampFromImageId(id);
        if (createdTs !== null && now - createdTs < minAgeMs) continue;
      }
      await deleteImageFromIdb(id).catch(() => {});
      revokeImageUrl(id);
      removedIdbRecords += 1;
    }
  } catch (err) {
    console.warn('扫描 IndexedDB 孤儿图片失败', err);
  }

  return { removedDiskFiles, removedIdbRecords };
}

import {
  BaseDirectory,
  exists,
  mkdir,
  readTextFile,
  writeTextFile,
} from '@tauri-apps/plugin-fs';
import { isDesktop } from '../services/library';

export type ImageDimsMap = Record<string, [number, number]>;

const CACHE_DIR = 'cache';
const memoryCache = new Map<string, ImageDimsMap>();

function cachePathFor(bookId: string): string {
  const safeId = bookId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${CACHE_DIR}/${safeId}.dims.json`;
}

export async function loadEpubImageDims(bookId: string): Promise<ImageDimsMap> {
  if (!isDesktop()) {
    return { ...(memoryCache.get(bookId) ?? {}) };
  }
  const path = cachePathFor(bookId);
  try {
    const ok = await exists(path, { baseDir: BaseDirectory.AppData });
    if (!ok) return {};
    const raw = await readTextFile(path, { baseDir: BaseDirectory.AppData });
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const result: ImageDimsMap = {};
    for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        Array.isArray(val) &&
        val.length === 2 &&
        typeof val[0] === 'number' &&
        typeof val[1] === 'number' &&
        val[0] > 0 &&
        val[1] > 0
      ) {
        result[key] = [val[0], val[1]];
      }
    }
    return result;
  } catch {
    return {};
  }
}

export async function saveEpubImageDims(
  bookId: string,
  dims: ImageDimsMap
): Promise<void> {
  if (!isDesktop()) {
    memoryCache.set(bookId, { ...dims });
    return;
  }
  try {
    await mkdir(CACHE_DIR, { baseDir: BaseDirectory.AppData, recursive: true });
    await writeTextFile(cachePathFor(bookId), JSON.stringify(dims), {
      baseDir: BaseDirectory.AppData,
    });
  } catch (err) {
    console.warn('保存 EPUB 图片尺寸缓存失败', err);
  }
}

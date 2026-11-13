import {
  BlobReader,
  BlobWriter,
  Reader,
  TextWriter,
  Uint8ArrayWriter,
  ZipReader,
  type FileEntry,
} from '@zip.js/zip.js';
import { invoke } from '@tauri-apps/api/core';
import type { BookParagraph, TextRun, TocEntry } from '../types';

export interface ParsedEpubBook {
  title: string;
  author: string;
  paragraphs: BookParagraph[];
  coverPath?: string;
  toc: TocEntry[];
}

/**
 * EPUB data source. Imports hand over an in-memory `File`, while the reader
 * opens library books straight from disk so a 100MB+ archive never lands in
 * the webview heap.
 */
export type EpubSource = { file: File } | { diskPath: string };

/** zip.js reader backed by ranged reads through a Tauri command. */
class DiskRangeReader extends Reader<null> {
  private readonly path: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(path: string) {
    super(null);
    this.path = path;
  }

  async init(): Promise<void> {
    this.size = await invoke<number>('book_file_size', { path: this.path });
  }

  readUint8Array(offset: number, length: number): Promise<Uint8Array> {
    // zip.js may request several ranges concurrently; serialize the reads.
    const task = this.queue.then(async () => {
      const buffer = await invoke<ArrayBuffer>('read_book_range', {
        path: this.path,
        offset,
        length,
      });
      return new Uint8Array(buffer);
    });
    this.queue = task.catch(() => undefined);
    return task;
  }
}

function openZip(source: EpubSource): ZipReader<unknown> {
  const reader =
    'file' in source
      ? (new BlobReader(source.file) as unknown as Reader<unknown>)
      : (new DiskRangeReader(source.diskPath) as unknown as Reader<unknown>);
  return new ZipReader(reader);
}

/**
 * Keeps the EPUB zip file-backed and reads one image entry on demand.
 * The reading pane only asks for images near the viewport, so a 100MB+
 * image-heavy EPUB does not decode all of its resources at once.
 */
export class EpubImageLoader {
  private readonly source: EpubSource;
  private reader: ZipReader<unknown> | null = null;
  private entriesPromise: Promise<Map<string, FileEntry>> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(source: EpubSource) {
    this.source = source;
  }

  private getEntries(): Promise<Map<string, FileEntry>> {
    if (!this.entriesPromise) {
      this.entriesPromise = (async () => {
        const reader = openZip(this.source);
        const entries = await reader.getEntries();
        this.reader = reader;

        if (this.disposed) {
          await reader.close();
          return new Map<string, FileEntry>();
        }

        const byPath = new Map<string, FileEntry>();
        for (const entry of entries) {
          if (!entry.directory) byPath.set(entry.filename, entry);
        }
        return byPath;
      })();
    }
    return this.entriesPromise;
  }

  readImage(path: string): Promise<Blob | null> {
    const task = this.queue.then(async () => {
      if (this.disposed) return null;

      const entries = await this.getEntries();
      const entry = entries.get(path) ?? entries.get(safeDecode(path));
      if (!entry) return null;

      return entry.getData<Blob>(new BlobWriter(imageMimeType(path)));
    });

    // Serialize decompression so a page full of charts cannot spike memory.
    this.queue = task.then(
      () => undefined,
      () => undefined
    );
    return task;
  }

  dispose(): void {
    this.disposed = true;
    const reader = this.reader;
    this.reader = null;
    this.entriesPromise = null;
    if (reader) {
      void reader.close().catch(() => {});
    }
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function imageMimeType(path: string): string | undefined {
  const ext = path.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'svg':
      return 'image/svg+xml';
    case 'bmp':
      return 'image/bmp';
    default:
      return undefined;
  }
}

function resolveRelativePath(basePath: string, relativePath: string): string {
  const baseParts = basePath.split('/');
  baseParts.pop();
  for (const part of relativePath.split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') baseParts.pop();
    else baseParts.push(part);
  }
  return baseParts.join('/');
}

/**
 * Reads a single binary entry (cover image) without keeping the archive open.
 */
export async function readEpubEntry(
  source: EpubSource,
  path: string
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  const reader = openZip(source);
  try {
    const entries = await reader.getEntries();
    const entry =
      entries.find((item) => item.filename === path) ??
      entries.find((item) => item.filename === safeDecode(path));
    if (!entry || entry.directory) return null;
    const bytes = await entry.getData<Uint8Array>(new Uint8ArrayWriter());
    return { bytes, mime: imageMimeType(path) ?? 'application/octet-stream' };
  } finally {
    try {
      await reader.close();
    } catch {
      // Best effort: the extracted bytes are still usable.
    }
  }
}

const SKIPPED_INLINE_TAGS = new Set(['script', 'style', 'noscript']);

/**
 * Walks an XHTML block and keeps inline formatting (em/strong/sup/sub) as
 * style runs. The concatenated run text is exactly the paragraph text, so
 * existing character-offset anchors keep working.
 */
function extractRuns(root: Element): TextRun[] {
  const raw: TextRun[] = [];

  const walk = (node: Node, style: Omit<TextRun, 'text'>) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.textContent;
      if (value) raw.push({ text: value, ...style });
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (SKIPPED_INLINE_TAGS.has(tag)) return;
    if (tag === 'br') {
      raw.push({ text: ' ', ...style });
      return;
    }
    const next: Omit<TextRun, 'text'> = { ...style };
    if (tag === 'em' || tag === 'i' || tag === 'cite') next.italic = true;
    if (tag === 'strong' || tag === 'b') next.bold = true;
    if (tag === 'sup') next.sup = true;
    if (tag === 'sub') next.sub = true;
    el.childNodes.forEach((child) => walk(child, next));
  };

  root.childNodes.forEach((child) => walk(child, {}));

  const runs: TextRun[] = [];
  for (const run of raw) {
    let text = run.text.replace(/\s+/g, ' ');
    const prev = runs[runs.length - 1];
    if (!text) continue;
    if (prev && prev.text.endsWith(' ') && text.startsWith(' ')) {
      text = text.slice(1);
    }
    if (!text) continue;
    if (
      prev &&
      prev.italic === run.italic &&
      prev.bold === run.bold &&
      prev.sup === run.sup &&
      prev.sub === run.sub
    ) {
      prev.text += text;
    } else {
      runs.push({
        text,
        italic: run.italic,
        bold: run.bold,
        sup: run.sup,
        sub: run.sub,
      });
    }
  }

  while (runs.length && !runs[0].text.trim()) runs.shift();
  if (runs.length) runs[0].text = runs[0].text.replace(/^\s+/, '');
  while (runs.length && !runs[runs.length - 1].text.trim()) runs.pop();
  if (runs.length) {
    const last = runs[runs.length - 1];
    last.text = last.text.replace(/\s+$/, '');
  }

  return runs.filter((run) => run.text.length > 0);
}

function tocEntryDepth(el: Element, stop: Element | null): number {
  let depth = 0;
  let cursor: Element | null = el.parentElement;
  while (cursor && cursor !== stop) {
    if (cursor.tagName === 'OL' || cursor.tagName === 'UL') depth += 1;
    cursor = cursor.parentElement;
  }
  return Math.max(0, depth - 1);
}

export async function parseEpubFile(source: EpubSource): Promise<ParsedEpubBook> {
  // The reader only pulls the central directory and the requested XHTML
  // entries, so a large EPUB never has to be fully loaded.
  const reader = openZip(source);

  try {
    const entries = await reader.getEntries();
    const byPath = new Map<string, FileEntry>();
    for (const entry of entries) {
      if (!entry.directory) {
        byPath.set(entry.filename, entry);
      }
    }

    const readText = async (path: string): Promise<string | null> => {
      const entry = byPath.get(path);
      if (!entry) return null;
      return entry.getData<string>(new TextWriter());
    };

    const parser = new DOMParser();

    const containerXml = await readText('META-INF/container.xml');
    if (!containerXml) {
      throw new Error('无效的 EPUB 文件：缺少 META-INF/container.xml');
    }

    const containerDoc = parser.parseFromString(containerXml, 'application/xml');
    const opfPath = containerDoc.querySelector('rootfile')?.getAttribute('full-path');
    if (!opfPath) {
      throw new Error('无法定位 EPUB OPF 入口文件');
    }

    const opfXml = await readText(opfPath);
    if (!opfXml) {
      throw new Error(`找不到 OPF 文件: ${opfPath}`);
    }

    const opfDoc = parser.parseFromString(opfXml, 'application/xml');
    const titleEl =
      opfDoc.querySelector('metadata title') ||
      opfDoc.getElementsByTagName('dc:title')[0];
    const title =
      titleEl?.textContent?.trim() ||
      ('file' in source ? source.file.name.replace(/\.epub$/i, '') : '未命名书籍');
    const author =
      opfDoc.getElementsByTagName('dc:creator')[0]?.textContent?.trim() || '';

    const manifestMap = new Map<string, string>();
    const manifestItems: { id: string; path: string; mediaType: string; properties: string }[] =
      [];
    opfDoc.querySelectorAll('manifest > item').forEach((item) => {
      const id = item.getAttribute('id');
      const href = item.getAttribute('href');
      if (id && href) {
        const path = resolveRelativePath(opfPath, decodeURIComponent(href));
        manifestMap.set(id, path);
        manifestItems.push({
          id,
          path,
          mediaType: item.getAttribute('media-type') || '',
          properties: item.getAttribute('properties') || '',
        });
      }
    });

    // Cover resolution follows EPUB 3 `properties="cover-image"`, then the
    // legacy `<meta name="cover">`, then a filename heuristic.
    const metaCoverId = opfDoc
      .querySelector('metadata meta[name="cover"]')
      ?.getAttribute('content');
    const coverItem =
      manifestItems.find((item) => item.properties.includes('cover-image')) ??
      (metaCoverId
        ? manifestItems.find((item) => item.id === metaCoverId)
        : undefined) ??
      manifestItems.find(
        (item) => item.mediaType.startsWith('image/') && /cover/i.test(item.path)
      );
    const coverPath = coverItem?.path;

    const spineIds: string[] = [];
    opfDoc.querySelectorAll('spine > itemref').forEach((itemref) => {
      const idref = itemref.getAttribute('idref');
      if (idref) spineIds.push(idref);
    });

    const paragraphs: BookParagraph[] = [];
    const spinePathToIndex = new Map<string, number>();
    const chapterFirstParagraph = new Map<number, string>();
    const chapterHeading = new Map<number, string>();
    // chapterPath#fragment -> paragraph id, so TOC links land on the exact
    // heading instead of the top of the chapter. Ids often sit on inline
    // spans, so every descendant id is registered too.
    const fragmentTargets = new Map<string, string>();
    const mapFragmentIds = (
      chapterPath: string,
      element: Element,
      paragraphId: string
    ) => {
      const ownId = element.getAttribute('id');
      if (ownId) fragmentTargets.set(`${chapterPath}#${ownId}`, paragraphId);
      element.querySelectorAll('[id]').forEach((child) => {
        const childId = child.getAttribute('id');
        if (childId) fragmentTargets.set(`${chapterPath}#${childId}`, paragraphId);
      });
    };

    for (let sIdx = 0; sIdx < spineIds.length; sIdx++) {
      const itemId = spineIds[sIdx];
      const chapterPath = manifestMap.get(itemId);
      if (!chapterPath) continue;
      spinePathToIndex.set(chapterPath, sIdx);

      const rawHtml = await readText(chapterPath);
      if (!rawHtml) continue;

      const chapDoc = parser.parseFromString(rawHtml, 'text/html');
      const nodes = chapDoc.body?.querySelectorAll(
        'h1, h2, h3, h4, p, blockquote, li, img, svg image'
      );
      if (!nodes) continue;

      let textIdx = 0;
      let imageIdx = 0;

      nodes.forEach((el) => {
        const tag = el.tagName.toLowerCase();
        if (tag === 'img' || tag === 'image') {
          const src =
            el.getAttribute('src') ||
            el.getAttribute('href') ||
            el.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
          if (!src) return;

          const isDataUrl = src.startsWith('data:');
          const rawPath = isDataUrl ? '' : src.split('#')[0];
          const decodedPath = safeDecode(rawPath);
          const imagePath = isDataUrl
            ? undefined
            : decodedPath.startsWith('/')
              ? decodedPath.slice(1)
              : resolveRelativePath(chapterPath, decodedPath);

          const width = Number(el.getAttribute('width'));
          const height = Number(el.getAttribute('height'));
          imageIdx++;
          const imageParagraphId = `epub-${sIdx + 1}-img-${imageIdx}`;
          mapFragmentIds(chapterPath, el, imageParagraphId);

          paragraphs.push({
            id: imageParagraphId,
            type: 'image',
            imagePath,
            imageSrc: isDataUrl ? src : undefined,
            imageAlt: el.getAttribute('alt') || '',
            imageWidth: Number.isFinite(width) && width > 0 ? width : undefined,
            imageHeight: Number.isFinite(height) && height > 0 ? height : undefined,
          });
          return;
        }

        const runs = extractRuns(el);
        const text = runs.map((run) => run.text).join('');
        if (!text) return;
        textIdx++;
        const id = `epub-${sIdx + 1}-${textIdx}`;
        if (!chapterFirstParagraph.has(sIdx)) chapterFirstParagraph.set(sIdx, id);
        const isHeading = tag.startsWith('h');
        if (isHeading && !chapterHeading.has(sIdx)) {
          chapterHeading.set(sIdx, text.slice(0, 80));
        }
        const hasFormatting = runs.some((run) => run.italic || run.bold || run.sup || run.sub);
        const epubCfiBase = `epubcfi(/6/${(sIdx + 1) * 2}[${itemId}]!/4/${textIdx * 2})`;
        mapFragmentIds(chapterPath, el, id);

        paragraphs.push({
          id,
          type: isHeading ? 'heading' : 'prose',
          text,
          runs: hasFormatting ? runs : undefined,
          epubCfiBase,
        });
      });
    }

    if (paragraphs.length === 0) {
      throw new Error('未能从 EPUB 中提取到可读文本内容');
    }

    // Table of contents: EPUB 3 nav document first, then the NCX, then a
    // synthetic entry per rendered chapter.
    const toc: TocEntry[] = [];
    const pushToc = (
      label: string,
      href: string | null,
      basePath: string,
      depth: number
    ) => {
      if (!href) return;
      const [rawPath, rawFragment] = href.split('#');
      if (!rawPath) return;
      const target = resolveRelativePath(basePath, safeDecode(rawPath));
      const sIdx = spinePathToIndex.get(target);
      if (sIdx === undefined) return;
      const fragmentId = rawFragment ? safeDecode(rawFragment) : '';
      const paragraphId =
        (fragmentId ? fragmentTargets.get(`${target}#${fragmentId}`) : undefined) ??
        chapterFirstParagraph.get(sIdx);
      if (!paragraphId) return;
      toc.push({
        label: label || `第 ${sIdx + 1} 节`,
        target: paragraphId,
        depth,
        kind: 'epub',
      });
    };

    const navItem = manifestItems.find((item) => /(^|\s)nav(\s|$)/.test(item.properties));
    if (navItem) {
      const navHtml = await readText(navItem.path);
      if (navHtml) {
        const navDoc = parser.parseFromString(navHtml, 'text/html');
        const navEls = Array.from(navDoc.querySelectorAll('nav'));
        const tocNav =
          navEls.find((nav) =>
            (nav.getAttribute('epub:type') || '').split(/\s+/).includes('toc')
          ) ?? navEls[0];
        if (tocNav) {
          tocNav.querySelectorAll('a').forEach((a) => {
            const label = a.textContent?.replace(/\s+/g, ' ').trim() || '';
            pushToc(label, a.getAttribute('href'), navItem.path, tocEntryDepth(a, tocNav));
          });
        }
      }
    }

    if (toc.length === 0) {
      const tocId = opfDoc.querySelector('spine')?.getAttribute('toc');
      const ncxPath =
        (tocId ? manifestMap.get(tocId) : undefined) ??
        manifestItems.find((item) => item.mediaType.includes('ncx'))?.path;
      if (ncxPath) {
        const ncxXml = await readText(ncxPath);
        if (ncxXml) {
          const ncxDoc = parser.parseFromString(ncxXml, 'application/xml');
          ncxDoc.querySelectorAll('navPoint').forEach((point) => {
            const label = point.querySelector('navLabel > text')?.textContent?.trim() || '';
            const src = point.querySelector('content')?.getAttribute('src') ?? null;
            let depth = 0;
            let cursor = point.parentElement;
            while (cursor && cursor.tagName === 'navPoint') {
              depth += 1;
              cursor = cursor.parentElement;
            }
            pushToc(label, src, ncxPath, depth);
          });
        }
      }
    }

    if (toc.length === 0) {
      for (const sIdx of Array.from(chapterFirstParagraph.keys()).sort((a, b) => a - b)) {
        toc.push({
          label: chapterHeading.get(sIdx) || `第 ${sIdx + 1} 节`,
          target: chapterFirstParagraph.get(sIdx)!,
          depth: 0,
          kind: 'epub',
        });
      }
    }

    return { title, author, paragraphs, coverPath, toc };
  } finally {
    try {
      await reader.close();
    } catch {
      // The archive can still be readable even if close fails.
    }
  }
}

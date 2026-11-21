import { invoke } from '@tauri-apps/api/core';
import { join } from '@tauri-apps/api/path';
import { open } from '@tauri-apps/plugin-dialog';
import { isDesktop } from '../services/library';
import type {
  AnnotationCardItem,
  BookAnchor,
  BookParagraph,
  CardEdge,
  CardImage,
} from '../types';

interface ExportOptions {
  bookTitle: string;
  anchors: BookAnchor[];
  cards: AnnotationCardItem[];
  edges: CardEdge[];
  paragraphs: BookParagraph[];
}

function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'ReadingBook-批注';
}

function basenameOf(relPath: string): string {
  const parts = relPath.split(/[/\\]/);
  return parts[parts.length - 1] || relPath;
}

export async function buildBookAnnotationsMarkdown({
  bookTitle,
  anchors,
  cards,
  edges,
  paragraphs,
}: ExportOptions): Promise<{ markdown: string; imageRelPaths: string[] }> {
  const imageRelPathSet = new Set<string>();
  const paraOrder = new Map<string, number>();
  paragraphs.forEach((p, idx) => paraOrder.set(p.id, idx));

  const anchorById = new Map<string, BookAnchor>();
  for (const a of anchors) anchorById.set(a.id, a);

  const cardById = new Map<string, AnnotationCardItem>();
  for (const c of cards) cardById.set(c.id, c);

  const childrenByParent = new Map<string, string[]>();
  const hasIncoming = new Set<string>();
  for (const edge of edges) {
    if (!cardById.has(edge.source) || !cardById.has(edge.target)) continue;
    const list = childrenByParent.get(edge.source) ?? [];
    list.push(edge.target);
    childrenByParent.set(edge.source, list);
    hasIncoming.add(edge.target);
  }

  const lines: string[] = [];
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  lines.push(`# 《${bookTitle}》批注笔记`);
  lines.push('');
  lines.push(`- 导出时间：${dateStr}`);
  lines.push(`- 书页标注：${anchors.length} 处`);
  lines.push(`- 批注卡片：${cards.length} 张`);
  lines.push('');

  const visited = new Set<string>();

  const formatImageLine = (img: CardImage): string => {
    if (img.filePath) {
      imageRelPathSet.add(img.filePath);
      const name = basenameOf(img.filePath);
      return `![批注附图](assets/${encodeURIComponent(name)})`;
    }
    return `![批注附图](${img.id})`;
  };

  const renderCardTree = (card: AnnotationCardItem, depth: number): void => {
    if (visited.has(card.id)) return;
    visited.add(card.id);

    const indent = '  '.repeat(depth);
    const bodyText = card.body.trim();
    if (bodyText) {
      const bodyLines = bodyText.split('\n');
      lines.push(`${indent}- ${bodyLines[0]}`);
      for (let i = 1; i < bodyLines.length; i += 1) {
        lines.push(`${indent}  ${bodyLines[i]}`);
      }
    } else if ((card.images?.length ?? 0) > 0) {
      lines.push(`${indent}- （图片笔记）`);
    }

    for (const img of card.images ?? []) {
      lines.push(`${indent}  ${formatImageLine(img)}`);
    }

    const childIds = childrenByParent.get(card.id) ?? [];
    const childCards = childIds
      .map((id) => cardById.get(id))
      .filter((c): c is AnnotationCardItem => Boolean(c))
      .sort((a, b) => a.y - b.y);
    for (const child of childCards) {
      renderCardTree(child, depth + 1);
    }
  };

  // 1. 绑定到书页原文的批注（按原文位置排序）
  const anchoredCards = cards
    .filter((c) => Boolean(c.anchorId && anchorById.has(c.anchorId)))
    .sort((a, b) => {
      const ancA = anchorById.get(a.anchorId!)!;
      const ancB = anchorById.get(b.anchorId!)!;
      if (ancA.pdfPage && ancB.pdfPage && ancA.pdfPage !== ancB.pdfPage) {
        return ancA.pdfPage - ancB.pdfPage;
      }
      const pA = paraOrder.get(ancA.paragraphId) ?? Number.MAX_SAFE_INTEGER;
      const pB = paraOrder.get(ancB.paragraphId) ?? Number.MAX_SAFE_INTEGER;
      if (pA !== pB) return pA - pB;
      return ancA.startOffset - ancB.startOffset;
    });

  if (anchoredCards.length > 0) {
    lines.push('## 书页批注');
    lines.push('');
    for (const card of anchoredCards) {
      const anchor = anchorById.get(card.anchorId!)!;
      const loc = anchor.pdfPage ? `（第 ${anchor.pdfPage} 页）` : '';
      if (anchor.quote.trim()) {
        lines.push(`> ${anchor.quote.trim().replace(/\n+/g, ' ')}${loc}`);
        lines.push('');
      }
      renderCardTree(card, 0);
      lines.push('');
    }
  }

  // 2. 自由卡片（未绑定书页锚点的根卡片）
  const freeRoots = cards
    .filter((c) => !visited.has(c.id) && !hasIncoming.has(c.id))
    .sort((a, b) => a.y - b.y);
  if (freeRoots.length > 0) {
    lines.push('## 自由笔记卡片');
    lines.push('');
    for (const card of freeRoots) {
      renderCardTree(card, 0);
      lines.push('');
    }
  }

  // 3. 仅高亮 / 仅划线（无关联卡片）
  const plainAnchors = anchors
    .filter((a) => !a.targetNodeId && a.quote.trim())
    .sort((a, b) => {
      if (a.pdfPage && b.pdfPage && a.pdfPage !== b.pdfPage) {
        return a.pdfPage - b.pdfPage;
      }
      const pA = paraOrder.get(a.paragraphId) ?? Number.MAX_SAFE_INTEGER;
      const pB = paraOrder.get(b.paragraphId) ?? Number.MAX_SAFE_INTEGER;
      if (pA !== pB) return pA - pB;
      return a.startOffset - b.startOffset;
    });

  if (plainAnchors.length > 0) {
    lines.push('## 纯划线与高亮');
    lines.push('');
    for (const anchor of plainAnchors) {
      const loc = anchor.pdfPage ? `（第 ${anchor.pdfPage} 页）` : '';
      lines.push(`- ${anchor.quote.trim().replace(/\n+/g, ' ')}${loc}`);
    }
    lines.push('');
  }

  return {
    markdown: lines.join('\n'),
    imageRelPaths: Array.from(imageRelPathSet),
  };
}

export async function exportBookAnnotationsToMarkdown(
  options: ExportOptions
): Promise<{ exported: boolean; imageCount: number }> {
  const { markdown, imageRelPaths } = await buildBookAnnotationsMarkdown(options);
  const safeTitle = sanitizeFileName(options.bookTitle);
  const filename = `${safeTitle}-批注.md`;

  if (isDesktop()) {
    const selectedDir = await open({
      title: '选择导出文件夹（将自动生成含 assets 图片目录的笔记文件夹）',
      directory: true,
      multiple: false,
    });
    if (!selectedDir || Array.isArray(selectedDir)) {
      return { exported: false, imageCount: 0 };
    }
    const targetDir = await join(selectedDir, `${safeTitle}-笔记`);
    const copiedCount = await invoke<number>('export_markdown_bundle', {
      targetDir,
      filename,
      markdown,
      imageRelPaths,
    });
    return { exported: true, imageCount: copiedCount };
  }

  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  return { exported: true, imageCount: 0 };
}

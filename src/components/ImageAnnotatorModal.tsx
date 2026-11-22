import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowUpRight,
  Check,
  Highlighter,
  Minus,
  MousePointer2,
  Pencil,
  Rows3,
  Square,
  Trash2,
  Type,
  Undo2,
  X,
} from 'lucide-react';

type AnnotatorTool =
  | 'select'
  | 'arrow'
  | 'line'
  | 'rect'
  | 'highlighter'
  | 'fib-mm'
  | 'fib-ext'
  | 'text';
type ConvertibleKind = 'arrow' | 'line' | 'rect';

type Shape =
  | {
      id: string;
      kind: 'arrow';
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      color: string;
    }
  | {
      id: string;
      kind: 'line';
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      color: string;
    }
  | {
      id: string;
      kind: 'rect';
      x: number;
      y: number;
      w: number;
      h: number;
      color: string;
    }
  | {
      id: string;
      kind: 'highlighter';
      points: { x: number; y: number }[];
      color: string;
    }
  | {
      id: string;
      kind: 'fib-mm';
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      color: string;
    }
  | {
      id: string;
      kind: 'fib-ext';
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      x3: number;
      y3: number;
      color: string;
    }
  | {
      id: string;
      kind: 'text';
      x: number;
      y: number;
      text: string;
      color: string;
      fontSize?: number;
      maxWidth?: number;
    };

type HandleId =
  | 'start'
  | 'end'
  | 'p1'
  | 'p2'
  | 'p3'
  | 'nw'
  | 'ne'
  | 'sw'
  | 'se'
  | 'w'
  | 'e';

interface HandlePoint {
  id: HandleId;
  x: number;
  y: number;
}

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface TextDraftState {
  sessionId: number;
  editingId: string | null;
  imgX: number;
  imgY: number;
  cssX: number;
  cssY: number;
  value: string;
  color: string;
  fontSize: number;
  maxWidth?: number;
  initialCssWidth: number;
}

interface FibExtDraftState {
  points: { x: number; y: number }[];
  cursor: { x: number; y: number } | null;
  color: string;
}

const PALETTE = [
  { name: '红', value: '#ef4444' },
  { name: '绿', value: '#16a34a' },
  { name: '蓝', value: '#2563eb' },
  { name: '黄', value: '#eab308' },
];

const TEXT_SIZES = [
  { label: '小', base: 14 },
  { label: '中', base: 20 },
  { label: '大', base: 28 },
  { label: '特大', base: 38 },
] as const;

const DEFAULT_TEXT_BASE_SIZE = 20;

interface ImageAnnotatorModalProps {
  imageUrl: string;
  onCancel: () => void;
  onSave: (file: File) => Promise<void> | void;
}

let shapeIdSeq = 1;
function nextShapeId(): string {
  shapeIdSeq += 1;
  return `shape-${Date.now()}-${shapeIdSeq}`;
}

function getStrokeScale(width: number, height: number): number {
  return Math.max(0.75, Math.min(2.2, Math.max(width, height) / 900));
}

function getTextMetrics(strokeScale: number, baseSize = DEFAULT_TEXT_BASE_SIZE) {
  const fontSize = Math.max(12, Math.round(baseSize * strokeScale));
  const lineHeight = Math.round(fontSize * 1.32);
  const font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif`;
  return { fontSize, lineHeight, font };
}

function wrapTextLines(
  ctx: CanvasRenderingContext2D | null,
  text: string,
  font: string,
  fontSize: number,
  maxWidth?: number
): string[] {
  const paragraphs = text.split('\n');
  if (!maxWidth || maxWidth <= 0) return paragraphs;

  const measure = (s: string) =>
    ctx ? ctx.measureText(s).width : s.length * fontSize * 0.75;
  if (ctx) {
    ctx.save();
    ctx.font = font;
  }

  const result: string[] = [];
  for (const para of paragraphs) {
    if (!para) {
      result.push('');
      continue;
    }
    let line = '';
    for (const ch of para) {
      const next = line + ch;
      if (line.length > 0 && measure(next) > maxWidth) {
        const lastSpace = line.lastIndexOf(' ');
        if (lastSpace > 0 && ch !== ' ') {
          result.push(line.slice(0, lastSpace));
          line = line.slice(lastSpace + 1) + ch;
        } else {
          result.push(line);
          line = ch === ' ' ? '' : ch;
        }
      } else {
        line = next;
      }
    }
    if (line.length > 0) result.push(line);
  }

  if (ctx) ctx.restore();
  return result.length > 0 ? result : [''];
}

/** Snap endpoint to horizontal, vertical, or 45-degree angle when Shift is held. */
function snapEndpoint(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  shiftKey: boolean
): { x: number; y: number } {
  if (!shiftKey) return { x: x2, y: y2 };
  const dx = x2 - x1;
  const dy = y2 - y1;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return { x: x2, y: y2 };
  const angle = Math.atan2(dy, dx);
  const snapped = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
  return {
    x: x1 + dist * Math.cos(snapped),
    y: y1 + dist * Math.sin(snapped),
  };
}

function distToSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-6) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function getFibMmLayout(
  shape: Pick<Extract<Shape, { kind: 'fib-mm' }>, 'x1' | 'y1' | 'x2' | 'y2'>,
  strokeScale: number
) {
  const minSpan = Math.max(48, 56 * strokeScale);
  let leftX = Math.min(shape.x1, shape.x2);
  let rightX = Math.max(shape.x1, shape.x2);
  if (rightX - leftX < minSpan) {
    rightX = leftX + minSpan;
  }
  const dy = shape.y2 - shape.y1;
  const levels = [
    { label: '1', y: shape.y1 },
    { label: '0', y: shape.y2 },
    { label: '-1', y: shape.y2 + dy },
  ];
  return { leftX, rightX, levels };
}

function getFibExtLayout(
  shape: Pick<
    Extract<Shape, { kind: 'fib-ext' }>,
    'x1' | 'y1' | 'x2' | 'y2' | 'x3' | 'y3'
  >,
  strokeScale: number
) {
  const minSpan = Math.max(48, 56 * strokeScale);
  let leftX = Math.min(shape.x2, shape.x3);
  let rightX = Math.max(shape.x2, shape.x3);
  if (rightX - leftX < minSpan) {
    rightX = leftX + minSpan;
  }
  const dy = shape.y2 - shape.y1;
  const levels = [
    { label: '0', y: shape.y3 },
    { label: '1', y: shape.y3 + dy },
  ];
  return { leftX, rightX, levels };
}

function getShapeBounds(
  ctx: CanvasRenderingContext2D | null,
  shape: Shape,
  strokeScale: number
): Bounds {
  if (shape.kind === 'arrow' || shape.kind === 'line') {
    return {
      minX: Math.min(shape.x1, shape.x2),
      minY: Math.min(shape.y1, shape.y2),
      maxX: Math.max(shape.x1, shape.x2),
      maxY: Math.max(shape.y1, shape.y2),
    };
  }
  if (shape.kind === 'rect') {
    return {
      minX: Math.min(shape.x, shape.x + shape.w),
      minY: Math.min(shape.y, shape.y + shape.h),
      maxX: Math.max(shape.x, shape.x + shape.w),
      maxY: Math.max(shape.y, shape.y + shape.h),
    };
  }
  if (shape.kind === 'fib-mm') {
    const { leftX, rightX, levels } = getFibMmLayout(shape, strokeScale);
    const ys = levels.map((l) => l.y);
    return {
      minX: leftX,
      minY: Math.min(...ys),
      maxX: rightX,
      maxY: Math.max(...ys),
    };
  }
  if (shape.kind === 'fib-ext') {
    const { leftX, rightX, levels } = getFibExtLayout(shape, strokeScale);
    const xs = [shape.x1, shape.x2, shape.x3, leftX, rightX];
    const ys = [shape.y1, shape.y2, shape.y3, ...levels.map((l) => l.y)];
    return {
      minX: Math.min(...xs),
      minY: Math.min(...ys),
      maxX: Math.max(...xs),
      maxY: Math.max(...ys),
    };
  }
  if (shape.kind === 'highlighter') {
    const pad = Math.max(7, 9 * strokeScale);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const pt of shape.points) {
      if (pt.x < minX) minX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y > maxY) maxY = pt.y;
    }
    if (!Number.isFinite(minX)) {
      return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    }
    return {
      minX: minX - pad,
      minY: minY - pad,
      maxX: maxX + pad,
      maxY: maxY + pad,
    };
  }
  // text
  const { fontSize, lineHeight, font } = getTextMetrics(strokeScale, shape.fontSize);
  const lines = wrapTextLines(ctx, shape.text, font, fontSize, shape.maxWidth);
  let maxW = fontSize;
  if (ctx) {
    ctx.save();
    ctx.font = font;
    for (const line of lines) {
      maxW = Math.max(maxW, ctx.measureText(line).width);
    }
    ctx.restore();
  } else {
    for (const line of lines) {
      maxW = Math.max(maxW, line.length * fontSize * 0.75);
    }
  }
  const boxW = shape.maxWidth ? Math.max(shape.maxWidth, maxW) : maxW;
  const pad = Math.max(4, 4 * strokeScale);
  return {
    minX: shape.x - pad,
    minY: shape.y - pad,
    maxX: shape.x + boxW + pad,
    maxY: shape.y + lines.length * lineHeight + pad,
  };
}

function getShapeHandles(
  ctx: CanvasRenderingContext2D | null,
  shape: Shape,
  strokeScale: number
): HandlePoint[] {
  if (shape.kind === 'arrow' || shape.kind === 'line' || shape.kind === 'fib-mm') {
    return [
      { id: 'start', x: shape.x1, y: shape.y1 },
      { id: 'end', x: shape.x2, y: shape.y2 },
    ];
  }
  if (shape.kind === 'fib-ext') {
    return [
      { id: 'p1', x: shape.x1, y: shape.y1 },
      { id: 'p2', x: shape.x2, y: shape.y2 },
      { id: 'p3', x: shape.x3, y: shape.y3 },
    ];
  }
  if (shape.kind === 'rect' || shape.kind === 'highlighter') {
    const b = getShapeBounds(ctx, shape, strokeScale);
    return [
      { id: 'nw', x: b.minX, y: b.minY },
      { id: 'ne', x: b.maxX, y: b.minY },
      { id: 'sw', x: b.minX, y: b.maxY },
      { id: 'se', x: b.maxX, y: b.maxY },
    ];
  }
  if (shape.kind === 'text') {
    const b = getShapeBounds(ctx, shape, strokeScale);
    const midY = (b.minY + b.maxY) / 2;
    return [
      { id: 'w', x: b.minX, y: midY },
      { id: 'e', x: b.maxX, y: midY },
    ];
  }
  return [];
}

function hitTestHandle(
  ctx: CanvasRenderingContext2D | null,
  shape: Shape,
  px: number,
  py: number,
  strokeScale: number,
  hitRadius: number
): HandleId | null {
  const handles = getShapeHandles(ctx, shape, strokeScale);
  for (const h of handles) {
    if (Math.hypot(px - h.x, py - h.y) <= hitRadius) {
      return h.id;
    }
  }
  if (shape.kind === 'text') {
    const b = getShapeBounds(ctx, shape, strokeScale);
    if (py >= b.minY - hitRadius && py <= b.maxY + hitRadius) {
      if (Math.abs(px - b.maxX) <= hitRadius * 0.85) return 'e';
      if (Math.abs(px - b.minX) <= hitRadius * 0.85) return 'w';
    }
  }
  return null;
}

function hitTestShape(
  ctx: CanvasRenderingContext2D | null,
  shape: Shape,
  px: number,
  py: number,
  strokeScale: number,
  tolerance: number,
  allowRectInterior: boolean
): boolean {
  const tol = Math.max(tolerance, 8 * strokeScale);
  if (shape.kind === 'arrow' || shape.kind === 'line') {
    return distToSegment(px, py, shape.x1, shape.y1, shape.x2, shape.y2) <= tol;
  }
  if (shape.kind === 'fib-mm') {
    const { leftX, rightX, levels } = getFibMmLayout(shape, strokeScale);
    if (distToSegment(px, py, shape.x1, shape.y1, shape.x2, shape.y2) <= tol) return true;
    for (const lv of levels) {
      if (distToSegment(px, py, leftX - 18 * strokeScale, lv.y, rightX, lv.y) <= tol) {
        return true;
      }
    }
    return false;
  }
  if (shape.kind === 'fib-ext') {
    const { leftX, rightX, levels } = getFibExtLayout(shape, strokeScale);
    if (
      distToSegment(px, py, shape.x1, shape.y1, shape.x2, shape.y2) <= tol ||
      distToSegment(px, py, shape.x2, shape.y2, shape.x3, shape.y3) <= tol
    ) {
      return true;
    }
    for (const lv of levels) {
      if (distToSegment(px, py, leftX - 18 * strokeScale, lv.y, rightX, lv.y) <= tol) {
        return true;
      }
    }
    return false;
  }
  if (shape.kind === 'rect') {
    const b = getShapeBounds(ctx, shape, strokeScale);
    const onBorder =
      distToSegment(px, py, b.minX, b.minY, b.maxX, b.minY) <= tol ||
      distToSegment(px, py, b.maxX, b.minY, b.maxX, b.maxY) <= tol ||
      distToSegment(px, py, b.maxX, b.maxY, b.minX, b.maxY) <= tol ||
      distToSegment(px, py, b.minX, b.maxY, b.minX, b.minY) <= tol;
    if (onBorder) return true;
    if (allowRectInterior) {
      return px >= b.minX && px <= b.maxX && py >= b.minY && py <= b.maxY;
    }
    return false;
  }
  if (shape.kind === 'highlighter') {
    const hTol = Math.max(tol, 11 * strokeScale);
    for (let i = 1; i < shape.points.length; i += 1) {
      const a = shape.points[i - 1];
      const b = shape.points[i];
      if (distToSegment(px, py, a.x, a.y, b.x, b.y) <= hTol) return true;
    }
    return false;
  }
  // text
  const b = getShapeBounds(ctx, shape, strokeScale);
  return px >= b.minX - 4 && px <= b.maxX + 4 && py >= b.minY - 4 && py <= b.maxY + 4;
}

function findTopShapeAt(
  ctx: CanvasRenderingContext2D | null,
  shapes: Shape[],
  px: number,
  py: number,
  strokeScale: number,
  tolerance: number
): Shape | null {
  for (let i = shapes.length - 1; i >= 0; i -= 1) {
    if (hitTestShape(ctx, shapes[i], px, py, strokeScale, tolerance, false)) {
      return shapes[i];
    }
  }
  for (let i = shapes.length - 1; i >= 0; i -= 1) {
    if (
      shapes[i].kind === 'rect' &&
      hitTestShape(ctx, shapes[i], px, py, strokeScale, tolerance, true)
    ) {
      return shapes[i];
    }
  }
  return null;
}

function translateShape(shape: Shape, dx: number, dy: number): Shape {
  if (shape.kind === 'arrow' || shape.kind === 'line' || shape.kind === 'fib-mm') {
    return {
      ...shape,
      x1: shape.x1 + dx,
      y1: shape.y1 + dy,
      x2: shape.x2 + dx,
      y2: shape.y2 + dy,
    };
  }
  if (shape.kind === 'fib-ext') {
    return {
      ...shape,
      x1: shape.x1 + dx,
      y1: shape.y1 + dy,
      x2: shape.x2 + dx,
      y2: shape.y2 + dy,
      x3: shape.x3 + dx,
      y3: shape.y3 + dy,
    };
  }
  if (shape.kind === 'rect') {
    return { ...shape, x: shape.x + dx, y: shape.y + dy };
  }
  if (shape.kind === 'highlighter') {
    return {
      ...shape,
      points: shape.points.map((pt) => ({ x: pt.x + dx, y: pt.y + dy })),
    };
  }
  return { ...shape, x: shape.x + dx, y: shape.y + dy };
}

function convertShapeKind(shape: Shape, targetKind: ConvertibleKind): Shape {
  if (shape.kind === targetKind) return shape;
  if (shape.kind === 'arrow' || shape.kind === 'line') {
    if (targetKind === 'arrow' || targetKind === 'line') {
      return {
        id: shape.id,
        kind: targetKind,
        x1: shape.x1,
        y1: shape.y1,
        x2: shape.x2,
        y2: shape.y2,
        color: shape.color,
      };
    }
    const minX = Math.min(shape.x1, shape.x2);
    const minY = Math.min(shape.y1, shape.y2);
    const w = Math.max(24, Math.abs(shape.x2 - shape.x1));
    const h = Math.max(24, Math.abs(shape.y2 - shape.y1));
    return {
      id: shape.id,
      kind: 'rect',
      x: minX,
      y: minY,
      w,
      h,
      color: shape.color,
    };
  }
  if (shape.kind === 'rect' && (targetKind === 'arrow' || targetKind === 'line')) {
    return {
      id: shape.id,
      kind: targetKind,
      x1: shape.x,
      y1: shape.y + shape.h,
      x2: shape.x + shape.w,
      y2: shape.y,
      color: shape.color,
    };
  }
  return shape;
}

function drawFibLevels(
  ctx: CanvasRenderingContext2D,
  leftX: number,
  rightX: number,
  levels: { label: string; y: number }[],
  color: string,
  strokeScale: number
) {
  const lineWidth = Math.max(2, 2.2 * strokeScale);
  const labelSize = Math.max(12, Math.round(14 * strokeScale));
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.setLineDash([]);
  ctx.font = `600 ${labelSize}px -apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';

  const labelGap = Math.max(7, 8 * strokeScale);
  for (const lv of levels) {
    ctx.beginPath();
    ctx.moveTo(leftX, lv.y);
    ctx.lineTo(rightX, lv.y);
    ctx.stroke();

    ctx.save();
    ctx.lineWidth = Math.max(3, 3.5 * strokeScale);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.strokeText(lv.label, leftX - labelGap, lv.y);
    ctx.fillStyle = color;
    ctx.fillText(lv.label, leftX - labelGap, lv.y);
    ctx.restore();
  }
  ctx.restore();
}

function drawShape(
  ctx: CanvasRenderingContext2D,
  shape: Shape,
  strokeScale: number
): void {
  const lineWidth = Math.max(2.5, 3 * strokeScale);
  ctx.save();
  ctx.strokeStyle = shape.color;
  ctx.fillStyle = shape.color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (shape.kind === 'arrow') {
    const { x1, y1, x2, y2 } = shape;
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const headLen = Math.max(12, 16 * strokeScale);

    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(
      x2 - headLen * Math.cos(angle - Math.PI / 6),
      y2 - headLen * Math.sin(angle - Math.PI / 6)
    );
    ctx.lineTo(
      x2 - headLen * Math.cos(angle + Math.PI / 6),
      y2 - headLen * Math.sin(angle + Math.PI / 6)
    );
    ctx.closePath();
    ctx.fill();
  } else if (shape.kind === 'line') {
    ctx.beginPath();
    ctx.moveTo(shape.x1, shape.y1);
    ctx.lineTo(shape.x2, shape.y2);
    ctx.stroke();
  } else if (shape.kind === 'rect') {
    ctx.strokeRect(shape.x, shape.y, shape.w, shape.h);
  } else if (shape.kind === 'fib-mm') {
    const { leftX, rightX, levels } = getFibMmLayout(shape, strokeScale);
    drawFibLevels(ctx, leftX, rightX, levels, shape.color, strokeScale);

    // Dashed trendline connecting P1 -> P2
    ctx.save();
    ctx.strokeStyle = shape.color;
    ctx.globalAlpha = 0.72;
    ctx.lineWidth = Math.max(1.6, 1.8 * strokeScale);
    ctx.setLineDash([6 * strokeScale, 5 * strokeScale]);
    ctx.beginPath();
    ctx.moveTo(shape.x1, shape.y1);
    ctx.lineTo(shape.x2, shape.y2);
    ctx.stroke();
    ctx.restore();
  } else if (shape.kind === 'fib-ext') {
    const { leftX, rightX, levels } = getFibExtLayout(shape, strokeScale);
    drawFibLevels(ctx, leftX, rightX, levels, shape.color, strokeScale);

    // Dashed trendline connecting A -> B -> C
    ctx.save();
    ctx.strokeStyle = shape.color;
    ctx.globalAlpha = 0.75;
    ctx.lineWidth = Math.max(1.8, 2 * strokeScale);
    ctx.setLineDash([7 * strokeScale, 5 * strokeScale]);
    ctx.beginPath();
    ctx.moveTo(shape.x1, shape.y1);
    ctx.lineTo(shape.x2, shape.y2);
    ctx.lineTo(shape.x3, shape.y3);
    ctx.stroke();
    ctx.restore();
  } else if (shape.kind === 'highlighter') {
    if (shape.points.length >= 2) {
      ctx.globalAlpha = 0.32;
      ctx.lineWidth = Math.max(14, 18 * strokeScale);
      ctx.beginPath();
      ctx.moveTo(shape.points[0].x, shape.points[0].y);
      for (let i = 1; i < shape.points.length; i += 1) {
        ctx.lineTo(shape.points[i].x, shape.points[i].y);
      }
      ctx.stroke();
    }
  } else if (shape.kind === 'text') {
    const { fontSize, lineHeight, font } = getTextMetrics(strokeScale, shape.fontSize);
    ctx.font = font;
    ctx.textBaseline = 'top';
    const lines = wrapTextLines(ctx, shape.text, font, fontSize, shape.maxWidth);
    lines.forEach((line, idx) => {
      const ly = shape.y + idx * lineHeight;
      ctx.lineWidth = Math.max(3, Math.round(fontSize * 0.18));
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
      ctx.strokeText(line, shape.x, ly);
      ctx.fillStyle = shape.color;
      ctx.fillText(line, shape.x, ly);
    });
  }

  ctx.restore();
}

function drawSelectionOverlay(
  ctx: CanvasRenderingContext2D,
  shape: Shape,
  strokeScale: number,
  imgPerCss: number
): void {
  const px = Math.max(1, imgPerCss);
  ctx.save();
  ctx.strokeStyle = '#3b82f6';
  ctx.lineWidth = 1.5 * px;
  ctx.setLineDash([5 * px, 4 * px]);

  if (shape.kind === 'rect' || shape.kind === 'highlighter' || shape.kind === 'text') {
    const b = getShapeBounds(ctx, shape, strokeScale);
    const pad = 3 * px;
    ctx.strokeRect(
      b.minX - pad,
      b.minY - pad,
      b.maxX - b.minX + pad * 2,
      b.maxY - b.minY + pad * 2
    );
  } else if (shape.kind === 'arrow' || shape.kind === 'line') {
    ctx.beginPath();
    ctx.moveTo(shape.x1, shape.y1);
    ctx.lineTo(shape.x2, shape.y2);
    ctx.stroke();
  }

  ctx.setLineDash([]);
  const handles = getShapeHandles(ctx, shape, strokeScale);
  const radius = 5.5 * px;
  for (const h of handles) {
    ctx.beginPath();
    ctx.arc(h.x, h.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = 2 * px;
    ctx.strokeStyle = '#2563eb';
    ctx.stroke();
  }
  ctx.restore();
}

export const ImageAnnotatorModal: React.FC<ImageAnnotatorModalProps> = ({
  imageUrl,
  onCancel,
  onSave,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const textInputRef = useRef<HTMLTextAreaElement | null>(null);
  const textSessionSeqRef = useRef(1);

  const [tool, setTool] = useState<AnnotatorTool>('arrow');
  const [color, setColor] = useState<string>(PALETTE[0].value);
  const [textBaseSize, setTextBaseSize] = useState<number>(DEFAULT_TEXT_BASE_SIZE);
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [undoStack, setUndoStack] = useState<Shape[][]>([]);
  const [draftShape, setDraftShape] = useState<Shape | null>(null);
  const [fibExtDraft, setFibExtDraft] = useState<FibExtDraftState | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoverCursor, setHoverCursor] = useState<string | null>(null);
  const [textDraft, setTextDraft] = useState<TextDraftState | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  const shapesRef = useRef(shapes);
  shapesRef.current = shapes;

  const hasUnsavedChanges =
    shapes.length > 0 || Boolean(textDraft && textDraft.value.trim().length > 0);

  const requestClose = useCallback(() => {
    if (saving) return;
    if (hasUnsavedChanges) {
      setConfirmDiscard(true);
      return;
    }
    onCancel();
  }, [saving, hasUnsavedChanges, onCancel]);

  const selectedShape = useMemo(
    () => (selectedId ? shapes.find((s) => s.id === selectedId) ?? null : null),
    [shapes, selectedId]
  );

  const activeColor = textDraft?.color ?? selectedShape?.color ?? color;
  const activeTextBaseSize =
    textDraft?.fontSize ??
    (selectedShape?.kind === 'text'
      ? (selectedShape.fontSize ?? DEFAULT_TEXT_BASE_SIZE)
      : textBaseSize);

  const pushHistory = useCallback((snapshot: Shape[]) => {
    setUndoStack((prev) => [...prev.slice(-49), snapshot]);
  }, []);

  const handleUndo = useCallback(() => {
    setUndoStack((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      setShapes(last);
      setSelectedId((cur) => (cur && last.some((s) => s.id === cur) ? cur : null));
      return prev.slice(0, -1);
    });
  }, []);

  useEffect(() => {
    let alive = true;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (!alive) return;
      imgRef.current = img;
      setLoaded(true);
    };
    img.src = imageUrl;
    return () => {
      alive = false;
    };
  }, [imageUrl]);

  const toImageCoords = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) return null;
    const rect = canvas.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const imgX = ((clientX - rect.left) / rect.width) * canvas.width;
    const imgY = ((clientY - rect.top) / rect.height) * canvas.height;
    const imgPerCss = canvas.width / rect.width;
    return {
      imgX,
      imgY,
      cssX: clientX - stageRect.left,
      cssY: clientY - stageRect.top,
      stageWidth: stageRect.width,
      stageHeight: stageRect.height,
      imgPerCss,
    };
  }, []);

  const imgToStageCss = useCallback(
    (imgX: number, imgY: number, baseSize = DEFAULT_TEXT_BASE_SIZE) => {
      const canvas = canvasRef.current;
      const stage = stageRef.current;
      if (!canvas || !stage) return { cssX: 16, cssY: 16, fontSize: 16 };
      const rect = canvas.getBoundingClientRect();
      const stageRect = stage.getBoundingClientRect();
      const scaleX = rect.width / canvas.width;
      const scaleY = rect.height / canvas.height;
      const strokeScale = getStrokeScale(canvas.width, canvas.height);
      const { fontSize } = getTextMetrics(strokeScale, baseSize);
      const rawCssX = rect.left - stageRect.left + imgX * scaleX;
      const rawCssY = rect.top - stageRect.top + imgY * scaleY;
      const maxCssX = Math.max(8, stageRect.width - 130);
      const maxCssY = Math.max(8, stageRect.height - 44);
      return {
        cssX: Math.min(Math.max(8, rawCssX), maxCssX),
        cssY: Math.min(Math.max(8, rawCssY), maxCssY),
        fontSize: Math.max(11, Math.min(54, Math.round(fontSize * scaleX))),
      };
    },
    []
  );

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;
    if (canvas.width !== img.naturalWidth || canvas.height !== img.naturalHeight) {
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);

    const strokeScale = getStrokeScale(canvas.width, canvas.height);
    const rect = canvas.getBoundingClientRect();
    const imgPerCss = rect.width > 0 ? canvas.width / rect.width : 1;

    for (const s of shapes) {
      if (textDraft?.editingId === s.id) continue;
      drawShape(ctx, s, strokeScale);
    }
    if (draftShape) drawShape(ctx, draftShape, strokeScale);

    // Live preview for 3-point AB=CD Fib Extension while placing points
    if (fibExtDraft && fibExtDraft.points.length > 0) {
      const pts = fibExtDraft.points;
      const cur = fibExtDraft.cursor;
      if (pts.length === 2 && cur) {
        drawShape(
          ctx,
          {
            id: 'fib-ext-preview',
            kind: 'fib-ext',
            x1: pts[0].x,
            y1: pts[0].y,
            x2: pts[1].x,
            y2: pts[1].y,
            x3: cur.x,
            y3: cur.y,
            color: fibExtDraft.color,
          },
          strokeScale
        );
      } else if (pts.length === 1 && cur) {
        ctx.save();
        ctx.strokeStyle = fibExtDraft.color;
        ctx.globalAlpha = 0.78;
        ctx.lineWidth = Math.max(1.8, 2 * strokeScale);
        ctx.setLineDash([7 * strokeScale, 5 * strokeScale]);
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        ctx.lineTo(cur.x, cur.y);
        ctx.stroke();
        ctx.restore();
      }
      // Draw placed anchor dots
      const px = Math.max(1, imgPerCss);
      ctx.save();
      for (const p of pts) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5 * px, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.lineWidth = 2 * px;
        ctx.strokeStyle = '#2563eb';
        ctx.stroke();
      }
      ctx.restore();
    }

    if (selectedId && !textDraft) {
      const sel = shapes.find((s) => s.id === selectedId);
      if (sel) drawSelectionOverlay(ctx, sel, strokeScale, imgPerCss);
    }
  }, [shapes, draftShape, fibExtDraft, selectedId, textDraft]);

  useEffect(() => {
    if (loaded) redraw();
  }, [loaded, redraw]);

  const textSessionId = textDraft?.sessionId ?? null;
  useEffect(() => {
    if (textSessionId === null) return;
    const raf = requestAnimationFrame(() => {
      const el = textInputRef.current;
      if (!el) return;
      el.focus();
      const len = el.value.length;
      el.setSelectionRange(len, len);
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    });
    return () => cancelAnimationFrame(raf);
  }, [textSessionId]);

  const textDraftValue = textDraft?.value ?? '';
  const textDraftFontSize = textDraft?.fontSize ?? DEFAULT_TEXT_BASE_SIZE;
  useEffect(() => {
    const el = textInputRef.current;
    if (!el || textSessionId === null) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [textDraftValue, textDraftFontSize, textSessionId]);

  const getCommittedTextMaxWidth = useCallback((draft: TextDraftState): number | undefined => {
    const el = textInputRef.current;
    const canvas = canvasRef.current;
    if (el && canvas) {
      const rect = canvas.getBoundingClientRect();
      if (rect.width > 0) {
        const imgPerCss = canvas.width / rect.width;
        const cssWidth = el.offsetWidth;
        const wasResized = Math.abs(cssWidth - draft.initialCssWidth) > 4;
        if (wasResized || draft.maxWidth !== undefined) {
          return Math.max(48, (cssWidth - 10) * imgPerCss);
        }
      }
    }
    return draft.maxWidth;
  }, []);

  const applyTextDraftToShapes = useCallback(
    (
      draft: TextDraftState,
      currentShapes: Shape[]
    ): { nextShapes: Shape[]; nextSelectedId: string | null } => {
      const trimmed = draft.value.replace(/^\s+|\s+$/g, '');
      const committedMaxWidth = getCommittedTextMaxWidth(draft);
      if (draft.editingId) {
        if (!trimmed) {
          return {
            nextShapes: currentShapes.filter((s) => s.id !== draft.editingId),
            nextSelectedId: null,
          };
        }
        return {
          nextShapes: currentShapes.map((s) =>
            s.id === draft.editingId && s.kind === 'text'
              ? {
                  ...s,
                  text: trimmed,
                  color: draft.color,
                  fontSize: draft.fontSize,
                  ...(committedMaxWidth ? { maxWidth: committedMaxWidth } : {}),
                }
              : s
          ),
          nextSelectedId: draft.editingId,
        };
      }
      if (!trimmed) {
        return { nextShapes: currentShapes, nextSelectedId: null };
      }
      const newId = nextShapeId();
      return {
        nextShapes: [
          ...currentShapes,
          {
            id: newId,
            kind: 'text',
            x: draft.imgX,
            y: draft.imgY,
            text: trimmed,
            color: draft.color,
            fontSize: draft.fontSize,
            ...(committedMaxWidth ? { maxWidth: committedMaxWidth } : {}),
          },
        ],
        nextSelectedId: newId,
      };
    },
    [getCommittedTextMaxWidth]
  );

  const commitTextDraft = useCallback(() => {
    if (!textDraft) return;
    const cur = shapesRef.current;
    const { nextShapes, nextSelectedId } = applyTextDraftToShapes(textDraft, cur);
    if (nextShapes !== cur) {
      pushHistory(cur);
      setShapes(nextShapes);
    }
    setSelectedId(nextSelectedId);
    setTextDraft(null);
  }, [textDraft, applyTextDraftToShapes, pushHistory]);

  const openTextEditorForShape = useCallback(
    (shape: Extract<Shape, { kind: 'text' }>) => {
      const baseSize = shape.fontSize ?? DEFAULT_TEXT_BASE_SIZE;
      const pos = imgToStageCss(shape.x, shape.y, baseSize);
      const canvas = canvasRef.current;
      const rect = canvas?.getBoundingClientRect();
      const scaleX = canvas && rect && canvas.width > 0 ? rect.width / canvas.width : 1;
      const initialCssWidth = shape.maxWidth
        ? Math.max(110, Math.round(shape.maxWidth * scaleX) + 12)
        : 200;
      textSessionSeqRef.current += 1;
      setSelectedId(shape.id);
      setTextBaseSize(baseSize);
      setTextDraft({
        sessionId: textSessionSeqRef.current,
        editingId: shape.id,
        imgX: shape.x,
        imgY: shape.y,
        cssX: pos.cssX,
        cssY: pos.cssY,
        value: shape.text,
        color: shape.color,
        fontSize: baseSize,
        maxWidth: shape.maxWidth,
        initialCssWidth,
      });
    },
    [imgToStageCss]
  );

  const handleDeleteSelected = useCallback(() => {
    if (!selectedId) return;
    const cur = shapesRef.current;
    if (!cur.some((s) => s.id === selectedId)) return;
    pushHistory(cur);
    setShapes(cur.filter((s) => s.id !== selectedId));
    setSelectedId(null);
  }, [selectedId, pushHistory]);

  const handleColorSelect = useCallback(
    (nextColor: string) => {
      setColor(nextColor);
      if (fibExtDraft) {
        setFibExtDraft((prev) => (prev ? { ...prev, color: nextColor } : null));
      }
      if (textDraft) {
        setTextDraft((prev) => (prev ? { ...prev, color: nextColor } : null));
        return;
      }
      if (selectedId) {
        const cur = shapesRef.current;
        const target = cur.find((s) => s.id === selectedId);
        if (target && target.color !== nextColor) {
          pushHistory(cur);
          setShapes(cur.map((s) => (s.id === selectedId ? { ...s, color: nextColor } : s)));
        }
      }
    },
    [selectedId, textDraft, fibExtDraft, pushHistory]
  );

  const handleTextSizeSelect = useCallback(
    (nextBaseSize: number) => {
      setTextBaseSize(nextBaseSize);
      if (textDraft) {
        setTextDraft((prev) => (prev ? { ...prev, fontSize: nextBaseSize } : null));
        return;
      }
      if (selectedId) {
        const cur = shapesRef.current;
        const target = cur.find((s) => s.id === selectedId);
        if (
          target &&
          target.kind === 'text' &&
          (target.fontSize ?? DEFAULT_TEXT_BASE_SIZE) !== nextBaseSize
        ) {
          pushHistory(cur);
          setShapes(
            cur.map((s) =>
              s.id === selectedId && s.kind === 'text' ? { ...s, fontSize: nextBaseSize } : s
            )
          );
        }
      }
    },
    [selectedId, textDraft, pushHistory]
  );

  const handleConvertSelectedKind = useCallback(
    (targetKind: ConvertibleKind) => {
      if (!selectedId) return;
      const cur = shapesRef.current;
      const target = cur.find((s) => s.id === selectedId);
      if (!target || target.kind === targetKind) return;
      if (target.kind !== 'arrow' && target.kind !== 'line' && target.kind !== 'rect') return;
      pushHistory(cur);
      setShapes(cur.map((s) => (s.id === selectedId ? convertShapeKind(s, targetKind) : s)));
    },
    [selectedId, pushHistory]
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (confirmDiscard) {
        if (e.key === 'Escape') {
          e.preventDefault();
          setConfirmDiscard(false);
        }
        return;
      }
      if (textDraft) return;
      if (e.key === 'Escape') {
        if (fibExtDraft) setFibExtDraft(null);
        else if (selectedId) setSelectedId(null);
        else requestClose();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        handleUndo();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        e.preventDefault();
        handleDeleteSelected();
      } else if (e.key === 'Enter' && selectedShape?.kind === 'text') {
        e.preventDefault();
        openTextEditorForShape(selectedShape);
      } else if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'v') {
        setFibExtDraft(null);
        setTool('select');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    confirmDiscard,
    requestClose,
    textDraft,
    fibExtDraft,
    selectedId,
    selectedShape,
    handleUndo,
    handleDeleteSelected,
    openTextEditorForShape,
  ]);

  const startDragHandle = (
    shape: Shape,
    handleId: HandleId,
    strokeScale: number
  ) => {
    const snapshot = shapesRef.current;
    const origShape = shape;
    const ctx = canvasRef.current?.getContext('2d') ?? null;
    const origBounds = getShapeBounds(ctx, origShape, strokeScale);
    let mutated = false;

    const handleMove = (moveEvt: MouseEvent) => {
      const cur = toImageCoords(moveEvt.clientX, moveEvt.clientY);
      if (!cur) return;
      mutated = true;

      let updated: Shape = origShape;
      if (
        origShape.kind === 'arrow' ||
        origShape.kind === 'line' ||
        origShape.kind === 'fib-mm'
      ) {
        const useSnap = origShape.kind !== 'fib-mm' && moveEvt.shiftKey;
        if (handleId === 'start') {
          const snapped = snapEndpoint(
            origShape.x2,
            origShape.y2,
            cur.imgX,
            cur.imgY,
            useSnap
          );
          updated = { ...origShape, x1: snapped.x, y1: snapped.y };
        } else {
          const snapped = snapEndpoint(
            origShape.x1,
            origShape.y1,
            cur.imgX,
            cur.imgY,
            useSnap
          );
          updated = { ...origShape, x2: snapped.x, y2: snapped.y };
        }
      } else if (origShape.kind === 'fib-ext') {
        if (handleId === 'p1') {
          updated = { ...origShape, x1: cur.imgX, y1: cur.imgY };
        } else if (handleId === 'p2') {
          updated = { ...origShape, x2: cur.imgX, y2: cur.imgY };
        } else if (handleId === 'p3') {
          updated = { ...origShape, x3: cur.imgX, y3: cur.imgY };
        }
      } else if (origShape.kind === 'rect') {
        const x1 = handleId === 'nw' || handleId === 'sw' ? cur.imgX : origBounds.minX;
        const x2 = handleId === 'ne' || handleId === 'se' ? cur.imgX : origBounds.maxX;
        const y1 = handleId === 'nw' || handleId === 'ne' ? cur.imgY : origBounds.minY;
        const y2 = handleId === 'sw' || handleId === 'se' ? cur.imgY : origBounds.maxY;
        updated = {
          ...origShape,
          x: Math.min(x1, x2),
          y: Math.min(y1, y2),
          w: Math.max(8, Math.abs(x2 - x1)),
          h: Math.max(8, Math.abs(y2 - y1)),
        };
      } else if (origShape.kind === 'highlighter') {
        const oldW = Math.max(1, origBounds.maxX - origBounds.minX);
        const oldH = Math.max(1, origBounds.maxY - origBounds.minY);
        const anchorX = handleId === 'nw' || handleId === 'sw' ? origBounds.maxX : origBounds.minX;
        const anchorY = handleId === 'nw' || handleId === 'ne' ? origBounds.maxY : origBounds.minY;
        const newMinX = Math.min(anchorX, cur.imgX);
        const newMaxX = Math.max(anchorX, cur.imgX);
        const newMinY = Math.min(anchorY, cur.imgY);
        const newMaxY = Math.max(anchorY, cur.imgY);
        const newW = Math.max(12, newMaxX - newMinX);
        const newH = Math.max(12, newMaxY - newMinY);
        updated = {
          ...origShape,
          points: origShape.points.map((pt) => ({
            x: newMinX + ((pt.x - origBounds.minX) / oldW) * newW,
            y: newMinY + ((pt.y - origBounds.minY) / oldH) * newH,
          })),
        };
      } else if (origShape.kind === 'text') {
        const pad = Math.max(4, 4 * strokeScale);
        const { fontSize } = getTextMetrics(strokeScale, origShape.fontSize);
        const minTextW = Math.max(48, fontSize * 2);
        if (handleId === 'e') {
          const nextMaxW = Math.max(minTextW, cur.imgX - origShape.x);
          updated = { ...origShape, maxWidth: nextMaxW };
        } else if (handleId === 'w') {
          const rightEdge = origBounds.maxX - pad;
          const nextX = Math.min(rightEdge - minTextW, cur.imgX);
          const nextMaxW = Math.max(minTextW, rightEdge - nextX);
          updated = { ...origShape, x: nextX, maxWidth: nextMaxW };
        }
      }

      setShapes((prev) => prev.map((s) => (s.id === origShape.id ? updated : s)));
    };

    const handleUp = () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
      if (mutated) pushHistory(snapshot);
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  };

  const startDragMoveShape = (
    shape: Shape,
    startImgX: number,
    startImgY: number
  ) => {
    const snapshot = shapesRef.current;
    const origShape = shape;
    let moved = false;

    const handleMove = (moveEvt: MouseEvent) => {
      const cur = toImageCoords(moveEvt.clientX, moveEvt.clientY);
      if (!cur) return;
      const dx = cur.imgX - startImgX;
      const dy = cur.imgY - startImgY;
      if (!moved && Math.hypot(dx, dy) < 2) return;
      moved = true;
      const updated = translateShape(origShape, dx, dy);
      setShapes((prev) => prev.map((s) => (s.id === origShape.id ? updated : s)));
    };

    const handleUp = () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
      if (moved) pushHistory(snapshot);
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  };

  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || textDraft) {
      if (hoverCursor) setHoverCursor(null);
      return;
    }
    const pt = toImageCoords(e.clientX, e.clientY);
    if (!pt) return;

    if (fibExtDraft) {
      setFibExtDraft((prev) =>
        prev ? { ...prev, cursor: { x: pt.imgX, y: pt.imgY } } : null
      );
      if (hoverCursor !== 'crosshair') setHoverCursor('crosshair');
      return;
    }

    const ctx = canvas.getContext('2d');
    const strokeScale = getStrokeScale(canvas.width, canvas.height);
    const handleRadius = Math.max(10 * pt.imgPerCss, 10 * strokeScale);

    if (selectedShape) {
      const h = hitTestHandle(ctx, selectedShape, pt.imgX, pt.imgY, strokeScale, handleRadius);
      if (h) {
        const cursor =
          h === 'w' || h === 'e'
            ? 'ew-resize'
            : h === 'nw' || h === 'se'
              ? 'nwse-resize'
              : h === 'ne' || h === 'sw'
                ? 'nesw-resize'
                : 'grab';
        if (hoverCursor !== cursor) setHoverCursor(cursor);
        return;
      }
      if (
        tool === 'select' &&
        hitTestShape(ctx, selectedShape, pt.imgX, pt.imgY, strokeScale, 8 * pt.imgPerCss, true)
      ) {
        if (hoverCursor !== 'move') setHoverCursor('move');
        return;
      }
    }

    if (tool === 'select') {
      const hit = findTopShapeAt(ctx, shapes, pt.imgX, pt.imgY, strokeScale, 8 * pt.imgPerCss);
      const next = hit ? 'move' : 'default';
      if (hoverCursor !== next) setHoverCursor(next);
      return;
    }

    if (hoverCursor !== null) setHoverCursor(null);
  };

  const handleCanvasDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || fibExtDraft) return;
    const pt = toImageCoords(e.clientX, e.clientY);
    if (!pt) return;
    const ctx = canvas.getContext('2d');
    const strokeScale = getStrokeScale(canvas.width, canvas.height);
    const hit = findTopShapeAt(ctx, shapes, pt.imgX, pt.imgY, strokeScale, 8 * pt.imgPerCss);
    if (hit && hit.kind === 'text') {
      e.preventDefault();
      openTextEditorForShape(hit);
    }
  };

  const handleCanvasMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    if (textDraft) {
      e.preventDefault();
      commitTextDraft();
      return;
    }
    const canvas = canvasRef.current;
    const pt = toImageCoords(e.clientX, e.clientY);
    if (!canvas || !pt) return;

    const ctx = canvas.getContext('2d');
    const strokeScale = getStrokeScale(canvas.width, canvas.height);
    const handleRadius = Math.max(10 * pt.imgPerCss, 10 * strokeScale);

    // 3-point AB=CD Fib Extension placement
    if (tool === 'fib-ext' && !fibExtDraft && selectedShape) {
      const hitHandle = hitTestHandle(
        ctx,
        selectedShape,
        pt.imgX,
        pt.imgY,
        strokeScale,
        handleRadius
      );
      if (hitHandle) {
        e.preventDefault();
        startDragHandle(selectedShape, hitHandle, strokeScale);
        return;
      }
    }

    if (tool === 'fib-ext') {
      e.preventDefault();
      const p = { x: pt.imgX, y: pt.imgY };
      if (!fibExtDraft) {
        setSelectedId(null);
        setFibExtDraft({ points: [p], cursor: p, color });
        return;
      }
      if (fibExtDraft.points.length === 1) {
        setFibExtDraft({
          ...fibExtDraft,
          points: [...fibExtDraft.points, p],
          cursor: p,
        });
        return;
      }
      // 3rd point placed -> finalize AB=CD Fib Extension
      const [p1, p2] = fibExtDraft.points;
      const newId = nextShapeId();
      const created: Shape = {
        id: newId,
        kind: 'fib-ext',
        x1: p1.x,
        y1: p1.y,
        x2: p2.x,
        y2: p2.y,
        x3: p.x,
        y3: p.y,
        color: fibExtDraft.color,
      };
      const cur = shapesRef.current;
      pushHistory(cur);
      setShapes([...cur, created]);
      setFibExtDraft(null);
      setSelectedId(newId);
      return;
    }

    // Always allow dragging a handle of the currently selected shape
    if (selectedShape) {
      const hitHandle = hitTestHandle(
        ctx,
        selectedShape,
        pt.imgX,
        pt.imgY,
        strokeScale,
        handleRadius
      );
      if (hitHandle) {
        e.preventDefault();
        startDragHandle(selectedShape, hitHandle, strokeScale);
        return;
      }
    }

    if (tool === 'select') {
      e.preventDefault();
      const hit = findTopShapeAt(ctx, shapes, pt.imgX, pt.imgY, strokeScale, 8 * pt.imgPerCss);
      if (hit) {
        setSelectedId(hit.id);
        setColor(hit.color);
        if (hit.kind === 'text') {
          setTextBaseSize(hit.fontSize ?? DEFAULT_TEXT_BASE_SIZE);
        }
        startDragMoveShape(hit, pt.imgX, pt.imgY);
      } else {
        setSelectedId(null);
      }
      return;
    }

    if (tool === 'text') {
      e.preventDefault();
      const hit = findTopShapeAt(ctx, shapes, pt.imgX, pt.imgY, strokeScale, 8 * pt.imgPerCss);
      if (hit && hit.kind === 'text') {
        openTextEditorForShape(hit);
        return;
      }
      const pos = imgToStageCss(pt.imgX, pt.imgY, textBaseSize);
      textSessionSeqRef.current += 1;
      setSelectedId(null);
      setTextDraft({
        sessionId: textSessionSeqRef.current,
        editingId: null,
        imgX: pt.imgX,
        imgY: pt.imgY,
        cssX: pos.cssX,
        cssY: pos.cssY,
        value: '',
        color,
        fontSize: textBaseSize,
        initialCssWidth: 200,
      });
      return;
    }

    setSelectedId(null);
    const startX = pt.imgX;
    const startY = pt.imgY;
    const strokePoints: { x: number; y: number }[] = [{ x: startX, y: startY }];
    const drawColor = color;
    const draftId = nextShapeId();

    const handleMove = (moveEvt: MouseEvent) => {
      const cur = toImageCoords(moveEvt.clientX, moveEvt.clientY);
      if (!cur) return;
      if (tool === 'arrow') {
        const snapped = snapEndpoint(startX, startY, cur.imgX, cur.imgY, moveEvt.shiftKey);
        setDraftShape({
          id: draftId,
          kind: 'arrow',
          x1: startX,
          y1: startY,
          x2: snapped.x,
          y2: snapped.y,
          color: drawColor,
        });
      } else if (tool === 'line') {
        const snapped = snapEndpoint(startX, startY, cur.imgX, cur.imgY, moveEvt.shiftKey);
        setDraftShape({
          id: draftId,
          kind: 'line',
          x1: startX,
          y1: startY,
          x2: snapped.x,
          y2: snapped.y,
          color: drawColor,
        });
      } else if (tool === 'fib-mm') {
        setDraftShape({
          id: draftId,
          kind: 'fib-mm',
          x1: startX,
          y1: startY,
          x2: cur.imgX,
          y2: cur.imgY,
          color: drawColor,
        });
      } else if (tool === 'highlighter') {
        const last = strokePoints[strokePoints.length - 1];
        if (Math.hypot(cur.imgX - last.x, cur.imgY - last.y) >= 3) {
          strokePoints.push({ x: cur.imgX, y: cur.imgY });
          setDraftShape({
            id: draftId,
            kind: 'highlighter',
            points: [...strokePoints],
            color: drawColor,
          });
        }
      } else {
        setDraftShape({
          id: draftId,
          kind: 'rect',
          x: Math.min(startX, cur.imgX),
          y: Math.min(startY, cur.imgY),
          w: Math.abs(cur.imgX - startX),
          h: Math.abs(cur.imgY - startY),
          color: drawColor,
        });
      }
    };

    const handleUp = (upEvt: MouseEvent) => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
      const end = toImageCoords(upEvt.clientX, upEvt.clientY);
      setDraftShape(null);
      if (!end) return;

      let created: Shape | null = null;
      if (tool === 'highlighter') {
        if (strokePoints.length >= 2) {
          created = {
            id: draftId,
            kind: 'highlighter',
            points: [...strokePoints],
            color: drawColor,
          };
        }
      } else {
        const dist = Math.hypot(end.imgX - startX, end.imgY - startY);
        if (dist >= 6) {
          if (tool === 'arrow') {
            const snapped = snapEndpoint(startX, startY, end.imgX, end.imgY, upEvt.shiftKey);
            created = {
              id: draftId,
              kind: 'arrow',
              x1: startX,
              y1: startY,
              x2: snapped.x,
              y2: snapped.y,
              color: drawColor,
            };
          } else if (tool === 'line') {
            const snapped = snapEndpoint(startX, startY, end.imgX, end.imgY, upEvt.shiftKey);
            created = {
              id: draftId,
              kind: 'line',
              x1: startX,
              y1: startY,
              x2: snapped.x,
              y2: snapped.y,
              color: drawColor,
            };
          } else if (tool === 'fib-mm') {
            created = {
              id: draftId,
              kind: 'fib-mm',
              x1: startX,
              y1: startY,
              x2: end.imgX,
              y2: end.imgY,
              color: drawColor,
            };
          } else {
            created = {
              id: draftId,
              kind: 'rect',
              x: Math.min(startX, end.imgX),
              y: Math.min(startY, end.imgY),
              w: Math.abs(end.imgX - startX),
              h: Math.abs(end.imgY - startY),
              color: drawColor,
            };
          }
        }
      }

      if (created) {
        const cur = shapesRef.current;
        pushHistory(cur);
        setShapes([...cur, created]);
        setSelectedId(created.id);
      }
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  };

  const handleSave = async () => {
    if (saving) return;
    const img = imgRef.current;
    if (!img) return;

    let finalShapes = shapesRef.current;
    if (textDraft) {
      const { nextShapes } = applyTextDraftToShapes(textDraft, finalShapes);
      finalShapes = nextShapes;
      setShapes(finalShapes);
      setTextDraft(null);
    }
    setFibExtDraft(null);

    setSaving(true);
    try {
      const exportCanvas = document.createElement('canvas');
      exportCanvas.width = img.naturalWidth;
      exportCanvas.height = img.naturalHeight;
      const ctx = exportCanvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(img, 0, 0);
      const strokeScale = getStrokeScale(exportCanvas.width, exportCanvas.height);
      for (const s of finalShapes) {
        drawShape(ctx, s, strokeScale);
      }

      const blob = await new Promise<Blob | null>((resolve) =>
        exportCanvas.toBlob(resolve, 'image/png')
      );
      if (!blob) return;
      const file = new File([blob], `annotated-${Date.now()}.png`, {
        type: 'image/png',
      });
      await onSave(file);
    } finally {
      setSaving(false);
    }
  };

  const switchTool = (nextTool: AnnotatorTool) => {
    if (textDraft) commitTextDraft();
    setFibExtDraft(null);
    setTool(nextTool);
  };

  const canvasCursor =
    hoverCursor ??
    (tool === 'select' ? 'default' : tool === 'text' ? 'text' : 'crosshair');

  const textInputFontSize = textDraft
    ? imgToStageCss(textDraft.imgX, textDraft.imgY, textDraft.fontSize).fontSize
    : 15;

  const showTextSizeBar =
    Boolean(textDraft) || tool === 'text' || selectedShape?.kind === 'text';
  const showFibExtPrompt = tool === 'fib-ext' && !selectedShape && !textDraft;
  const showContextBar =
    Boolean(selectedShape && !textDraft) || showTextSizeBar || showFibExtPrompt;

  return (
    <div
      className="img-annotator-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          if (textDraft) commitTextDraft();
          else if (fibExtDraft) setFibExtDraft(null);
          else requestClose();
        }
      }}
    >
      <div
        className="img-annotator-toolbar"
        onMouseDown={(e) => {
          e.stopPropagation();
          if (textDraft) e.preventDefault();
        }}
      >
        <button
          type="button"
          className={`img-annotator-btn ${tool === 'select' ? 'is-active' : ''}`}
          title="选择并移动、调整形状或换色 (V)"
          onClick={() => switchTool('select')}
        >
          <MousePointer2 size={14} />
          <span>选择</span>
        </button>
        <button
          type="button"
          className={`img-annotator-btn ${tool === 'arrow' ? 'is-active' : ''}`}
          title="画箭头（按住 Shift 锁定水平/垂直/45°）"
          onClick={() => switchTool('arrow')}
        >
          <ArrowUpRight size={15} />
          <span>箭头</span>
        </button>
        <button
          type="button"
          className={`img-annotator-btn ${tool === 'line' ? 'is-active' : ''}`}
          title="画线段（按住 Shift 锁定水平/垂直/45°）"
          onClick={() => switchTool('line')}
        >
          <Minus size={15} />
          <span>线段</span>
        </button>
        <button
          type="button"
          className={`img-annotator-btn ${tool === 'rect' ? 'is-active' : ''}`}
          title="画矩形框"
          onClick={() => switchTool('rect')}
        >
          <Square size={14} />
          <span>方框</span>
        </button>
        <button
          type="button"
          className={`img-annotator-btn ${tool === 'highlighter' ? 'is-active' : ''}`}
          title="半透明荧光笔（标出关键 K 线区间）"
          onClick={() => switchTool('highlighter')}
        >
          <Highlighter size={14} />
          <span>荧光笔</span>
        </button>
        <button
          type="button"
          className={`img-annotator-btn ${tool === 'fib-mm' ? 'is-active' : ''}`}
          title="斐波那契等距目标 MM（1 / 0 / -1，拖拽两点画出一倍投射）"
          onClick={() => switchTool('fib-mm')}
        >
          <Rows3 size={14} />
          <span>MM</span>
        </button>
        <button
          type="button"
          className={`img-annotator-btn ${tool === 'fib-ext' ? 'is-active' : ''}`}
          title="斐波那契扩展 AB=CD（0 / 1，依次点击 A、B、C 三点）"
          onClick={() => switchTool('fib-ext')}
        >
          <Activity size={14} />
          <span>AB=CD</span>
        </button>
        <button
          type="button"
          className={`img-annotator-btn ${tool === 'text' ? 'is-active' : ''}`}
          title="添加或点击修改文字标注"
          onClick={() => switchTool('text')}
        >
          <Type size={14} />
          <span>文字</span>
        </button>

        <span className="img-annotator-sep" />

        <div className="img-annotator-colors">
          {PALETTE.map((swatch) => (
            <button
              key={swatch.value}
              type="button"
              className={`img-annotator-swatch ${activeColor === swatch.value ? 'is-active' : ''}`}
              style={{ background: swatch.value }}
              title={selectedShape || textDraft ? `将选中标注改为${swatch.name}色` : swatch.name}
              onClick={() => handleColorSelect(swatch.value)}
            />
          ))}
        </div>

        <span className="img-annotator-sep" />

        <button
          type="button"
          className="img-annotator-btn"
          title="撤销上一步 (⌘Z)"
          disabled={undoStack.length === 0}
          onClick={handleUndo}
        >
          <Undo2 size={14} />
        </button>

        <button
          type="button"
          className="img-annotator-btn"
          title="取消 (Esc)"
          onClick={requestClose}
        >
          <X size={14} />
          <span>取消</span>
        </button>

        <button
          type="button"
          className="img-annotator-btn img-annotator-btn--primary"
          disabled={saving || !loaded}
          onClick={() => void handleSave()}
        >
          <Check size={14} />
          <span>{saving ? '保存中…' : '保存标注'}</span>
        </button>
      </div>

      <div
        ref={stageRef}
        className="img-annotator-stage"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <canvas
          ref={canvasRef}
          className="img-annotator-canvas"
          style={{ cursor: canvasCursor }}
          onMouseDown={handleCanvasMouseDown}
          onMouseMove={handleCanvasMouseMove}
          onDoubleClick={handleCanvasDoubleClick}
        />
        {textDraft && (
          <textarea
            ref={textInputRef}
            className="img-annotator-text-input"
            style={{
              left: `${textDraft.cssX}px`,
              top: `${textDraft.cssY}px`,
              width: `${textDraft.initialCssWidth}px`,
              color: textDraft.color,
              fontSize: `${textInputFontSize}px`,
            }}
            rows={1}
            placeholder="输入文字，Enter 换行"
            value={textDraft.value}
            onMouseDown={(e) => e.stopPropagation()}
            onChange={(e) =>
              setTextDraft((prev) => (prev ? { ...prev, value: e.target.value } : null))
            }
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                commitTextDraft();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setTextDraft(null);
              }
            }}
          />
        )}
      </div>

      {/* Fixed-bottom floating contextual bar so appearing/disappearing never shifts the image */}
      {showContextBar && (
        <div
          className="img-annotator-selection-bar"
          onMouseDown={(e) => {
            e.stopPropagation();
            if (textDraft) e.preventDefault();
          }}
        >
          {showFibExtPrompt && (
            <span className="img-annotator-selection-hint">
              {!fibExtDraft
                ? 'AB=CD 扩展：依次点击第 1 点 (A)、第 2 点 (B)、第 3 点 (C)'
                : fibExtDraft.points.length === 1
                  ? '已定 A 点，请点击确定第 2 点 (B)（Esc 取消）'
                  : '已定 A、B 点，请点击确定回调点 (C) 完成投射（Esc 取消）'}
            </span>
          )}

          {showTextSizeBar && (
            <>
              <span className="img-annotator-selection-label">字号</span>
              {TEXT_SIZES.map((item) => (
                <button
                  key={item.base}
                  type="button"
                  className={`img-annotator-btn img-annotator-btn--compact ${
                    activeTextBaseSize === item.base ? 'is-active' : ''
                  }`}
                  onClick={() => handleTextSizeSelect(item.base)}
                >
                  <span>{item.label}</span>
                </button>
              ))}
              {(selectedShape && !textDraft) || textDraft ? (
                <span className="img-annotator-sep" />
              ) : null}
            </>
          )}

          {textDraft && (
            <span className="img-annotator-selection-hint">
              Enter 换行 · 拖右下角拉宽折行 · ⌘+Enter 或点空白确认
            </span>
          )}

          {selectedShape && !textDraft && (
            <>
              {(selectedShape.kind === 'arrow' ||
                selectedShape.kind === 'line' ||
                selectedShape.kind === 'rect') && (
                <>
                  <span className="img-annotator-selection-label">更换形状</span>
                  <button
                    type="button"
                    className={`img-annotator-btn img-annotator-btn--compact ${
                      selectedShape.kind === 'arrow' ? 'is-active' : ''
                    }`}
                    onClick={() => handleConvertSelectedKind('arrow')}
                  >
                    <ArrowUpRight size={13} />
                    <span>箭头</span>
                  </button>
                  <button
                    type="button"
                    className={`img-annotator-btn img-annotator-btn--compact ${
                      selectedShape.kind === 'line' ? 'is-active' : ''
                    }`}
                    onClick={() => handleConvertSelectedKind('line')}
                  >
                    <Minus size={13} />
                    <span>线段</span>
                  </button>
                  <button
                    type="button"
                    className={`img-annotator-btn img-annotator-btn--compact ${
                      selectedShape.kind === 'rect' ? 'is-active' : ''
                    }`}
                    onClick={() => handleConvertSelectedKind('rect')}
                  >
                    <Square size={12} />
                    <span>方框</span>
                  </button>
                  <span className="img-annotator-sep" />
                </>
              )}

              {selectedShape.kind === 'text' && (
                <>
                  <button
                    type="button"
                    className="img-annotator-btn img-annotator-btn--compact"
                    onClick={() => openTextEditorForShape(selectedShape)}
                  >
                    <Pencil size={12} />
                    <span>编辑文字</span>
                  </button>
                  <span className="img-annotator-sep" />
                </>
              )}

              <span className="img-annotator-selection-hint">
                {selectedShape.kind === 'text'
                  ? '拖动移动 · 拖左右边界折行 · 双击改字'
                  : selectedShape.kind === 'fib-ext'
                    ? '拖动 A/B/C 三点调整 · 拖动移动 · 点上方色块换色'
                    : selectedShape.kind === 'fib-mm'
                      ? '拖动 1/0 两点调整 · 拖动移动 · 点上方色块换色'
                      : '拖动端点/角点调整 · 拖动移动 · 点上方色块换色'}
              </span>

              <span className="img-annotator-sep" />

              <button
                type="button"
                className="img-annotator-btn img-annotator-btn--compact img-annotator-btn--danger"
                title="删除选中标注 (Delete)"
                onClick={handleDeleteSelected}
              >
                <Trash2 size={13} />
                <span>删除</span>
              </button>
            </>
          )}
        </div>
      )}

      {confirmDiscard && (
        <div
          className="img-annotator-confirm-backdrop"
          onMouseDown={(e) => {
            e.stopPropagation();
            if (e.target === e.currentTarget) setConfirmDiscard(false);
          }}
        >
          <div
            className="confirm-dialog"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <h2>放弃未保存的标注？</h2>
            <p>当前图片还有未保存的标注，直接离开会丢失这些修改。</p>
            <div className="confirm-dialog__actions">
              <button
                type="button"
                className="confirm-dialog__cancel"
                onClick={() => setConfirmDiscard(false)}
              >
                继续编辑
              </button>
              <button
                type="button"
                className="confirm-dialog__danger"
                onClick={() => {
                  setConfirmDiscard(false);
                  onCancel();
                }}
              >
                放弃离开
              </button>
              <button
                type="button"
                className="img-annotator-confirm-primary"
                disabled={saving || !loaded}
                onClick={() => {
                  setConfirmDiscard(false);
                  void handleSave();
                }}
              >
                保存并离开
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUpRight,
  Check,
  Highlighter,
  Minus,
  MousePointer2,
  Pencil,
  Square,
  Trash2,
  Type,
  Undo2,
  X,
} from 'lucide-react';

type AnnotatorTool = 'select' | 'arrow' | 'line' | 'rect' | 'highlighter' | 'text';
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
      kind: 'text';
      x: number;
      y: number;
      text: string;
      color: string;
    };

type HandleId = 'start' | 'end' | 'nw' | 'ne' | 'sw' | 'se';

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
}

const PALETTE = [
  { name: '红', value: '#ef4444' },
  { name: '绿', value: '#16a34a' },
  { name: '蓝', value: '#2563eb' },
  { name: '黄', value: '#eab308' },
];

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

function getTextMetrics(strokeScale: number) {
  const fontSize = Math.max(16, Math.round(20 * strokeScale));
  const lineHeight = Math.round(fontSize * 1.32);
  const font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif`;
  return { fontSize, lineHeight, font };
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
  const { fontSize, lineHeight, font } = getTextMetrics(strokeScale);
  const lines = shape.text.split('\n');
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
  const pad = Math.max(4, 4 * strokeScale);
  return {
    minX: shape.x - pad,
    minY: shape.y - pad,
    maxX: shape.x + maxW + pad,
    maxY: shape.y + lines.length * lineHeight + pad,
  };
}

function getShapeHandles(
  ctx: CanvasRenderingContext2D | null,
  shape: Shape,
  strokeScale: number
): HandlePoint[] {
  if (shape.kind === 'arrow' || shape.kind === 'line') {
    return [
      { id: 'start', x: shape.x1, y: shape.y1 },
      { id: 'end', x: shape.x2, y: shape.y2 },
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
  // Pass 1: exact strokes, text, and rectangle borders
  for (let i = shapes.length - 1; i >= 0; i -= 1) {
    if (hitTestShape(ctx, shapes[i], px, py, strokeScale, tolerance, false)) {
      return shapes[i];
    }
  }
  // Pass 2: rectangle interior fallback
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
  if (shape.kind === 'arrow' || shape.kind === 'line') {
    return {
      ...shape,
      x1: shape.x1 + dx,
      y1: shape.y1 + dy,
      x2: shape.x2 + dx,
      y2: shape.y2 + dy,
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
    // arrow/line -> rect
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
    const { lineHeight, font } = getTextMetrics(strokeScale);
    ctx.font = font;
    ctx.textBaseline = 'top';
    const lines = shape.text.split('\n');
    lines.forEach((line, idx) => {
      const ly = shape.y + idx * lineHeight;
      ctx.lineWidth = Math.max(3, 4 * strokeScale);
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
  } else {
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
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [undoStack, setUndoStack] = useState<Shape[][]>([]);
  const [draftShape, setDraftShape] = useState<Shape | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoverCursor, setHoverCursor] = useState<string | null>(null);
  const [textDraft, setTextDraft] = useState<TextDraftState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  const shapesRef = useRef(shapes);
  shapesRef.current = shapes;

  const selectedShape = useMemo(
    () => (selectedId ? shapes.find((s) => s.id === selectedId) ?? null : null),
    [shapes, selectedId]
  );

  const activeColor = textDraft?.color ?? selectedShape?.color ?? color;

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

  const imgToStageCss = useCallback((imgX: number, imgY: number) => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) return { cssX: 16, cssY: 16, fontSize: 16 };
    const rect = canvas.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    const scaleX = rect.width / canvas.width;
    const scaleY = rect.height / canvas.height;
    const strokeScale = getStrokeScale(canvas.width, canvas.height);
    const { fontSize } = getTextMetrics(strokeScale);
    const rawCssX = rect.left - stageRect.left + imgX * scaleX;
    const rawCssY = rect.top - stageRect.top + imgY * scaleY;
    const maxCssX = Math.max(8, stageRect.width - 176);
    const maxCssY = Math.max(8, stageRect.height - 64);
    return {
      cssX: Math.min(Math.max(8, rawCssX), maxCssX),
      cssY: Math.min(Math.max(8, rawCssY), maxCssY),
      fontSize: Math.max(13, Math.min(28, Math.round(fontSize * scaleX))),
    };
  }, []);

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

    if (selectedId && !textDraft) {
      const sel = shapes.find((s) => s.id === selectedId);
      if (sel) drawSelectionOverlay(ctx, sel, strokeScale, imgPerCss);
    }
  }, [shapes, draftShape, selectedId, textDraft]);

  useEffect(() => {
    if (loaded) redraw();
  }, [loaded, redraw]);

  // Focus text input only when a new text editing session begins (not on every keystroke)
  const textSessionId = textDraft?.sessionId ?? null;
  useEffect(() => {
    if (textSessionId === null) return;
    const raf = requestAnimationFrame(() => {
      const el = textInputRef.current;
      if (!el) return;
      el.focus();
      const len = el.value.length;
      el.setSelectionRange(len, len);
    });
    return () => cancelAnimationFrame(raf);
  }, [textSessionId]);

  const applyTextDraftToShapes = useCallback(
    (draft: TextDraftState, currentShapes: Shape[]): { nextShapes: Shape[]; nextSelectedId: string | null } => {
      const trimmed = draft.value.trim();
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
              ? { ...s, text: trimmed, color: draft.color }
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
          },
        ],
        nextSelectedId: newId,
      };
    },
    []
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
      const pos = imgToStageCss(shape.x, shape.y);
      textSessionSeqRef.current += 1;
      setSelectedId(shape.id);
      setTextDraft({
        sessionId: textSessionSeqRef.current,
        editingId: shape.id,
        imgX: shape.x,
        imgY: shape.y,
        cssX: pos.cssX,
        cssY: pos.cssY,
        value: shape.text,
        color: shape.color,
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
      if (textDraft) return;
      if (e.key === 'Escape') {
        if (selectedId) setSelectedId(null);
        else onCancel();
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
        setTool('select');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    onCancel,
    textDraft,
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
      if (origShape.kind === 'arrow' || origShape.kind === 'line') {
        if (handleId === 'start') {
          const snapped = snapEndpoint(
            origShape.x2,
            origShape.y2,
            cur.imgX,
            cur.imgY,
            moveEvt.shiftKey
          );
          updated = { ...origShape, x1: snapped.x, y1: snapped.y };
        } else {
          const snapped = snapEndpoint(
            origShape.x1,
            origShape.y1,
            cur.imgX,
            cur.imgY,
            moveEvt.shiftKey
          );
          updated = { ...origShape, x2: snapped.x, y2: snapped.y };
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
    const ctx = canvas.getContext('2d');
    const strokeScale = getStrokeScale(canvas.width, canvas.height);
    const handleRadius = Math.max(10 * pt.imgPerCss, 10 * strokeScale);

    if (selectedShape) {
      const h = hitTestHandle(ctx, selectedShape, pt.imgX, pt.imgY, strokeScale, handleRadius);
      if (h) {
        const cursor =
          h === 'nw' || h === 'se'
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
    if (!canvas) return;
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

    // Always allow dragging a handle of the currently selected shape, even while in a draw tool
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
        startDragMoveShape(hit, pt.imgX, pt.imgY);
      } else {
        setSelectedId(null);
      }
      return;
    }

    if (tool === 'text') {
      // Prevent browser default mousedown focus reset so the newly mounted textarea keeps focus!
      e.preventDefault();
      // If clicking directly on an existing text annotation, edit it instead of stacking a new one
      const hit = findTopShapeAt(ctx, shapes, pt.imgX, pt.imgY, strokeScale, 8 * pt.imgPerCss);
      if (hit && hit.kind === 'text') {
        openTextEditorForShape(hit);
        return;
      }
      const pos = imgToStageCss(pt.imgX, pt.imgY);
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
        // Keep the newly drawn shape selected so the user can immediately tweak handles or recolor it
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

    setSaving(true);
    try {
      // Render cleanly onto an offscreen canvas so selection outlines/handles never leak into the PNG
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
    setTool(nextTool);
  };

  const canvasCursor =
    hoverCursor ??
    (tool === 'select' ? 'default' : tool === 'text' ? 'text' : 'crosshair');

  const textInputFontSize = textDraft
    ? imgToStageCss(textDraft.imgX, textDraft.imgY).fontSize
    : 15;

  return (
    <div
      className="img-annotator-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          if (textDraft) commitTextDraft();
          else onCancel();
        }
      }}
    >
      <div
        className="img-annotator-toolbar"
        onMouseDown={(e) => {
          e.stopPropagation();
          // Keep text input focused when clicking color swatches or toolbar controls
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
          onClick={onCancel}
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

      {selectedShape && !textDraft && (
        <div
          className="img-annotator-selection-bar"
          onMouseDown={(e) => e.stopPropagation()}
        >
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
              ? '拖动移动 · 双击改字 · 点上方色块换色'
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
        </div>
      )}

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
              color: textDraft.color,
              fontSize: `${textInputFontSize}px`,
            }}
            rows={2}
            placeholder="输入文字，Enter 确认 / Shift+Enter 换行"
            value={textDraft.value}
            onMouseDown={(e) => e.stopPropagation()}
            onChange={(e) =>
              setTextDraft((prev) => (prev ? { ...prev, value: e.target.value } : null))
            }
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
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
    </div>
  );
};

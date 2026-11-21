import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowUpRight,
  Check,
  Square,
  Type,
  Undo2,
  X,
} from 'lucide-react';

type AnnotatorTool = 'arrow' | 'rect' | 'text';

type Shape =
  | {
      kind: 'arrow';
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      color: string;
    }
  | {
      kind: 'rect';
      x: number;
      y: number;
      w: number;
      h: number;
      color: string;
    }
  | {
      kind: 'text';
      x: number;
      y: number;
      text: string;
      color: string;
    };

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
  } else if (shape.kind === 'rect') {
    ctx.strokeRect(shape.x, shape.y, shape.w, shape.h);
  } else if (shape.kind === 'text') {
    const fontSize = Math.max(16, Math.round(20 * strokeScale));
    ctx.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif`;
    ctx.textBaseline = 'top';
    const lines = shape.text.split('\n');
    const lineHeight = Math.round(fontSize * 1.32);
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

export const ImageAnnotatorModal: React.FC<ImageAnnotatorModalProps> = ({
  imageUrl,
  onCancel,
  onSave,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const textInputRef = useRef<HTMLTextAreaElement | null>(null);

  const [tool, setTool] = useState<AnnotatorTool>('arrow');
  const [color, setColor] = useState<string>(PALETTE[0].value);
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [draftShape, setDraftShape] = useState<Shape | null>(null);
  const [textDraft, setTextDraft] = useState<{
    imgX: number;
    imgY: number;
    cssX: number;
    cssY: number;
    value: string;
  } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

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

    const strokeScale = Math.max(0.75, Math.min(2.2, Math.max(canvas.width, canvas.height) / 900));
    for (const s of shapes) drawShape(ctx, s, strokeScale);
    if (draftShape) drawShape(ctx, draftShape, strokeScale);
  }, [shapes, draftShape]);

  useEffect(() => {
    if (loaded) redraw();
  }, [loaded, redraw]);

  useEffect(() => {
    if (textDraft) {
      textInputRef.current?.focus();
    }
  }, [textDraft]);

  const commitTextDraft = useCallback(() => {
    if (!textDraft) return;
    const trimmed = textDraft.value.trim();
    if (trimmed) {
      setShapes((prev) => [
        ...prev,
        {
          kind: 'text',
          x: textDraft.imgX,
          y: textDraft.imgY,
          text: trimmed,
          color,
        },
      ]);
    }
    setTextDraft(null);
  }, [textDraft, color]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (textDraft) setTextDraft(null);
        else onCancel();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !textDraft) {
        e.preventDefault();
        setShapes((prev) => prev.slice(0, -1));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel, textDraft]);

  const toImageCoords = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const imgX = ((clientX - rect.left) / rect.width) * canvas.width;
    const imgY = ((clientY - rect.top) / rect.height) * canvas.height;
    return {
      imgX,
      imgY,
      cssX: clientX - rect.left,
      cssY: clientY - rect.top,
    };
  };

  const handleCanvasMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    if (textDraft) {
      commitTextDraft();
      return;
    }
    const pt = toImageCoords(e.clientX, e.clientY);
    if (!pt) return;

    if (tool === 'text') {
      setTextDraft({
        imgX: pt.imgX,
        imgY: pt.imgY,
        cssX: pt.cssX,
        cssY: pt.cssY,
        value: '',
      });
      return;
    }

    const startX = pt.imgX;
    const startY = pt.imgY;

    const handleMove = (moveEvt: MouseEvent) => {
      const cur = toImageCoords(moveEvt.clientX, moveEvt.clientY);
      if (!cur) return;
      if (tool === 'arrow') {
        setDraftShape({
          kind: 'arrow',
          x1: startX,
          y1: startY,
          x2: cur.imgX,
          y2: cur.imgY,
          color,
        });
      } else {
        setDraftShape({
          kind: 'rect',
          x: Math.min(startX, cur.imgX),
          y: Math.min(startY, cur.imgY),
          w: Math.abs(cur.imgX - startX),
          h: Math.abs(cur.imgY - startY),
          color,
        });
      }
    };

    const handleUp = (upEvt: MouseEvent) => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
      const end = toImageCoords(upEvt.clientX, upEvt.clientY);
      setDraftShape(null);
      if (!end) return;
      const dist = Math.hypot(end.imgX - startX, end.imgY - startY);
      if (dist < 6) return;
      if (tool === 'arrow') {
        setShapes((prev) => [
          ...prev,
          { kind: 'arrow', x1: startX, y1: startY, x2: end.imgX, y2: end.imgY, color },
        ]);
      } else {
        setShapes((prev) => [
          ...prev,
          {
            kind: 'rect',
            x: Math.min(startX, end.imgX),
            y: Math.min(startY, end.imgY),
            w: Math.abs(end.imgX - startX),
            h: Math.abs(end.imgY - startY),
            color,
          },
        ]);
      }
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  };

  const handleSave = async () => {
    if (saving) return;
    if (textDraft) commitTextDraft();
    const canvas = canvasRef.current;
    if (!canvas) return;
    setSaving(true);
    try {
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/png')
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

  return (
    <div
      className="img-annotator-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="img-annotator-toolbar" onMouseDown={(e) => e.stopPropagation()}>
        <button
          type="button"
          className={`img-annotator-btn ${tool === 'arrow' ? 'is-active' : ''}`}
          title="画箭头"
          onClick={() => setTool('arrow')}
        >
          <ArrowUpRight size={15} />
          <span>箭头</span>
        </button>
        <button
          type="button"
          className={`img-annotator-btn ${tool === 'rect' ? 'is-active' : ''}`}
          title="画矩形框"
          onClick={() => setTool('rect')}
        >
          <Square size={14} />
          <span>方框</span>
        </button>
        <button
          type="button"
          className={`img-annotator-btn ${tool === 'text' ? 'is-active' : ''}`}
          title="添加文字标注"
          onClick={() => setTool('text')}
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
              className={`img-annotator-swatch ${color === swatch.value ? 'is-active' : ''}`}
              style={{ background: swatch.value }}
              title={swatch.name}
              onClick={() => setColor(swatch.value)}
            />
          ))}
        </div>

        <span className="img-annotator-sep" />

        <button
          type="button"
          className="img-annotator-btn"
          title="撤销上一笔 (⌘Z)"
          disabled={shapes.length === 0}
          onClick={() => setShapes((prev) => prev.slice(0, -1))}
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

      <div className="img-annotator-stage" onMouseDown={(e) => e.stopPropagation()}>
        <canvas
          ref={canvasRef}
          className="img-annotator-canvas"
          style={{ cursor: tool === 'text' ? 'text' : 'crosshair' }}
          onMouseDown={handleCanvasMouseDown}
        />
        {textDraft && (
          <textarea
            ref={textInputRef}
            className="img-annotator-text-input"
            style={{
              left: `${textDraft.cssX}px`,
              top: `${textDraft.cssY}px`,
              color,
            }}
            rows={2}
            placeholder="输入文字，⌘+Enter 确认"
            value={textDraft.value}
            onChange={(e) =>
              setTextDraft((prev) => (prev ? { ...prev, value: e.target.value } : null))
            }
            onBlur={commitTextDraft}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
                e.preventDefault();
                commitTextDraft();
              } else if (e.key === 'Escape') {
                e.stopPropagation();
                setTextDraft(null);
              }
            }}
          />
        )}
      </div>
    </div>
  );
};

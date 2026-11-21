import React, { useEffect, useState } from 'react';
import {
  Check,
  Copy,
  Highlighter,
  Link2,
  MessageSquarePlus,
  Underline,
} from 'lucide-react';
import type { AnchorColor, AnnotationStyle } from '../types';

export const ANCHOR_COLORS: {
  id: AnchorColor;
  label: string;
  swatch: string;
  shortcut: string;
}[] = [
  { id: 'amber', label: '重点黄', swatch: '#eab308', shortcut: '1' },
  { id: 'green', label: '多头绿', swatch: '#16a34a', shortcut: '2' },
  { id: 'rose', label: '警示红', swatch: '#e11d48', shortcut: '3' },
  { id: 'blue', label: '思考蓝', swatch: '#2563eb', shortcut: '4' },
];

const LS_STYLE_KEY = 'readingbook.lastAnnotationStyle';
const LS_COLOR_KEY = 'readingbook.lastAnnotationColor';

function readSavedStyle(): AnnotationStyle {
  try {
    const v = localStorage.getItem(LS_STYLE_KEY);
    if (v === 'highlight' || v === 'underline') return v;
  } catch {
    // ignore storage errors
  }
  return 'highlight';
}

function readSavedColor(): AnchorColor {
  try {
    const v = localStorage.getItem(LS_COLOR_KEY);
    if (v === 'amber' || v === 'green' || v === 'rose' || v === 'blue') return v;
  } catch {
    // ignore storage errors
  }
  return 'amber';
}

function persistSelectionPrefs(style: AnnotationStyle, color: AnchorColor) {
  try {
    if (style === 'highlight' || style === 'underline') {
      localStorage.setItem(LS_STYLE_KEY, style);
    }
    localStorage.setItem(LS_COLOR_KEY, color);
  } catch {
    // ignore storage errors
  }
}

interface SelectionPopoverProps {
  x: number;
  y: number;
  quote: string;
  selectedCardId: string | null;
  onAnnotate: (options: {
    style: AnnotationStyle;
    color: AnchorColor;
    withCard: boolean;
    linkToExistingNodeId?: string;
  }) => void;
  onDismiss: () => void;
}

export const SelectionPopover: React.FC<SelectionPopoverProps> = ({
  x,
  y,
  quote,
  selectedCardId,
  onAnnotate,
  onDismiss,
}) => {
  const [activeStyle, setActiveStyle] = useState<AnnotationStyle>(readSavedStyle);
  const [activeColor, setActiveColor] = useState<AnchorColor>(readSavedColor);
  const [copied, setCopied] = useState(false);

  const commitAnnotate = (options: {
    style: AnnotationStyle;
    color: AnchorColor;
    withCard: boolean;
    linkToExistingNodeId?: string;
  }) => {
    persistSelectionPrefs(options.style, options.color);
    onAnnotate(options);
  };

  const handleCopy = () => {
    void navigator.clipboard?.writeText(quote).catch(() => {});
    setCopied(true);
    window.setTimeout(() => {
      onDismiss();
    }, 320);
  };

  // 划词后支持单键快捷操作：1-4 对应四色标注，H 高亮，U 划线，Enter 建空白批注卡，C 复制，Esc 关闭。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'TEXTAREA' ||
          target.tagName === 'INPUT' ||
          target.isContentEditable)
      ) {
        return;
      }
      const key = e.key.toLowerCase();
      if (key === 'escape') {
        e.preventDefault();
        onDismiss();
      } else if (key === '1' || key === '2' || key === '3' || key === '4') {
        e.preventDefault();
        const color = ANCHOR_COLORS[Number(key) - 1].id;
        setActiveColor(color);
        commitAnnotate({ style: activeStyle, color, withCard: false });
      } else if (key === 'h') {
        e.preventDefault();
        setActiveStyle('highlight');
        commitAnnotate({ style: 'highlight', color: activeColor, withCard: false });
      } else if (key === 'u') {
        e.preventDefault();
        setActiveStyle('underline');
        commitAnnotate({ style: 'underline', color: activeColor, withCard: false });
      } else if (key === 'enter') {
        e.preventDefault();
        commitAnnotate({ style: activeStyle, color: activeColor, withCard: true });
      } else if (key === 'c') {
        e.preventDefault();
        handleCopy();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeStyle, activeColor, quote, onAnnotate, onDismiss]);

  // 防止浮条在窗口左右边缘被裁切
  const halfWidth = selectedCardId ? 210 : 165;
  const clampedX = Math.min(
    Math.max(x, halfWidth + 10),
    window.innerWidth - halfWidth - 10
  );
  const clampedY = Math.max(58, y);

  return (
    <div
      className="selection-popover"
      style={{
        left: `${clampedX}px`,
        top: `${clampedY}px`,
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* 样式切换：高亮 / 划线 */}
      <div className="selection-popover__style-group">
        <button
          type="button"
          className={`selection-popover__icon-btn ${
            activeStyle === 'highlight' ? 'is-active' : ''
          }`}
          title="高亮模式（快捷键 H 直接高亮）"
          onClick={() => {
            setActiveStyle('highlight');
            persistSelectionPrefs('highlight', activeColor);
          }}
        >
          <Highlighter size={13} />
        </button>
        <button
          type="button"
          className={`selection-popover__icon-btn ${
            activeStyle === 'underline' ? 'is-active' : ''
          }`}
          title="划线模式（快捷键 U 直接划线）"
          onClick={() => {
            setActiveStyle('underline');
            persistSelectionPrefs('underline', activeColor);
          }}
        >
          <Underline size={13} />
        </button>
      </div>

      <div className="selection-popover__sep" />

      {/* 四色色点：点击即刻标注 */}
      <div className="selection-popover__swatches">
        {ANCHOR_COLORS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`selection-popover__swatch ${
              activeColor === item.id ? 'is-active' : ''
            }`}
            style={{ background: item.swatch }}
            title={`${item.label}${activeStyle === 'highlight' ? '高亮' : '划线'}（快捷键 ${item.shortcut}）`}
            onClick={() => {
              setActiveColor(item.id);
              commitAnnotate({
                style: activeStyle,
                color: item.id,
                withCard: false,
              });
            }}
          />
        ))}
      </div>

      <div className="selection-popover__sep" />

      {/* 主操作：直接建空白批注卡 */}
      <button
        type="button"
        className="selection-popover__btn selection-popover__btn--primary"
        title="标注并创建空白批注卡（快捷键 Enter）"
        onClick={() =>
          commitAnnotate({
            style: activeStyle,
            color: activeColor,
            withCard: true,
          })
        }
      >
        <MessageSquarePlus size={13} />
        <span>建卡</span>
      </button>

      {selectedCardId && (
        <button
          type="button"
          className="selection-popover__btn selection-popover__btn--link"
          title="将选中原文连线到当前选中的卡片"
          onClick={() =>
            commitAnnotate({
              style: activeStyle,
              color: activeColor,
              withCard: true,
              linkToExistingNodeId: selectedCardId,
            })
          }
        >
          <Link2 size={13} />
          <span>连到选中卡</span>
        </button>
      )}

      <div className="selection-popover__sep" />

      <button
        type="button"
        className="selection-popover__icon-btn"
        title="复制原文（快捷键 C）"
        onClick={handleCopy}
      >
        {copied ? <Check size={13} className="selection-popover__copied" /> : <Copy size={13} />}
      </button>
    </div>
  );
};

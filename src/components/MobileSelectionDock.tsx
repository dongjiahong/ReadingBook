import React, { useState } from 'react';
import {
  Check,
  Copy,
  Highlighter,
  Link2,
  MessageSquarePlus,
  Underline,
  X,
} from 'lucide-react';
import { ANCHOR_COLORS } from './SelectionPopover';
import type { AnchorColor, AnnotationStyle } from '../types';

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

export interface LinkableCardOption {
  id: string;
  preview: string;
  badgeNumber?: number;
}

interface MobileSelectionDockProps {
  quote: string;
  crossParagraphTruncated?: boolean;
  recentCards?: LinkableCardOption[];
  onAnnotate: (options: {
    style: AnnotationStyle;
    color: AnchorColor;
    withCard: boolean;
    linkToExistingNodeId?: string;
  }) => void;
  onDismiss: () => void;
}

export const MobileSelectionDock: React.FC<MobileSelectionDockProps> = ({
  quote,
  crossParagraphTruncated = false,
  recentCards = [],
  onAnnotate,
  onDismiss,
}) => {
  const [activeStyle, setActiveStyle] = useState<AnnotationStyle>(readSavedStyle);
  const [activeColor, setActiveColor] = useState<AnchorColor>(readSavedColor);
  const [copied, setCopied] = useState(false);
  const [showLinkPicker, setShowLinkPicker] = useState(false);

  const commit = (options: {
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
    }, 360);
  };

  return (
    <div
      className="mobile-selection-dock"
      role="toolbar"
      aria-label="划词标注工具栏"
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onTouchStart={(e) => {
        e.stopPropagation();
      }}
    >
      {showLinkPicker && recentCards.length > 0 && (
        <div className="mobile-selection-dock__picker">
          <div className="mobile-selection-dock__picker-head">
            <span>关联到已有批注卡</span>
            <button
              type="button"
              className="mobile-selection-dock__close"
              onClick={() => setShowLinkPicker(false)}
              title="收起"
            >
              <X size={14} />
            </button>
          </div>
          <div className="mobile-selection-dock__picker-list">
            {recentCards.map((item) => (
              <button
                key={item.id}
                type="button"
                className="mobile-selection-dock__picker-item"
                onClick={() =>
                  commit({
                    style: activeStyle,
                    color: activeColor,
                    withCard: true,
                    linkToExistingNodeId: item.id,
                  })
                }
              >
                <span className="mobile-selection-dock__picker-badge">
                  {item.badgeNumber ? `#${item.badgeNumber}` : '卡'}
                </span>
                <span className="mobile-selection-dock__picker-text">
                  {item.preview}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="mobile-selection-dock__preview">
        <span className="mobile-selection-dock__quote">「{quote}」</span>
        {crossParagraphTruncated && (
          <span className="mobile-selection-dock__hint">已截取首段</span>
        )}
        <button
          type="button"
          className="mobile-selection-dock__close"
          title="取消选区"
          onClick={onDismiss}
        >
          <X size={15} />
        </button>
      </div>

      <div className="mobile-selection-dock__row">
        <button
          type="button"
          className="mobile-selection-dock__style-btn"
          title={activeStyle === 'highlight' ? '当前高亮，点击切为划线' : '当前划线，点击切为高亮'}
          onClick={() => {
            const next: AnnotationStyle =
              activeStyle === 'highlight' ? 'underline' : 'highlight';
            setActiveStyle(next);
            persistSelectionPrefs(next, activeColor);
          }}
        >
          {activeStyle === 'highlight' ? (
            <Highlighter size={16} />
          ) : (
            <Underline size={16} />
          )}
          <span>{activeStyle === 'highlight' ? '高亮' : '划线'}</span>
        </button>

        <div className="mobile-selection-dock__swatches">
          {ANCHOR_COLORS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`mobile-selection-dock__swatch-btn ${
                activeColor === item.id ? 'is-active' : ''
              }`}
              title={`${item.label}${activeStyle === 'highlight' ? '高亮' : '划线'}`}
              onClick={() => {
                setActiveColor(item.id);
                commit({
                  style: activeStyle,
                  color: item.id,
                  withCard: false,
                });
              }}
            >
              <span
                className="mobile-selection-dock__swatch"
                style={{ background: item.swatch }}
              />
            </button>
          ))}
        </div>

        <button
          type="button"
          className="mobile-selection-dock__primary-btn"
          onClick={() =>
            commit({
              style: activeStyle,
              color: activeColor,
              withCard: true,
            })
          }
        >
          <MessageSquarePlus size={15} />
          <span>建卡</span>
        </button>

        {recentCards.length > 0 && (
          <button
            type="button"
            className={`mobile-selection-dock__icon-btn ${
              showLinkPicker ? 'is-active' : ''
            }`}
            title="关联到已有卡片"
            onClick={() => setShowLinkPicker((v) => !v)}
          >
            <Link2 size={16} />
          </button>
        )}

        <button
          type="button"
          className="mobile-selection-dock__icon-btn"
          title="复制原文"
          onClick={handleCopy}
        >
          {copied ? <Check size={16} className="selection-popover__copied" /> : <Copy size={16} />}
        </button>
      </div>
    </div>
  );
};

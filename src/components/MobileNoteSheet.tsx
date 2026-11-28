import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Copy,
  Hash,
  Highlighter,
  ImagePlus,
  Maximize2,
  MessageSquarePlus,
  Minimize2,
  Plus,
  Trash2,
  Underline,
  X,
} from 'lucide-react';
import { ANCHOR_COLORS } from './SelectionPopover';
import type {
  AnchorColor,
  AnnotationCardItem,
  AnnotationStyle,
  BookAnchor,
  CardEdge,
  CardImage,
} from '../types';

interface MobileNoteSheetProps {
  anchor: BookAnchor | null;
  cards: AnnotationCardItem[];
  edges: CardEdge[];
  autoFocusCardId: string | null;
  onAutoFocused: () => void;
  onClose: () => void;
  onUpdateAnchor: (
    anchorId: string,
    patch: Partial<Pick<BookAnchor, 'color' | 'style'>>
  ) => void;
  onDeleteAnchor: (anchorId: string) => void;
  onPromoteAnchor: (anchor: BookAnchor) => void;
  onChangeBody: (cardId: string, body: string) => void;
  onAddChildCard: (parentCardId: string) => void;
  onDeleteCard: (cardId: string) => void;
  onAddImages?: (cardId: string, files: FileList | File[]) => void;
  onRemoveImage?: (cardId: string, imageId: string) => void;
  onPreviewImage: (cardId: string, image: CardImage) => void;
}

interface TreeNode {
  card: AnnotationCardItem;
  depth: number;
}

const SWATCH_HEX: Record<AnchorColor, string> = {
  amber: '#eab308',
  green: '#16a34a',
  rose: '#e11d48',
  blue: '#2563eb',
};

export const MobileNoteSheet: React.FC<MobileNoteSheetProps> = ({
  anchor,
  cards,
  edges,
  autoFocusCardId,
  onAutoFocused,
  onClose,
  onUpdateAnchor,
  onDeleteAnchor,
  onPromoteAnchor,
  onChangeBody,
  onAddChildCard,
  onDeleteCard,
  onAddImages,
  onRemoveImage,
  onPreviewImage,
}) => {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [focusedCardId, setFocusedCardId] = useState<string | null>(null);
  const [keyboardMetrics, setKeyboardMetrics] = useState<{
    insetBottom: number;
    viewportHeight: number;
  }>({ insetBottom: 0, viewportHeight: 0 });

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingImageCardIdRef = useRef<string | null>(null);
  const textareaMapRef = useRef<Map<string, HTMLTextAreaElement>>(new Map());

  useEffect(() => {
    if (!anchor) {
      setExpanded(false);
      setCopied(false);
      setFocusedCardId(null);
    }
  }, [anchor?.id]);

  // Adapt sheet height & bottom padding when Android soft keyboard opens/closes.
  useEffect(() => {
    if (!anchor) return;
    const vv = window.visualViewport;
    if (!vv) return;

    const update = () => {
      const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      setKeyboardMetrics({
        insetBottom: inset > 60 ? Math.round(inset) : 0,
        viewportHeight: Math.round(vv.height),
      });
    };

    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, [anchor]);

  // Build ordered root -> children tree for the linked card
  const treeNodes = useMemo<TreeNode[]>(() => {
    if (!anchor?.targetNodeId) return [];
    const cardById = new Map<string, AnnotationCardItem>();
    for (const c of cards) cardById.set(c.id, c);

    const root = cardById.get(anchor.targetNodeId);
    if (!root) return [];

    const childrenByParent = new Map<string, string[]>();
    for (const edge of edges) {
      const list = childrenByParent.get(edge.source);
      if (list) list.push(edge.target);
      else childrenByParent.set(edge.source, [edge.target]);
    }

    const result: TreeNode[] = [];
    const visited = new Set<string>();
    const walk = (cardId: string, depth: number) => {
      if (visited.has(cardId)) return;
      const item = cardById.get(cardId);
      if (!item) return;
      visited.add(cardId);
      result.push({ card: item, depth });
      for (const childId of childrenByParent.get(cardId) ?? []) {
        walk(childId, Math.min(depth + 1, 4));
      }
    };

    walk(root.id, 0);
    return result;
  }, [anchor, cards, edges]);

  const activeCardId = useMemo(() => {
    if (focusedCardId && treeNodes.some((n) => n.card.id === focusedCardId)) {
      return focusedCardId;
    }
    return treeNodes[0]?.card.id ?? null;
  }, [focusedCardId, treeNodes]);

  const registerTextarea = useCallback(
    (cardId: string, el: HTMLTextAreaElement | null) => {
      if (el) textareaMapRef.current.set(cardId, el);
      else textareaMapRef.current.delete(cardId);
    },
    []
  );

  const handleInsertTag = useCallback(() => {
    if (!activeCardId) return;
    const card = treeNodes.find((n) => n.card.id === activeCardId)?.card;
    if (!card) return;
    const el = textareaMapRef.current.get(activeCardId);
    const start = el ? (el.selectionStart ?? card.body.length) : card.body.length;
    const end = el ? (el.selectionEnd ?? card.body.length) : card.body.length;
    const prefix = start > 0 && !/\s$/.test(card.body.slice(0, start)) ? ' #' : '#';
    const next = card.body.slice(0, start) + prefix + card.body.slice(end);
    onChangeBody(activeCardId, next);
    requestAnimationFrame(() => {
      const target = textareaMapRef.current.get(activeCardId);
      if (!target) return;
      const caret = start + prefix.length;
      target.focus();
      target.setSelectionRange(caret, caret);
    });
  }, [activeCardId, treeNodes, onChangeBody]);

  const handleTriggerImagePicker = useCallback((cardId: string) => {
    pendingImageCardIdRef.current = cardId;
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
      fileInputRef.current.click();
    }
  }, []);

  if (!anchor) return null;

  const curColor: AnchorColor =
    anchor.color ?? (anchor.style === 'underline' ? 'green' : 'amber');
  const nextStyle: AnnotationStyle =
    anchor.style === 'highlight' ? 'underline' : 'highlight';
  const keyboardOpen = keyboardMetrics.insetBottom > 0;

  const sheetStyle: React.CSSProperties | undefined = keyboardOpen
    ? {
        height: `${Math.max(
          260,
          Math.min(
            Math.round(keyboardMetrics.viewportHeight * (expanded ? 0.94 : 0.78)),
            keyboardMetrics.viewportHeight - 16
          )
        )}px`,
        maxHeight: `${Math.max(260, keyboardMetrics.viewportHeight - 12)}px`,
        paddingBottom: 0,
      }
    : undefined;

  return (
    <div
      className="mobile-sheet-backdrop"
      style={
        keyboardOpen
          ? { paddingBottom: `${keyboardMetrics.insetBottom}px` }
          : undefined
      }
      onClick={onClose}
      role="presentation"
    >
      <section
        className={`mobile-sheet ${expanded ? 'is-expanded' : ''} ${
          keyboardOpen ? 'is-keyboard-open' : ''
        }`}
        style={sheetStyle}
        role="dialog"
        aria-label="批注详情"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mobile-sheet__handle-bar" onClick={() => setExpanded((v) => !v)}>
          <span className="mobile-sheet__handle" />
        </div>

        <header className="mobile-sheet__header">
          <div className="mobile-sheet__swatches">
            {ANCHOR_COLORS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`mobile-sheet__swatch ${curColor === item.id ? 'is-active' : ''}`}
                style={{ background: item.swatch }}
                title={`切换为${item.label}`}
                onClick={() => onUpdateAnchor(anchor.id, { color: item.id })}
              />
            ))}
            {anchor.style !== 'pin' && (
              <button
                type="button"
                className="mobile-sheet__icon-btn"
                title={nextStyle === 'underline' ? '改为下划线' : '改为高亮'}
                onClick={() => onUpdateAnchor(anchor.id, { style: nextStyle })}
              >
                {nextStyle === 'underline' ? (
                  <Underline size={15} />
                ) : (
                  <Highlighter size={15} />
                )}
              </button>
            )}
          </div>

          <div className="mobile-sheet__header-actions">
            {anchor.quote.trim() && (
              <button
                type="button"
                className="mobile-sheet__icon-btn"
                title="复制原文"
                onClick={() => {
                  void navigator.clipboard?.writeText(anchor.quote).catch(() => {});
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1400);
                }}
              >
                <Copy size={15} />
              </button>
            )}
            <button
              type="button"
              className="mobile-sheet__icon-btn"
              title={expanded ? '收起高度' : '展开高度'}
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            </button>
            <button
              type="button"
              className="mobile-sheet__icon-btn mobile-sheet__icon-btn--danger"
              title="删除该标注"
              onClick={() => {
                if (anchor.targetNodeId) {
                  onDeleteCard(anchor.targetNodeId);
                } else {
                  onDeleteAnchor(anchor.id);
                }
                onClose();
              }}
            >
              <Trash2 size={15} />
            </button>
            <button
              type="button"
              className="mobile-sheet__icon-btn"
              title="关闭"
              onClick={onClose}
            >
              <X size={16} />
            </button>
          </div>
        </header>

        <div className="mobile-sheet__body">
          {anchor.quote.trim() && (
            <blockquote
              className="mobile-sheet__quote"
              style={{ borderLeftColor: SWATCH_HEX[curColor] }}
            >
              {anchor.quote.trim()}
              {copied && <span className="mobile-sheet__copied">已复制</span>}
            </blockquote>
          )}

          {treeNodes.length === 0 ? (
            <div className="mobile-sheet__empty-card">
              <p>这是一条纯{anchor.style === 'underline' ? '划线' : '高亮'}标注，尚未添加笔记。</p>
              <button
                type="button"
                className="mobile-sheet__promote-btn"
                onClick={() => onPromoteAnchor(anchor)}
              >
                <MessageSquarePlus size={15} />
                <span>写一条批注笔记</span>
              </button>
            </div>
          ) : (
            <div className="mobile-sheet__tree">
              {treeNodes.map(({ card, depth }) => (
                <MobileNoteCardRow
                  key={card.id}
                  card={card}
                  depth={depth}
                  accentColor={SWATCH_HEX[curColor]}
                  isFocused={activeCardId === card.id}
                  autoFocus={autoFocusCardId === card.id}
                  onAutoFocused={onAutoFocused}
                  onFocus={() => setFocusedCardId(card.id)}
                  onRegisterTextarea={registerTextarea}
                  onChangeBody={onChangeBody}
                  onAddChild={onAddChildCard}
                  onAddImage={
                    onAddImages ? () => handleTriggerImagePicker(card.id) : undefined
                  }
                  onRemoveImage={onRemoveImage}
                  onDelete={(id) => {
                    onDeleteCard(id);
                    if (id === anchor.targetNodeId) onClose();
                  }}
                  onPreviewImage={(img) => onPreviewImage(card.id, img)}
                />
              ))}
            </div>
          )}
        </div>

        {treeNodes.length > 0 && activeCardId && (
          <div
            className="mobile-sheet__toolbar"
            onMouseDown={(e) => e.preventDefault()}
          >
            <button
              type="button"
              className="mobile-sheet__tool-btn"
              onClick={handleInsertTag}
              title="插入 #标签"
            >
              <Hash size={15} />
              <span>标签</span>
            </button>
            {onAddImages && (
              <button
                type="button"
                className="mobile-sheet__tool-btn"
                onClick={() => handleTriggerImagePicker(activeCardId)}
                title="从相册或相机添加附图"
              >
                <ImagePlus size={15} />
                <span>插图</span>
              </button>
            )}
            <button
              type="button"
              className="mobile-sheet__tool-btn"
              onClick={() => onAddChildCard(activeCardId)}
              title="在当前卡片下追加子分支"
            >
              <Plus size={15} />
              <span>子卡</span>
            </button>
            <div className="mobile-sheet__toolbar-spacer" />
            <button
              type="button"
              className="mobile-sheet__done-btn"
              onClick={() => {
                const activeEl = document.activeElement as HTMLElement | null;
                if (activeEl && activeEl.tagName === 'TEXTAREA') {
                  activeEl.blur();
                } else {
                  onClose();
                }
              }}
            >
              <Check size={14} />
              <span>{keyboardOpen ? '收起键盘' : '完成'}</span>
            </button>
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            const files = e.target.files;
            const targetCardId = pendingImageCardIdRef.current ?? activeCardId;
            if (files && files.length > 0 && targetCardId && onAddImages) {
              onAddImages(targetCardId, files);
            }
            e.target.value = '';
          }}
        />
      </section>
    </div>
  );
};

interface MobileNoteCardRowProps {
  card: AnnotationCardItem;
  depth: number;
  accentColor: string;
  isFocused: boolean;
  autoFocus: boolean;
  onAutoFocused: () => void;
  onFocus: () => void;
  onRegisterTextarea: (cardId: string, el: HTMLTextAreaElement | null) => void;
  onChangeBody: (cardId: string, body: string) => void;
  onAddChild: (parentCardId: string) => void;
  onAddImage?: () => void;
  onRemoveImage?: (cardId: string, imageId: string) => void;
  onDelete: (cardId: string) => void;
  onPreviewImage: (image: CardImage) => void;
}

const MobileNoteCardRow: React.FC<MobileNoteCardRowProps> = ({
  card,
  depth,
  accentColor,
  isFocused,
  autoFocus,
  onAutoFocused,
  onFocus,
  onRegisterTextarea,
  onChangeBody,
  onAddChild,
  onAddImage,
  onRemoveImage,
  onDelete,
  onPreviewImage,
}) => {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(48, el.scrollHeight)}px`;
  }, [card.body]);

  useEffect(() => {
    if (!autoFocus) return;
    const el = textareaRef.current;
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    onAutoFocused();
  }, [autoFocus, onAutoFocused]);

  return (
    <div
      className={`mobile-note-card ${depth > 0 ? 'is-child' : ''} ${
        isFocused ? 'is-focused' : ''
      }`}
      style={{
        marginLeft: `${depth * 14}px`,
        borderLeftColor: depth === 0 ? accentColor : undefined,
      }}
    >
      <div className="mobile-note-card__top">
        <span className="mobile-note-card__label">
          {depth === 0 ? '主批注' : `子分支 L${depth}`}
        </span>
        <div className="mobile-note-card__actions">
          {onAddImage && (
            <button
              type="button"
              className="mobile-note-card__btn"
              title="添加图片"
              onClick={onAddImage}
            >
              <ImagePlus size={13} />
            </button>
          )}
          <button
            type="button"
            className="mobile-note-card__btn"
            title="追加子想法"
            onClick={() => onAddChild(card.id)}
          >
            <Plus size={13} />
            <span>子卡</span>
          </button>
          <button
            type="button"
            className="mobile-note-card__btn mobile-note-card__btn--danger"
            title="删除卡片"
            onClick={() => onDelete(card.id)}
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      <textarea
        ref={(el) => {
          textareaRef.current = el;
          onRegisterTextarea(card.id, el);
        }}
        className="mobile-note-card__textarea"
        placeholder="记下你的想法（支持 #标签，同步回桌面端自动排版）…"
        value={card.body}
        onFocus={onFocus}
        onChange={(e) => onChangeBody(card.id, e.target.value)}
      />

      {card.images && card.images.length > 0 && (
        <div className="mobile-note-card__images">
          {card.images.map((img) => (
            <div key={img.id} className="mobile-note-card__img-wrap">
              <button
                type="button"
                className="mobile-note-card__img-btn"
                onClick={() => onPreviewImage(img)}
              >
                <img src={img.thumbUrl} alt="批注附图" loading="lazy" />
              </button>
              {onRemoveImage && (
                <button
                  type="button"
                  className="mobile-note-card__img-remove"
                  title="移除附图"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemoveImage(card.id, img.id);
                  }}
                >
                  <X size={11} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Copy,
  Highlighter,
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
  onPreviewImage: (image: CardImage) => void;
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
  onPreviewImage,
}) => {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!anchor) {
      setExpanded(false);
      setCopied(false);
    }
  }, [anchor?.id]);

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

  if (!anchor) return null;

  const curColor: AnchorColor =
    anchor.color ?? (anchor.style === 'underline' ? 'green' : 'amber');
  const nextStyle: AnnotationStyle =
    anchor.style === 'highlight' ? 'underline' : 'highlight';

  return (
    <div
      className="mobile-sheet-backdrop"
      onClick={onClose}
      role="presentation"
    >
      <section
        className={`mobile-sheet ${expanded ? 'is-expanded' : ''}`}
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
                  autoFocus={autoFocusCardId === card.id}
                  onAutoFocused={onAutoFocused}
                  onChangeBody={onChangeBody}
                  onAddChild={onAddChildCard}
                  onDelete={(id) => {
                    onDeleteCard(id);
                    if (id === anchor.targetNodeId) onClose();
                  }}
                  onPreviewImage={onPreviewImage}
                />
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
};

interface MobileNoteCardRowProps {
  card: AnnotationCardItem;
  depth: number;
  accentColor: string;
  autoFocus: boolean;
  onAutoFocused: () => void;
  onChangeBody: (cardId: string, body: string) => void;
  onAddChild: (parentCardId: string) => void;
  onDelete: (cardId: string) => void;
  onPreviewImage: (image: CardImage) => void;
}

const MobileNoteCardRow: React.FC<MobileNoteCardRowProps> = ({
  card,
  depth,
  accentColor,
  autoFocus,
  onAutoFocused,
  onChangeBody,
  onAddChild,
  onDelete,
  onPreviewImage,
}) => {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(44, el.scrollHeight)}px`;
  }, [card.body]);

  useEffect(() => {
    if (!autoFocus) return;
    const el = textareaRef.current;
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
    onAutoFocused();
  }, [autoFocus, onAutoFocused]);

  return (
    <div
      className={`mobile-note-card ${depth > 0 ? 'is-child' : ''}`}
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
        ref={textareaRef}
        className="mobile-note-card__textarea"
        placeholder="记下你的想法（支持 #标签，同步回桌面端自动排版）…"
        value={card.body}
        onChange={(e) => onChangeBody(card.id, e.target.value)}
      />

      {card.images && card.images.length > 0 && (
        <div className="mobile-note-card__images">
          {card.images.map((img) => (
            <button
              key={img.id}
              type="button"
              className="mobile-note-card__img-btn"
              onClick={() => onPreviewImage(img)}
            >
              <img src={img.thumbUrl} alt="批注附图" loading="lazy" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

import React, { memo, useCallback, useLayoutEffect, useRef, useState } from 'react';
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  ImagePlus,
  Link2,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import type { AnnotationCardItem, CardImage } from '../types';
import { importImageFiles } from '../utils/imageStore';

interface AnnotationCardProps {
  card: AnnotationCardItem;
  cardScale?: number;
  isSelected: boolean;
  onSelect: (cardId: string) => void;
  onMoveCard: (cardId: string, nextX: number, nextY: number) => void;
  onChangeBody: (cardId: string, newBody: string) => void;
  onAddImages: (cardId: string, newImages: CardImage[]) => void;
  onRemoveImage: (cardId: string, image: CardImage) => void;
  onPreviewImage: (image: CardImage) => void;
  onAnnotateImage?: (cardId: string, image: CardImage) => void;
  onUpdateStatus: (cardId: string, status: 'accepted' | 'rejected') => void;
  onAddChild: (sourceCardId: string) => void;
  onDelete: (cardId: string) => void;
  onFocusAnchor: (anchorId: string) => void;
  onStartDragToBook: (cardId: string, clientX: number, clientY: number) => void;
  onStartDragToCard: (cardId: string, clientX: number, clientY: number) => void;
  onToggleCollapse: (cardId: string) => void;
  /** 收起后会随之隐藏的后代卡片数量。 */
  hiddenCount: number;
  onLayoutChange: () => void;
}

export const AnnotationCard: React.FC<AnnotationCardProps> = memo(function AnnotationCard({
  card,
  cardScale = 1,
  isSelected,
  onSelect,
  onMoveCard,
  onChangeBody,
  onAddImages,
  onRemoveImage,
  onPreviewImage,
  onAnnotateImage,
  onAddChild,
  onDelete,
  onFocusAnchor,
  onStartDragToBook,
  onStartDragToCard,
  onToggleCollapse,
  hiddenCount,
  onLayoutChange,
}) {
  const { id, x, y, kind, body, images = [], anchorId, collapsed = false } = card;
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  const adjustTextareaHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.max(22, el.scrollHeight)}px`;
    onLayoutChange();
  }, [onLayoutChange]);

  useLayoutEffect(() => {
    adjustTextareaHeight();
  }, [body, images.length, collapsed, adjustTextareaHeight]);

  // 仅图片卡片在未选中且无文字时收起文字行，选中后重新显示以便输入。
  const hasBody = body.trim().length > 0;
  const showTextRow = hasBody || images.length === 0 || isSelected;

  // 收起时用第一行正文做摘要，保持卡片仍然可读。
  const firstLine = body.trim().split('\n')[0].trim();
  const collapsedPreview =
    firstLine || (images.length > 0 ? `图片 ×${images.length}` : '空卡片');

  useLayoutEffect(() => {
    onLayoutChange();
  }, [isSelected, collapsed, onLayoutChange]);

  // Drag card to reposition anywhere on the unified right-side infinite canvas
  const handleCardMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (
      target.closest('button') ||
      target.closest('textarea') ||
      target.closest('input') ||
      target.closest('img') ||
      target.closest('[data-port]')
    ) {
      return;
    }
    e.stopPropagation();
    onSelect(id);

    const startMouseX = e.clientX;
    const startMouseY = e.clientY;
    const origX = x;
    const origY = y;

    const handleMouseMove = (moveEvt: MouseEvent) => {
      const dx = moveEvt.clientX - startMouseX;
      const dy = moveEvt.clientY - startMouseY;
      onMoveCard(id, Math.max(16, origX + dx), Math.max(16, origY + dy));
    };

    const handleMouseUp = () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  const handlePaste = useCallback(
    async (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const imageFiles: File[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.type.startsWith('image/')) {
          const f = item.getAsFile();
          if (f) imageFiles.push(f);
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault();
        const imported = await importImageFiles(imageFiles);
        if (imported.length > 0) onAddImages(id, imported);
      }
    },
    [id, onAddImages]
  );

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      if (e.dataTransfer?.files?.length) {
        const imported = await importImageFiles(e.dataTransfer.files);
        if (imported.length > 0) onAddImages(id, imported);
      }
    },
    [id, onAddImages]
  );

  const handleSelectImageFiles = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files ? Array.from(e.target.files) : [];
      e.target.value = '';
      if (files.length === 0) return;
      const imported = await importImageFiles(files);
      if (imported.length > 0) onAddImages(id, imported);
    },
    [id, onAddImages]
  );

  return (
    <div
      data-card-id={id}
      onMouseDown={handleCardMouseDown}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(id);
      }}
      onDragOver={(e) => {
        if (e.dataTransfer?.types?.includes('Files')) {
          e.preventDefault();
          setIsDragOver(true);
        }
      }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={handleDrop}
      style={{
        position: 'absolute',
        left: `${x}px`,
        top: `${y}px`,
        transform: cardScale !== 1 ? `scale(${cardScale})` : undefined,
        transformOrigin: 'left top',
      }}
      className={[
        'anno-card',
        `anno-card--${kind}`,
        isSelected ? 'anno-card--active' : '',
        isDragOver ? 'anno-card--dragover' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {/* Left Anchor Target Port */}
      <div
        data-port="target"
        data-card-handle-id={id}
        className={`card-port card-port--left card-port--${kind}`}
        title="接收连线端口"
      />

      {/* Left Drag Pin: drag leftward onto sticky PDF / EPUB */}
      <button
        type="button"
        className={`anno-book-drag-pin anno-book-drag-pin--${kind}`}
        title="按住向左拖拽到 PDF 或书籍任意位置建立连线"
        onMouseDown={(e) => {
          e.stopPropagation();
          e.preventDefault();
          onStartDragToBook(id, e.clientX, e.clientY);
        }}
      >
        <Link2 size={10} />
      </button>

      {/* Hover-only Compact Floating Toolbar */}
      <div className="anno-card__floating-actions">
        <input
          ref={imageInputRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: 'none' }}
          onChange={handleSelectImageFiles}
        />

        <button
          type="button"
          className="anno-icon-btn anno-icon-btn--link"
          title="按住拖拽到左侧 PDF / 书籍建立连线"
          onMouseDown={(e) => {
            e.stopPropagation();
            e.preventDefault();
            onStartDragToBook(id, e.clientX, e.clientY);
          }}
        >
          <Link2 size={12} />
        </button>

        <button
          type="button"
          className="anno-icon-btn"
          title="插入图片（也支持直接粘贴截图或拖入图片）"
          onClick={() => imageInputRef.current?.click()}
        >
          <ImagePlus size={12} />
        </button>

        {anchorId && (
          <button
            type="button"
            className="anno-icon-btn"
            title="定位到书籍原文"
            onClick={() => onFocusAnchor(anchorId)}
          >
            <BookOpen size={12} />
          </button>
        )}

        <button
          type="button"
          className="anno-icon-btn anno-icon-btn--danger"
          title="删除卡片"
          onClick={() => onDelete(id)}
        >
          <Trash2 size={12} />
        </button>
      </div>

      {/* Minimalist Content Area */}
      <div className="anno-card__content">
        <div className="anno-card__text-row">
          <button
            type="button"
            className={`anno-collapse-btn ${collapsed ? 'is-collapsed' : ''}`}
            title={
              collapsed
                ? hiddenCount > 0
                  ? `展开卡片，同时显示 ${hiddenCount} 张子卡片`
                  : '展开卡片'
                : hiddenCount > 0
                  ? `收起卡片，同时隐藏 ${hiddenCount} 张子卡片`
                  : '收起卡片'
            }
            onClick={(e) => {
              e.stopPropagation();
              onToggleCollapse(id);
            }}
          >
            {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          </button>

          {collapsed ? (
            <div className="anno-card__preview" title={firstLine || collapsedPreview}>
              <span className="anno-card__preview-text">{collapsedPreview}</span>
              {hiddenCount > 0 && (
                <span className="anno-collapse-count">+{hiddenCount}</span>
              )}
            </div>
          ) : showTextRow ? (
            <textarea
              ref={textareaRef}
              className="anno-card__textarea"
              value={body}
              rows={1}
              placeholder="输入笔记，支持粘贴截图或拖入图片..."
              onPaste={handlePaste}
              onChange={(e) => onChangeBody(id, e.target.value)}
            />
          ) : null}
        </div>

        {!collapsed && images.length > 0 && (
          <div className="anno-card__images">
            {images.map((image, idx) => (
              <div key={image.id} className="anno-card__image-item">
                <img
                  src={image.thumbUrl}
                  alt={`批注附图 ${idx + 1}`}
                  className="anno-card__img"
                  width={image.width}
                  height={image.height}
                  loading="lazy"
                  decoding="async"
                  title="点击放大查看图片"
                  onLoad={onLayoutChange}
                  onClick={(e) => {
                    e.stopPropagation();
                    onPreviewImage(image);
                  }}
                />
                {onAnnotateImage && (
                  <button
                    type="button"
                    className="anno-card__img-edit"
                    title="标注图片（箭头 / 方框 / 文字）"
                    onClick={(e) => {
                      e.stopPropagation();
                      onAnnotateImage(id, image);
                    }}
                  >
                    <Pencil size={10} />
                  </button>
                )}
                <button
                  type="button"
                  className="anno-card__img-remove"
                  title="移除图片"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemoveImage(id, image);
                  }}
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Right Source Port (drag to connect to another card) + Quick Branch '+' */}
      <div
        data-port="source"
        data-card-source-id={id}
        className={`card-port card-port--right card-port--${kind}`}
        title="按住拖线连接到其他卡片"
        onMouseDown={(e) => {
          e.stopPropagation();
          e.preventDefault();
          onStartDragToCard(id, e.clientX, e.clientY);
        }}
      />

      <button
        type="button"
        className="anno-branch-btn"
        title="向右延伸新卡片"
        onClick={(e) => {
          e.stopPropagation();
          onAddChild(id);
        }}
      >
        <Plus size={12} />
      </button>
    </div>
  );
});

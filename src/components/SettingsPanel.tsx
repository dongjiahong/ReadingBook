import React, { useEffect } from 'react';
import { X } from 'lucide-react';
import type { ReaderFont, ReaderSettings, ReaderTheme } from '../types';

interface SettingsPanelProps {
  open: boolean;
  settings: ReaderSettings;
  defaults: ReaderSettings;
  onClose: () => void;
  onChange: (patch: Partial<ReaderSettings>) => void;
}

const THEMES: { value: ReaderTheme; label: string }[] = [
  { value: 'light', label: '浅色' },
  { value: 'sepia', label: '护眼' },
  { value: 'dark', label: '深色' },
];

const FONTS: { value: ReaderFont; label: string; stack: string }[] = [
  { value: 'system', label: '系统', stack: 'inherit' },
  { value: 'serif', label: '宋体', stack: "'Songti SC', SimSun, serif" },
  { value: 'sans', label: '黑体', stack: "'PingFang SC', 'Heiti SC', sans-serif" },
];

export const SettingsPanel: React.FC<SettingsPanelProps> = ({
  open,
  settings,
  defaults,
  onClose,
  onChange,
}) => {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="settings-backdrop" onClick={onClose}>
      <div
        className="settings-panel"
        role="dialog"
        aria-label="阅读设置"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="settings-panel__header">
          <h2>阅读设置</h2>
          <button
            type="button"
            className="topbar__icon-btn"
            title="关闭 (Esc)"
            onClick={onClose}
          >
            <X size={15} />
          </button>
        </header>

        <div className="settings-panel__body">
          <section className="settings-row">
            <div className="settings-row__label">主题</div>
            <div className="theme-picker">
              {THEMES.map((theme) => (
                <button
                  key={theme.value}
                  type="button"
                  className={`theme-picker__swatch theme-picker__swatch--${theme.value} ${
                    settings.theme === theme.value ? 'is-active' : ''
                  }`}
                  onClick={() => onChange({ theme: theme.value })}
                >
                  <span className="theme-picker__preview" />
                  {theme.label}
                </button>
              ))}
            </div>
          </section>

          <section className="settings-row">
            <div className="settings-row__label">字体</div>
            <div className="font-picker">
              {FONTS.map((font) => (
                <button
                  key={font.value}
                  type="button"
                  className={`font-picker__btn ${
                    settings.fontFamily === font.value ? 'is-active' : ''
                  }`}
                  style={{ fontFamily: font.stack }}
                  onClick={() => onChange({ fontFamily: font.value })}
                >
                  {font.label}
                </button>
              ))}
            </div>
          </section>

          <section className="settings-row">
            <div className="settings-row__label">
              正文字号
              <span className="settings-row__value">{settings.fontSize}px</span>
            </div>
            <input
              type="range"
              min={13}
              max={22}
              step={1}
              value={settings.fontSize}
              onChange={(event) => onChange({ fontSize: Number(event.target.value) })}
            />
          </section>

          <section className="settings-row">
            <div className="settings-row__label">
              行高
              <span className="settings-row__value">{settings.lineHeight.toFixed(2)}</span>
            </div>
            <input
              type="range"
              min={1.4}
              max={2.4}
              step={0.05}
              value={settings.lineHeight}
              onChange={(event) => onChange({ lineHeight: Number(event.target.value) })}
            />
          </section>

          <section className="settings-row">
            <div className="settings-row__label">
              书页宽度
              <span className="settings-row__value">{settings.bookWidth}px</span>
            </div>
            <input
              type="range"
              min={380}
              max={900}
              step={10}
              value={settings.bookWidth}
              onChange={(event) => onChange({ bookWidth: Number(event.target.value) })}
            />
            <p className="settings-row__hint">
              阅读时也可以拖拽书页右边缘临时调整，松手后自动记住。
            </p>
          </section>
        </div>

        <footer className="settings-panel__footer">
          <button
            type="button"
            className="settings-panel__reset"
            onClick={() => onChange({ ...defaults })}
          >
            恢复默认
          </button>
          <button type="button" className="settings-panel__done" onClick={onClose}>
            完成
          </button>
        </footer>
      </div>
    </div>
  );
};

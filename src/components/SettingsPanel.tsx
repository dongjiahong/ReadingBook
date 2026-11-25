import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { join } from '@tauri-apps/api/path';
import { open } from '@tauri-apps/plugin-dialog';
import {
  Check,
  FolderDown,
  FolderUp,
  Minus,
  Plus,
  RotateCcw,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { isDesktop } from '../services/library';
import type { ReaderFont, ReaderSettings, ReaderTheme } from '../types';
import { useIsMobileLayout } from '../utils/platform';

interface SettingsPanelProps {
  open: boolean;
  settings: ReaderSettings;
  defaults: ReaderSettings;
  onClose: () => void;
  onChange: (patch: Partial<ReaderSettings>) => void;
}

const THEMES: { value: ReaderTheme; label: string; bg: string; fg: string }[] = [
  { value: 'light', label: '浅色', bg: '#ffffff', fg: '#1f2328' },
  { value: 'sepia', label: '护眼', bg: '#f6eedc', fg: '#3a342a' },
  { value: 'dark', label: '深色', bg: '#1b1f24', fg: '#e5eaf0' },
];

const FONTS: { value: ReaderFont; label: string; stack: string }[] = [
  {
    value: 'system',
    label: '系统默认',
    stack: "-apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif",
  },
  { value: 'serif', label: '宋体', stack: "'Songti SC', 'Noto Serif SC', SimSun, serif" },
  {
    value: 'sans',
    label: '黑体',
    stack: "'PingFang SC', 'Noto Sans SC', 'Heiti SC', sans-serif",
  },
];

export const SettingsPanel: React.FC<SettingsPanelProps> = ({
  open: isOpen,
  settings,
  defaults,
  onClose,
  onChange,
}) => {
  const isMobile = useIsMobileLayout();
  const [backupStatus, setBackupStatus] = useState<{
    kind: 'ok' | 'err';
    text: string;
  } | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      setBackupStatus(null);
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const activeFontStack =
    FONTS.find((f) => f.value === settings.fontFamily)?.stack ?? FONTS[0].stack;
  const activeThemeMeta =
    THEMES.find((t) => t.value === settings.theme) ?? THEMES[0];

  const stepFontSize = (delta: number) => {
    const next = Math.min(22, Math.max(13, settings.fontSize + delta));
    onChange({ fontSize: next });
  };

  const stepLineHeight = (delta: number) => {
    const next = Math.round(Math.min(2.4, Math.max(1.4, settings.lineHeight + delta)) * 100) / 100;
    onChange({ lineHeight: next });
  };

  const handleBackupLibrary = async () => {
    setBackupBusy(true);
    setBackupStatus(null);
    try {
      const selected = await open({
        title: '选择存放整库备份的文件夹',
        directory: true,
        multiple: false,
      });
      if (!selected || Array.isArray(selected)) return;
      const now = new Date();
      const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
      const targetDir = await join(selected, `ReadingBook-Backup-${stamp}`);
      await invoke<string>('export_library_backup', { targetDir });
      setBackupStatus({ kind: 'ok', text: `整库备份已保存到 ReadingBook-Backup-${stamp}` });
    } catch (err) {
      setBackupStatus({
        kind: 'err',
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBackupBusy(false);
    }
  };

  const handleRestoreLibrary = async () => {
    setBackupBusy(true);
    setBackupStatus(null);
    try {
      const selected = await open({
        title: '选择之前导出的 ReadingBook 备份文件夹',
        directory: true,
        multiple: false,
      });
      if (!selected || Array.isArray(selected)) return;
      await invoke('restore_library_backup', { sourceDir: selected });
      setBackupStatus({ kind: 'ok', text: '备份恢复成功，正在重新加载书库…' });
      window.setTimeout(() => {
        window.location.reload();
      }, 650);
    } catch (err) {
      setBackupStatus({
        kind: 'err',
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBackupBusy(false);
    }
  };

  return (
    <div className="settings-backdrop" onClick={onClose}>
      <div
        className={`settings-panel settings-v2 ${isMobile ? 'is-sheet' : ''}`}
        role="dialog"
        aria-label="阅读设置"
        onClick={(event) => event.stopPropagation()}
      >
        {isMobile && <div className="settings-v2__handle" aria-hidden="true" />}

        <header className="settings-v2__header">
          <div className="settings-v2__title">
            <SlidersHorizontal size={15} />
            <h2>阅读设置</h2>
          </div>
          <button
            type="button"
            className="topbar__icon-btn"
            title="关闭 (Esc)"
            onClick={onClose}
          >
            <X size={15} />
          </button>
        </header>

        <div className="settings-v2__body">
          {/* Live Typography Preview */}
          <div
            className="settings-preview"
            style={{
              background: activeThemeMeta.bg,
              color: activeThemeMeta.fg,
              fontFamily: activeFontStack,
              fontSize: `${settings.fontSize}px`,
              lineHeight: settings.lineHeight,
            }}
          >
            <div className="settings-preview__badge">排版预览</div>
            阅读不是被动接收，而是在字里行间建立属于自己的思考网络。
          </div>

          {/* Appearance Card */}
          <section className="settings-card">
            <div className="settings-card__title">外观主题</div>
            <div className="theme-picker-v2">
              {THEMES.map((theme) => {
                const active = settings.theme === theme.value;
                return (
                  <button
                    key={theme.value}
                    type="button"
                    className={`theme-tile ${active ? 'is-active' : ''}`}
                    onClick={() => onChange({ theme: theme.value })}
                  >
                    <span
                      className="theme-tile__sample"
                      style={{ background: theme.bg, color: theme.fg }}
                    >
                      Aa
                      {active && (
                        <span className="theme-tile__check">
                          <Check size={10} />
                        </span>
                      )}
                    </span>
                    <span className="theme-tile__label">{theme.label}</span>
                  </button>
                );
              })}
            </div>
          </section>

          {/* Typography Card */}
          <section className="settings-card">
            <div className="settings-card__title">字体与排版</div>

            <div className="font-segmented">
              {FONTS.map((font) => (
                <button
                  key={font.value}
                  type="button"
                  className={`font-segmented__item ${
                    settings.fontFamily === font.value ? 'is-active' : ''
                  }`}
                  style={{ fontFamily: font.stack }}
                  onClick={() => onChange({ fontFamily: font.value })}
                >
                  {font.label}
                </button>
              ))}
            </div>

            <div className="settings-control">
              <div className="settings-control__head">
                <span>正文字号</span>
                <span className="settings-pill-val">{settings.fontSize}px</span>
              </div>
              <div className="settings-slider-row">
                <button
                  type="button"
                  className="settings-step-btn"
                  aria-label="减小字号"
                  onClick={() => stepFontSize(-1)}
                >
                  <Minus size={13} />
                </button>
                <input
                  type="range"
                  className="settings-range"
                  min={13}
                  max={22}
                  step={1}
                  value={settings.fontSize}
                  onChange={(event) => onChange({ fontSize: Number(event.target.value) })}
                />
                <button
                  type="button"
                  className="settings-step-btn"
                  aria-label="增大字号"
                  onClick={() => stepFontSize(1)}
                >
                  <Plus size={13} />
                </button>
              </div>
            </div>

            <div className="settings-control">
              <div className="settings-control__head">
                <span>段落行高</span>
                <span className="settings-pill-val">{settings.lineHeight.toFixed(2)}</span>
              </div>
              <div className="settings-slider-row">
                <button
                  type="button"
                  className="settings-step-btn"
                  aria-label="减小行高"
                  onClick={() => stepLineHeight(-0.05)}
                >
                  <Minus size={13} />
                </button>
                <input
                  type="range"
                  className="settings-range"
                  min={1.4}
                  max={2.4}
                  step={0.05}
                  value={settings.lineHeight}
                  onChange={(event) =>
                    onChange({ lineHeight: Number(event.target.value) })
                  }
                />
                <button
                  type="button"
                  className="settings-step-btn"
                  aria-label="增大行高"
                  onClick={() => stepLineHeight(0.05)}
                >
                  <Plus size={13} />
                </button>
              </div>
            </div>

            {!isMobile && (
              <div className="settings-control">
                <div className="settings-control__head">
                  <span>书页宽度</span>
                  <span className="settings-pill-val">{settings.bookWidth}px</span>
                </div>
                <input
                  type="range"
                  className="settings-range"
                  min={380}
                  max={900}
                  step={10}
                  value={settings.bookWidth}
                  onChange={(event) => onChange({ bookWidth: Number(event.target.value) })}
                />
                <p className="settings-control__hint">
                  阅读时可直接拖拽书页右边缘调整，松手自动记住。
                </p>
              </div>
            )}
          </section>

          {/* Data Backup Card (Desktop only; mobile uses WiFi LAN Sync) */}
          {isDesktop() && !isMobile && (
            <section className="settings-card">
              <div className="settings-card__title">整库数据备份</div>
              <div className="settings-backup-actions">
                <button
                  type="button"
                  className="settings-backup-btn"
                  disabled={backupBusy}
                  onClick={() => void handleBackupLibrary()}
                >
                  <FolderDown size={14} />
                  <span>导出整库备份</span>
                </button>
                <button
                  type="button"
                  className="settings-backup-btn"
                  disabled={backupBusy}
                  onClick={() => void handleRestoreLibrary()}
                >
                  <FolderUp size={14} />
                  <span>从备份恢复</span>
                </button>
              </div>
              {backupStatus && (
                <p
                  className={`settings-backup-status ${
                    backupStatus.kind === 'err' ? 'is-error' : 'is-ok'
                  }`}
                >
                  {backupStatus.text}
                </p>
              )}
              <p className="settings-control__hint">
                含全部书籍、批注数据库与卡片附图，换机或重装时一键迁移。
              </p>
            </section>
          )}
        </div>

        <footer className="settings-v2__footer">
          <button
            type="button"
            className="settings-v2__reset"
            onClick={() => onChange({ ...defaults })}
          >
            <RotateCcw size={13} />
            <span>恢复默认</span>
          </button>
          <button type="button" className="settings-v2__done" onClick={onClose}>
            完成
          </button>
        </footer>
      </div>
    </div>
  );
};

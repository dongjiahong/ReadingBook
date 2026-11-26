import React from 'react';
import { RefreshCw, Wifi } from 'lucide-react';
import type { SyncRuntimeSnapshot } from '../services/sync';

interface SyncStatusBadgeProps {
  runtime: SyncRuntimeSnapshot;
  variant?: 'pill' | 'icon';
  className?: string;
  onClick: () => void;
}

function formatRelativeTime(ts: number | null): string {
  if (!ts) return '';
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 10) return '刚刚';
  if (diffSec < 60) return `${diffSec} 秒前`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} 分钟前`;
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function describeSyncState(runtime: SyncRuntimeSnapshot): {
  label: string;
  tooltip: string;
} {
  const peerList =
    runtime.onlinePeerNames.length > 0 ? runtime.onlinePeerNames.join('、') : '';
  const lastStr = runtime.lastSyncAt ? `上次同步：${formatRelativeTime(runtime.lastSyncAt)}` : '';

  switch (runtime.phase) {
    case 'syncing':
      return {
        label: '同步中',
        tooltip: runtime.detail || `正在与 ${runtime.activePeerName || '配对设备'} 同步…`,
      };
    case 'synced':
      return {
        label: '已同步',
        tooltip: [
          peerList ? `在线：${peerList}` : '已连接配对设备',
          runtime.lastSummary || lastStr,
        ]
          .filter(Boolean)
          .join(' · '),
      };
    case 'pending':
      return {
        label: '待同步',
        tooltip:
          runtime.onlinePeerIds.length > 0
            ? '本地有新改动，即将自动同步'
            : '本地有未同步改动，等待配对设备上线后自动同步',
      };
    case 'offline':
      return {
        label: '离线',
        tooltip: ['配对设备当前离线', lastStr].filter(Boolean).join(' · '),
      };
    case 'error':
      return {
        label: '同步异常',
        tooltip: runtime.lastError ? `同步失败：${runtime.lastError}` : '同步失败，点击查看详情',
      };
    case 'unpaired':
    default:
      return {
        label: '局域网同步',
        tooltip: 'WiFi 局域网同步（尚未配对设备）',
      };
  }
}

export const SyncStatusBadge: React.FC<SyncStatusBadgeProps> = ({
  runtime,
  variant = 'icon',
  className = '',
  onClick,
}) => {
  const { label, tooltip } = describeSyncState(runtime);
  const isSyncing = runtime.phase === 'syncing';
  const showDot = runtime.phase !== 'unpaired' && !isSyncing;

  if (variant === 'pill') {
    return (
      <button
        type="button"
        className={`sync-pill is-${runtime.phase} ${className}`.trim()}
        title={tooltip}
        aria-label={tooltip}
        onClick={onClick}
      >
        {isSyncing ? (
          <RefreshCw size={12} className="topbar__spinner sync-pill__icon" />
        ) : showDot ? (
          <span className={`sync-state-dot is-${runtime.phase}`} aria-hidden="true" />
        ) : (
          <Wifi size={13} className="sync-pill__icon" />
        )}
        <span className="sync-pill__label">{label}</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      className={`sync-icon-btn is-${runtime.phase} ${className}`.trim()}
      title={tooltip}
      aria-label={tooltip}
      onClick={onClick}
    >
      {isSyncing ? (
        <RefreshCw size={15} className="topbar__spinner" />
      ) : (
        <Wifi size={15} />
      )}
      {showDot && <span className={`sync-icon-btn__dot is-${runtime.phase}`} aria-hidden="true" />}
    </button>
  );
};

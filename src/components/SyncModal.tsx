import React, { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  AlertCircle,
  CheckCircle2,
  KeyRound,
  Loader2,
  RefreshCw,
  Trash2,
  Wifi,
  X,
} from 'lucide-react';
import {
  deleteSyncPeer,
  getSyncRuntimeSnapshot,
  listSyncPeers,
  probeOnForeground,
  setAutoSyncEnabled,
  subscribeSyncRuntime,
  triggerManualSyncPeer,
  upsertSyncPeer,
  type DiscoveredPeer,
  type PairedPeerInfo,
  type SyncRuntimeSnapshot,
  type SyncStatus,
} from '../services/sync';
import type { SyncPeerRecord } from '../types';
import { describeSyncState } from './SyncStatusBadge';

interface SyncModalProps {
  open: boolean;
  onClose: () => void;
  onSynced: () => void;
}

export const SyncModal: React.FC<SyncModalProps> = ({ open, onClose, onSynced }) => {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [runtime, setRuntime] = useState<SyncRuntimeSnapshot>(() =>
    getSyncRuntimeSnapshot()
  );
  const [peers, setPeers] = useState<SyncPeerRecord[]>([]);
  const [onlineMap, setOnlineMap] = useState<Record<string, boolean>>({});
  const [pairTarget, setPairTarget] = useState<{ ip: string; port: number; name: string } | null>(
    null
  );
  const [manualIp, setManualIp] = useState('');
  const [pairCode, setPairCode] = useState('');
  const [busyMsg, setBusyMsg] = useState<string | null>(null);
  const [resultMsg, setResultMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    return subscribeSyncRuntime(setRuntime);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [st, savedPeers] = await Promise.all([
        invoke<SyncStatus>('sync_get_status'),
        listSyncPeers(),
      ]);
      setStatus(st);
      setPeers(savedPeers);

      // Ping-verify paired peers
      const nextOnline: Record<string, boolean> = {};
      await Promise.all(
        savedPeers.map(async (p) => {
          const discovered = st.discoveredPeers.find((d) => d.deviceId === p.deviceId);
          const ip = discovered?.ip ?? p.lastIp;
          const port = discovered?.httpPort ?? p.lastPort ?? 45889;
          if (!ip) {
            nextOnline[p.deviceId] = false;
            return;
          }
          nextOnline[p.deviceId] = await invoke<boolean>('sync_ping_peer', {
            ip,
            port,
          }).catch(() => false);
        })
      );
      setOnlineMap(nextOnline);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setErrorMsg(null);
    setResultMsg(null);
    void probeOnForeground();
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 3500);
    return () => window.clearInterval(timer);
  }, [open, refresh]);

  const handleToggleAutoSync = async () => {
    setErrorMsg(null);
    try {
      await setAutoSyncEnabled(!runtime.autoSyncEnabled);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleGenerateCode = async () => {
    setErrorMsg(null);
    try {
      await invoke('sync_generate_pairing_code');
      await refresh();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handlePairSubmit = async () => {
    const ip = pairTarget?.ip || manualIp.trim();
    const port = pairTarget?.port || 45889;
    if (!ip || pairCode.trim().length !== 6) {
      setErrorMsg('请输入正确的设备 IP 和 6 位配对码');
      return;
    }
    setBusyMsg(`正在与 ${ip} 配对…`);
    setErrorMsg(null);
    try {
      const info = await invoke<PairedPeerInfo>('sync_pair_with_peer', {
        ip,
        port,
        code: pairCode.trim(),
      });
      await upsertSyncPeer(info);
      setPairTarget(null);
      setPairCode('');
      setManualIp('');
      setResultMsg(`已成功配对 ${info.deviceName}`);
      await refresh();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyMsg(null);
    }
  };

  const handleSyncPeer = async (peer: SyncPeerRecord) => {
    const discovered = status?.discoveredPeers.find((d) => d.deviceId === peer.deviceId);
    const ip = discovered?.ip ?? peer.lastIp;
    const port = discovered?.httpPort ?? peer.lastPort ?? 45889;
    if (!ip) {
      setErrorMsg('未找到该设备的局域网 IP，请确保两端在同一 WiFi 下');
      return;
    }
    setBusyMsg(`正在同步 ${peer.deviceName}…`);
    setErrorMsg(null);
    setResultMsg(null);
    try {
      const res = await triggerManualSyncPeer(peer, ip, port);
      setResultMsg(
        `同步完成：拉取 ${res.filesPulled} 个文件，推送 ${res.filesPushed} 个文件`
      );
      onSynced();
      await refresh();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyMsg(null);
    }
  };

  if (!open) return null;

  const pairedIds = new Set(peers.map((p) => p.deviceId));
  const unpairedDiscovered: DiscoveredPeer[] = (status?.discoveredPeers ?? []).filter(
    (d) => !pairedIds.has(d.deviceId)
  );
  const stateDesc = describeSyncState(runtime);
  const isBusy = Boolean(busyMsg) || runtime.phase === 'syncing';

  return (
    <div className="settings-backdrop" onClick={onClose}>
      <div
        className="settings-panel sync-modal"
        role="dialog"
        aria-label="WiFi 局域网同步"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-panel__header">
          <div className="sync-modal__title">
            <Wifi size={15} />
            <h2>WiFi 局域网同步</h2>
          </div>
          <button
            type="button"
            className="topbar__icon-btn"
            title="关闭"
            onClick={onClose}
          >
            <X size={15} />
          </button>
        </div>

        <div className="settings-panel__body sync-modal__body">
          {/* Live sync state overview */}
          <div className={`sync-live-card is-${runtime.phase}`}>
            <div className="sync-live-card__left">
              {runtime.phase === 'syncing' ? (
                <Loader2 size={15} className="topbar__spinner sync-live-card__icon" />
              ) : runtime.phase === 'error' ? (
                <AlertCircle size={15} className="sync-live-card__icon" />
              ) : (
                <span className={`sync-state-dot is-${runtime.phase}`} />
              )}
              <div className="sync-live-card__text">
                <div className="sync-live-card__title">{stateDesc.label}</div>
                <div className="sync-live-card__sub">{stateDesc.tooltip}</div>
              </div>
            </div>
          </div>

          {/* Event-driven auto-sync switch */}
          <div className="sync-auto-row">
            <div className="sync-auto-row__text">
              <div className="sync-auto-row__title">主动自动同步</div>
              <div className="sync-auto-row__desc">
                批注变动、进度保存、设备上线或切回前台时自动触发，不做定时轮询
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={runtime.autoSyncEnabled}
              className={`sync-switch ${runtime.autoSyncEnabled ? 'is-on' : ''}`}
              onClick={() => void handleToggleAutoSync()}
            >
              <span className="sync-switch__thumb" />
            </button>
          </div>

          <div className="sync-self-card">
            <div>
              <div className="sync-self-card__name">
                {status?.deviceName || '本机'}
              </div>
              <div className="sync-self-card__addr">
                {status?.localIp
                  ? `${status.localIp}:${status.httpPort}`
                  : '未检测到局域网 IP'}
              </div>
            </div>
            <button
              type="button"
              className="sync-btn"
              onClick={() => void handleGenerateCode()}
            >
              <KeyRound size={13} />
              <span>生成配对码</span>
            </button>
          </div>

          {status?.activePairingCode && (
            <div className="sync-code-banner">
              <span>在另一台设备输入 6 位配对码（5 分钟有效）：</span>
              <strong>{status.activePairingCode}</strong>
            </div>
          )}

          {(busyMsg || runtime.detail) && (
            <div className="sync-status-banner">
              <Loader2 size={14} className="topbar__spinner" />
              <span>{runtime.detail || busyMsg}</span>
            </div>
          )}

          {resultMsg && (
            <div className="sync-status-banner is-ok">
              <CheckCircle2 size={14} />
              <span>{resultMsg}</span>
            </div>
          )}

          {(errorMsg || runtime.lastError) && (
            <div className="sync-status-banner is-err">
              {errorMsg || runtime.lastError}
            </div>
          )}

          <div className="sync-section">
            <div className="sync-section__head">已配对设备</div>
            {peers.length === 0 ? (
              <div className="sync-empty">暂无已配对设备</div>
            ) : (
              peers.map((peer) => {
                const online =
                  Boolean(onlineMap[peer.deviceId]) ||
                  runtime.onlinePeerIds.includes(peer.deviceId);
                const discovered = status?.discoveredPeers.find(
                  (d) => d.deviceId === peer.deviceId
                );
                const addr = discovered
                  ? `${discovered.ip}:${discovered.httpPort}`
                  : peer.lastIp
                    ? `${peer.lastIp}:${peer.lastPort ?? 45889}`
                    : '离线';
                return (
                  <div key={peer.deviceId} className="sync-peer-row">
                    <div className="sync-peer-row__info">
                      <span
                        className={`sync-dot ${online ? 'is-online' : ''}`}
                        title={online ? '在线' : '离线'}
                      />
                      <div>
                        <div className="sync-peer-row__name">{peer.deviceName}</div>
                        <div className="sync-peer-row__meta">
                          {addr}
                          {peer.lastSyncAt > 0
                            ? ` · 上次 ${new Date(peer.lastSyncAt).toLocaleTimeString()}`
                            : ''}
                        </div>
                      </div>
                    </div>
                    <div className="sync-peer-row__actions">
                      <button
                        type="button"
                        className="sync-btn sync-btn--primary"
                        disabled={isBusy}
                        onClick={() => void handleSyncPeer(peer)}
                      >
                        <RefreshCw size={12} className={isBusy ? 'topbar__spinner' : ''} />
                        <span>立即同步</span>
                      </button>
                      <button
                        type="button"
                        className="topbar__icon-btn"
                        title="解除配对"
                        onClick={() =>
                          void deleteSyncPeer(peer.deviceId).then(() => refresh())
                        }
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <div className="sync-section">
            <div className="sync-section__head">局域网发现的设备 (UDP)</div>
            {unpairedDiscovered.length === 0 ? (
              <div className="sync-empty">
                正在同一 WiFi 下扫描其他 ReadingBook 设备…
              </div>
            ) : (
              unpairedDiscovered.map((d) => (
                <div key={d.deviceId} className="sync-peer-row">
                  <div className="sync-peer-row__info">
                    <span className="sync-dot is-online" />
                    <div>
                      <div className="sync-peer-row__name">{d.deviceName}</div>
                      <div className="sync-peer-row__meta">
                        {d.ip}:{d.httpPort}
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="sync-btn"
                    onClick={() =>
                      setPairTarget({ ip: d.ip, port: d.httpPort, name: d.deviceName })
                    }
                  >
                    配对
                  </button>
                </div>
              ))
            )}
          </div>

          <div className="sync-section">
            <div className="sync-section__head">
              {pairTarget ? `与 ${pairTarget.name} (${pairTarget.ip}) 配对` : '手动输入 IP 配对'}
            </div>
            <div className="sync-pair-form">
              {!pairTarget && (
                <input
                  type="text"
                  className="sync-input"
                  placeholder="对方局域网 IP（如 192.168.1.20）"
                  value={manualIp}
                  onChange={(e) => setManualIp(e.target.value)}
                />
              )}
              <input
                type="text"
                className="sync-input sync-input--code"
                placeholder="6位配对码"
                maxLength={6}
                value={pairCode}
                onChange={(e) => setPairCode(e.target.value)}
              />
              <button
                type="button"
                className="sync-btn sync-btn--primary"
                disabled={isBusy}
                onClick={() => void handlePairSubmit()}
              >
                确认配对
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

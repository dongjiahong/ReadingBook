import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
  Crosshair,
  Download,
  Headphones,
  Loader2,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Wrench,
  X,
} from 'lucide-react';
import { updateBookTtsLocator } from '../services/db';
import type { BookParagraph } from '../types';
import {
  buildSentencesFromParagraphs,
  downloadTtsModel,
  getTtsStatus,
  KOKORO_VOICES,
  parseTtsLocator,
  SentenceTtsController,
  setupTtsRuntime,
  stopTtsWorker,
  type TtsSentence,
  type TtsStatus,
} from '../utils/ttsEngine';

interface TtsProgressEvent {
  task: 'runtime' | 'model';
  percent: number | null;
  stage: string;
  log: string | null;
}

interface TtsPlayerBarProps {
  open: boolean;
  bookId: string;
  initialLocator?: string | null;
  paragraphs: BookParagraph[];
  getCurrentVisibleParagraphId?: () => string | null;
  onClose: () => void;
  onActiveParagraphChange?: (paragraphId: string | null) => void;
}

const SPEED_OPTIONS = [0.85, 1.0, 1.15, 1.3, 1.5];

export const TtsPlayerBar: React.FC<TtsPlayerBarProps> = ({
  open,
  bookId,
  initialLocator,
  paragraphs,
  getCurrentVisibleParagraphId,
  onClose,
  onActiveParagraphChange,
}) => {
  const sentences = useMemo(
    () => buildSentencesFromParagraphs(paragraphs),
    [paragraphs]
  );

  const [status, setStatus] = useState<TtsStatus | null>(null);
  const [progress, setProgress] = useState<TtsProgressEvent | null>(null);
  const [elapsedSec, setElapsedSec] = useState<number>(0);
  const [setupError, setSetupError] = useState<string | null>(null);

  useEffect(() => {
    if (!progress) {
      setElapsedSec(0);
      return;
    }
    const start = Date.now();
    const timer = window.setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [Boolean(progress)]);

  const parsedInitial = useMemo(
    () => parseTtsLocator(initialLocator),
    [initialLocator]
  );

  const [speakerId, setSpeakerId] = useState<number>(parsedInitial?.speakerId ?? 45);
  const [speed, setSpeed] = useState<number>(parsedInitial?.speed ?? 1.0);
  const [playState, setPlayState] = useState<{
    playing: boolean;
    loading: boolean;
    index: number;
    total: number;
    sentence: TtsSentence | null;
    error: string | null;
  }>({
    playing: false,
    loading: false,
    index: 0,
    total: sentences.length,
    sentence: sentences[0] ?? null,
    error: null,
  });

  const controllerRef = useRef<SentenceTtsController | null>(null);
  const onActiveParaRef = useRef(onActiveParagraphChange);
  onActiveParaRef.current = onActiveParagraphChange;
  const getVisibleParaRef = useRef(getCurrentVisibleParagraphId);
  getVisibleParaRef.current = getCurrentVisibleParagraphId;

  const findStartIndexForParagraph = useCallback(
    (pid: string | null): number => {
      if (!pid) return -1;
      const exactIdx = sentences.findIndex((s) => s.paragraphId === pid);
      if (exactIdx >= 0) return exactIdx;
      const paraOrder = new Map(paragraphs.map((p, i) => [p.id, i]));
      const targetOrder = paraOrder.get(pid);
      if (targetOrder === undefined) return -1;
      return sentences.findIndex((s) => (paraOrder.get(s.paragraphId) ?? -1) >= targetOrder);
    },
    [paragraphs, sentences]
  );

  const refreshStatus = useCallback(async () => {
    try {
      const s = await getTtsStatus();
      setStatus(s);
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : '读取离线 TTS 状态失败');
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void refreshStatus();
  }, [open, refreshStatus]);

  useEffect(() => {
    if (!open) return;
    let unlisten: (() => void) | null = null;
    void listen<TtsProgressEvent>('tts-progress', (event) => {
      setProgress(event.payload);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      controllerRef.current?.dispose();
      controllerRef.current = null;
      onActiveParaRef.current?.(null);
      return;
    }

    const ctrl = new SentenceTtsController((next) => {
      setPlayState(next);
      onActiveParaRef.current?.(
        next.playing && next.sentence ? next.sentence.paragraphId : null
      );
      if (next.sentence) {
        const locator = JSON.stringify({
          paragraphId: next.sentence.paragraphId,
          sentenceInParagraph: next.sentence.sentenceInParagraph,
          speakerId,
          speed,
        });
        void updateBookTtsLocator(bookId, locator).catch(() => {});
      }
    });

    // Align TTS opening position with the user's current visible reading paragraph first.
    let startIdx = 0;
    const visiblePid = getVisibleParaRef.current?.() ?? null;
    const fromVisible = findStartIndexForParagraph(visiblePid);
    if (fromVisible >= 0) {
      startIdx = fromVisible;
    } else if (parsedInitial) {
      const found = sentences.findIndex(
        (s) =>
          s.paragraphId === parsedInitial.paragraphId &&
          s.sentenceInParagraph >= parsedInitial.sentenceInParagraph
      );
      if (found >= 0) startIdx = found;
    }

    ctrl.setVoice(speakerId);
    ctrl.setSpeed(speed);
    ctrl.setSentences(sentences, startIdx);
    controllerRef.current = ctrl;

    return () => {
      ctrl.dispose();
      controllerRef.current = null;
      onActiveParaRef.current?.(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, bookId, sentences]);

  const handleClose = useCallback(() => {
    controllerRef.current?.dispose();
    controllerRef.current = null;
    onActiveParaRef.current?.(null);
    void stopTtsWorker();
    onClose();
  }, [onClose]);

  const handleInstallRuntime = async () => {
    setSetupError(null);
    setProgress({
      task: 'runtime',
      percent: 5,
      stage: '准备安装离线推理引擎 (sherpa-onnx)…',
      log: null,
    });
    try {
      await setupTtsRuntime();
      await refreshStatus();
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : String(err));
    } finally {
      setProgress(null);
    }
  };

  const handleDownloadModel = async () => {
    setSetupError(null);
    setProgress({
      task: 'model',
      percent: 1,
      stage: '准备下载 Kokoro v1.1-zh 中英模型…',
      log: null,
    });
    try {
      await downloadTtsModel();
      await refreshStatus();
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : String(err));
    } finally {
      setProgress(null);
    }
  };

  if (!open) return null;

  const isReady = Boolean(status?.runtimeReady && status?.modelReady);
  const progressPct =
    playState.total > 0
      ? Math.round(((playState.index + 1) / playState.total) * 100)
      : 0;

  return (
    <div className="tts-bar" role="region" aria-label="离线听书控制台">
      <div className="tts-bar__top">
        <div className="tts-bar__title">
          <Headphones size={14} />
          <span>离线听书 · Kokoro 中英双语</span>
          {isReady && playState.total > 0 && (
            <span className="tts-bar__counter">
              {playState.index + 1} / {playState.total} 句 ({progressPct}%)
            </span>
          )}
        </div>
        <button
          type="button"
          className="topbar__icon-btn"
          title="关闭听书并释放模型内存"
          onClick={handleClose}
        >
          <X size={14} />
        </button>
      </div>

      {!isReady ? (
        <div className="tts-bar__setup">
          {progress ? (
            <div className="tts-bar__progress-box">
              <div className="tts-bar__progress-head">
                <span className="tts-bar__progress-stage">
                  <Loader2 size={13} className="topbar__spinner" />
                  <span>{progress.stage}</span>
                </span>
                <span className="tts-bar__progress-pct">
                  {progress.percent !== null ? `${progress.percent}%` : ''}
                  {elapsedSec > 0 ? ` · ${elapsedSec}s` : ''}
                </span>
              </div>
              <div className="tts-bar__progress-track">
                <div
                  className="tts-bar__progress-fill"
                  style={{ width: `${Math.min(100, Math.max(2, progress.percent ?? 15))}%` }}
                />
              </div>
              {progress.log && (
                <div className="tts-bar__progress-log" title={progress.log}>
                  {progress.log}
                </div>
              )}
            </div>
          ) : (
            <div className="tts-bar__setup-actions">
              {!status?.runtimeReady && (
                <button
                  type="button"
                  className="tts-bar__setup-btn"
                  onClick={() => void handleInstallRuntime()}
                >
                  <Wrench size={13} />
                  <span>1. 安装离线推理引擎 (sherpa-onnx)</span>
                </button>
              )}
              {!status?.modelReady && (
                <button
                  type="button"
                  className="tts-bar__setup-btn tts-bar__setup-btn--primary"
                  onClick={() => void handleDownloadModel()}
                >
                  <Download size={13} />
                  <span>
                    {status?.runtimeReady ? '' : '2. '}下载 Kokoro 中英模型 (~140MB)
                  </span>
                </button>
              )}
            </div>
          )}
          {setupError && <div className="tts-bar__error">{setupError}</div>}
        </div>
      ) : sentences.length === 0 ? (
        <div className="tts-bar__empty">
          当前文档无可朗读正文（目前优先支持 EPUB 文本朗读）
        </div>
      ) : (
        <>
          <div className="tts-bar__sentence" title={playState.sentence?.text}>
            {playState.sentence?.text ?? '准备就绪'}
          </div>

          {playState.error && <div className="tts-bar__error">{playState.error}</div>}

          <div className="tts-bar__controls">
            <div className="tts-bar__transport">
              <button
                type="button"
                className="tts-bar__icon-btn"
                title="上一句"
                disabled={playState.index <= 0}
                onClick={() => void controllerRef.current?.prev()}
              >
                <SkipBack size={15} />
              </button>

              <button
                type="button"
                className="tts-bar__play-btn"
                title={playState.playing ? '暂停' : '开始朗读'}
                onClick={() => {
                  if (playState.playing) {
                    controllerRef.current?.pause();
                  } else {
                    void controllerRef.current?.play();
                  }
                }}
              >
                {playState.loading ? (
                  <Loader2 size={16} className="topbar__spinner" />
                ) : playState.playing ? (
                  <Pause size={16} />
                ) : (
                  <Play size={16} />
                )}
              </button>

              <button
                type="button"
                className="tts-bar__icon-btn"
                title="下一句"
                disabled={playState.index + 1 >= playState.total}
                onClick={() => void controllerRef.current?.next()}
              >
                <SkipForward size={15} />
              </button>

              {getCurrentVisibleParagraphId && (
                <button
                  type="button"
                  className="tts-bar__icon-btn"
                  title="从当前阅读位置开始朗读"
                  onClick={() => {
                    const idx = findStartIndexForParagraph(
                      getVisibleParaRef.current?.() ?? null
                    );
                    if (idx >= 0) {
                      void controllerRef.current?.play(idx);
                    }
                  }}
                >
                  <Crosshair size={14} />
                </button>
              )}
            </div>

            <div className="tts-bar__options">
              <select
                className="tts-bar__select"
                aria-label="选择音色"
                value={speakerId}
                onChange={(e) => {
                  const nextSid = Number(e.target.value);
                  setSpeakerId(nextSid);
                  controllerRef.current?.setVoice(nextSid);
                }}
              >
                {KOKORO_VOICES.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
              </select>

              <button
                type="button"
                className="tts-bar__speed-btn"
                title="切换语速"
                onClick={() => {
                  const idx = SPEED_OPTIONS.indexOf(speed);
                  const nextSpeed = SPEED_OPTIONS[(idx + 1) % SPEED_OPTIONS.length];
                  setSpeed(nextSpeed);
                  controllerRef.current?.setSpeed(nextSpeed);
                }}
              >
                {speed.toFixed(2).replace(/\.00$/, '.0')}x
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

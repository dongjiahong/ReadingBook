import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Crosshair,
  Headphones,
  Loader2,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  X,
} from 'lucide-react';
import { updateBookTtsLocator } from '../services/db';
import type { BookParagraph } from '../types';
import {
  buildSentencesFromParagraphs,
  DEFAULT_EDGE_VOICE,
  EDGE_VOICES,
  parseTtsLocator,
  SentenceTtsController,
  type TtsSentence,
} from '../utils/ttsEngine';

interface TtsPlayerBarProps {
  open: boolean;
  bookId: string;
  initialLocator?: string | null;
  paragraphs: BookParagraph[];
  getCurrentVisibleParagraphId?: () => string | null;
  onClose: () => void;
  onActiveParagraphChange?: (paragraphId: string | null) => void;
}

const SPEED_OPTIONS = [0.85, 1.0, 1.25, 1.5, 2.0, 2.5];

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

  const parsedInitial = useMemo(
    () => parseTtsLocator(initialLocator),
    [initialLocator]
  );

  const [voice, setVoice] = useState<string>(parsedInitial?.voice ?? DEFAULT_EDGE_VOICE);
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
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const speedRef = useRef(speed);
  speedRef.current = speed;

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

  useEffect(() => {
    if (!open) {
      controllerRef.current?.dispose();
      controllerRef.current = null;
      onActiveParaRef.current?.(null);
      return;
    }

    const ctrl = new SentenceTtsController(bookId, (next) => {
      setPlayState(next);
      onActiveParaRef.current?.(
        next.playing && next.sentence ? next.sentence.paragraphId : null
      );
      if (next.sentence) {
        const locator = JSON.stringify({
          paragraphId: next.sentence.paragraphId,
          sentenceInParagraph: next.sentence.sentenceInParagraph,
          voice: voiceRef.current,
          speed: speedRef.current,
        });
        void updateBookTtsLocator(bookId, locator).catch(() => {});
      }
    });

    // Align TTS start with the currently visible reading paragraph first.
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

    ctrl.setVoice(voiceRef.current);
    ctrl.setSpeed(speedRef.current);
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
    onClose();
  }, [onClose]);

  if (!open) return null;

  const progressPct =
    playState.total > 0
      ? Math.round(((playState.index + 1) / playState.total) * 100)
      : 0;

  return (
    <div className="tts-bar" role="region" aria-label="在线听书控制台">
      <div className="tts-bar__top">
        <div className="tts-bar__title">
          <Headphones size={14} />
          <span>听书 · Edge Neural TTS</span>
          {playState.total > 0 && (
            <span className="tts-bar__counter">
              {playState.index + 1} / {playState.total} 段 ({progressPct}%)
            </span>
          )}
        </div>
        <button
          type="button"
          className="topbar__icon-btn"
          title="关闭听书"
          onClick={handleClose}
        >
          <X size={14} />
        </button>
      </div>

      {sentences.length === 0 ? (
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
                title="上一段"
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
                title="下一段"
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
                value={voice}
                onChange={(e) => {
                  const nextVoice = e.target.value;
                  setVoice(nextVoice);
                  controllerRef.current?.setVoice(nextVoice);
                }}
              >
                {EDGE_VOICES.map((v) => (
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

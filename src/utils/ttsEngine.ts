import { invoke } from '@tauri-apps/api/core';
import type { BookParagraph } from '../types';

export interface TtsStatus {
  runtimeReady: boolean;
  modelReady: boolean;
  modelId: string;
  modelDir: string;
  pythonPath: string | null;
  workerRunning: boolean;
}

export interface TtsSentence {
  index: number;
  paragraphId: string;
  sentenceInParagraph: number;
  text: string;
}

export interface TtsLocator {
  paragraphId: string;
  sentenceInParagraph: number;
  speakerId?: number;
  speed?: number;
}

export interface TtsVoicePreset {
  id: number;
  label: string;
  lang: 'zh' | 'en';
}

/** Curated Kokoro v1.1-zh (103 speakers) voice presets covering ZH + EN. */
export const KOKORO_VOICES: TtsVoicePreset[] = [
  { id: 45, label: '中文女声 · 柔和 (zf_001)', lang: 'zh' },
  { id: 46, label: '中文女声 · 清晰 (zf_002)', lang: 'zh' },
  { id: 50, label: '中文女声 · 知性 (zf_006)', lang: 'zh' },
  { id: 85, label: '中文男声 · 沉稳 (zm_009)', lang: 'zh' },
  { id: 90, label: '中文男声 · 播音 (zm_014)', lang: 'zh' },
  { id: 0, label: 'English · Heart (af_maple)', lang: 'en' },
  { id: 3, label: 'English · Alloy (af_sol)', lang: 'en' },
];

const SENTENCE_SPLIT_RE = /[^。！？；.!?\n]+[。！？；.!?\n]?/g;
const MAX_SENTENCE_CHARS = 72;

function splitTextIntoSentences(raw: string): string[] {
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  if (!cleaned) return [];

  const chunks = cleaned.match(SENTENCE_SPLIT_RE) ?? [cleaned];
  const result: string[] = [];

  for (const chunk of chunks) {
    const part = chunk.trim();
    if (!part) continue;
    if (part.length <= MAX_SENTENCE_CHARS) {
      result.push(part);
      continue;
    }
    // Further split very long clauses by commas so mobile/CPU synthesis stays snappy
    const subParts = part.split(/(?<=[，,、：:])/);
    let buf = '';
    for (const sub of subParts) {
      if (buf.length + sub.length > MAX_SENTENCE_CHARS && buf.trim()) {
        result.push(buf.trim());
        buf = sub;
      } else {
        buf += sub;
      }
    }
    if (buf.trim()) result.push(buf.trim());
  }

  return result;
}

export function buildSentencesFromParagraphs(paragraphs: BookParagraph[]): TtsSentence[] {
  const list: TtsSentence[] = [];
  for (const p of paragraphs) {
    if (p.type === 'image' || p.type === 'table') continue;
    if (p.type === 'quote' && p.lines) {
      for (const line of p.lines) {
        const parts = splitTextIntoSentences(line.text);
        parts.forEach((text, i) => {
          list.push({
            index: list.length,
            paragraphId: line.id,
            sentenceInParagraph: i,
            text,
          });
        });
      }
      continue;
    }
    if (p.text) {
      const parts = splitTextIntoSentences(p.text);
      parts.forEach((text, i) => {
        list.push({
          index: list.length,
          paragraphId: p.id,
          sentenceInParagraph: i,
          text,
        });
      });
    }
  }
  return list;
}

export function parseTtsLocator(raw: string | null | undefined): TtsLocator | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<TtsLocator>;
    if (typeof parsed.paragraphId !== 'string') return null;
    return {
      paragraphId: parsed.paragraphId,
      sentenceInParagraph: Number(parsed.sentenceInParagraph) || 0,
      speakerId: typeof parsed.speakerId === 'number' ? parsed.speakerId : undefined,
      speed: typeof parsed.speed === 'number' ? parsed.speed : undefined,
    };
  } catch {
    return null;
  }
}

export async function getTtsStatus(): Promise<TtsStatus> {
  return invoke<TtsStatus>('tts_status');
}

export async function setupTtsRuntime(): Promise<string> {
  return invoke<string>('tts_setup_runtime');
}

export async function downloadTtsModel(): Promise<string> {
  return invoke<string>('tts_download_model');
}

export async function stopTtsWorker(): Promise<void> {
  await invoke('tts_stop_worker').catch(() => {});
}

function base64ToWavUrl(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: 'audio/wav' });
  return URL.createObjectURL(blob);
}

export interface TtsSynthResponse {
  wavB64: string;
  sampleRate: number;
}

/**
 * Sliding-window sentence TTS player:
 * - Synthesizes the current sentence and pre-fetches up to 2 sentences ahead.
 * - Serializes synthesis requests so CPU stays cool (num_threads=2 in worker).
 * - Revokes played Blob URLs immediately to keep memory flat.
 */
export class SentenceTtsController {
  private sentences: TtsSentence[] = [];
  private currentIndex = 0;
  private speakerId = 45;
  private speed = 1.0;
  private playing = false;
  private generation = 0;

  private audio: HTMLAudioElement | null = null;
  private cache = new Map<number, string>();
  private synthQueue: Promise<void> = Promise.resolve();
  private inflight = new Set<number>();

  private onStateChange: (state: {
    playing: boolean;
    loading: boolean;
    index: number;
    total: number;
    sentence: TtsSentence | null;
    error: string | null;
  }) => void;

  constructor(
    onStateChange: SentenceTtsController['onStateChange']
  ) {
    this.onStateChange = onStateChange;
  }

  setSentences(sentences: TtsSentence[], startIndex = 0): void {
    this.stopPlaybackOnly();
    this.clearCache();
    this.sentences = sentences;
    this.currentIndex = Math.max(0, Math.min(startIndex, Math.max(0, sentences.length - 1)));
    this.emit(false, null);
  }

  setVoice(speakerId: number): void {
    if (this.speakerId === speakerId) return;
    this.speakerId = speakerId;
    const wasPlaying = this.playing;
    this.generation += 1;
    this.stopPlaybackOnly();
    this.clearCache();
    if (wasPlaying) {
      void this.play();
    } else {
      this.emit(false, null);
    }
  }

  setSpeed(speed: number): void {
    if (this.speed === speed) return;
    this.speed = speed;
    const wasPlaying = this.playing;
    this.generation += 1;
    this.stopPlaybackOnly();
    this.clearCache();
    if (wasPlaying) {
      void this.play();
    } else {
      this.emit(false, null);
    }
  }

  getCurrentIndex(): number {
    return this.currentIndex;
  }

  getCurrentSentence(): TtsSentence | null {
    return this.sentences[this.currentIndex] ?? null;
  }

  async play(fromIndex?: number): Promise<void> {
    if (this.sentences.length === 0) return;
    if (typeof fromIndex === 'number') {
      this.currentIndex = Math.max(0, Math.min(fromIndex, this.sentences.length - 1));
    }
    this.playing = true;
    const gen = ++this.generation;
    await this.playIndex(this.currentIndex, gen);
  }

  pause(): void {
    this.playing = false;
    this.generation += 1;
    if (this.audio) {
      this.audio.pause();
    }
    this.emit(false, null);
  }

  async next(): Promise<void> {
    if (this.currentIndex + 1 >= this.sentences.length) return;
    this.currentIndex += 1;
    if (this.playing) {
      await this.play(this.currentIndex);
    } else {
      this.emit(false, null);
    }
  }

  async prev(): Promise<void> {
    if (this.currentIndex <= 0) return;
    this.currentIndex -= 1;
    if (this.playing) {
      await this.play(this.currentIndex);
    } else {
      this.emit(false, null);
    }
  }

  dispose(): void {
    this.playing = false;
    this.generation += 1;
    this.stopPlaybackOnly();
    this.clearCache();
  }

  private stopPlaybackOnly(): void {
    if (this.audio) {
      this.audio.onended = null;
      this.audio.onerror = null;
      this.audio.pause();
      this.audio.src = '';
      this.audio = null;
    }
  }

  private clearCache(): void {
    for (const url of this.cache.values()) {
      URL.revokeObjectURL(url);
    }
    this.cache.clear();
    this.inflight.clear();
  }

  private evictBefore(keepFromIndex: number): void {
    for (const [idx, url] of this.cache.entries()) {
      if (idx < keepFromIndex) {
        URL.revokeObjectURL(url);
        this.cache.delete(idx);
      }
    }
  }

  private enqueueSynthesize(index: number, gen: number): Promise<string | null> {
    if (index < 0 || index >= this.sentences.length) return Promise.resolve(null);
    const cached = this.cache.get(index);
    if (cached) return Promise.resolve(cached);
    if (this.inflight.has(index)) {
      return this.synthQueue.then(() => this.cache.get(index) ?? null);
    }

    this.inflight.add(index);
    const sentence = this.sentences[index];
    const sid = this.speakerId;
    const speed = this.speed;

    const job = this.synthQueue
      .catch(() => {})
      .then(async () => {
        if (gen !== this.generation) return;
        if (this.cache.has(index)) return;
        const resp = await invoke<TtsSynthResponse>('tts_synthesize', {
          text: sentence.text,
          sid,
          speed,
        });
        if (gen !== this.generation) return;
        const url = base64ToWavUrl(resp.wavB64);
        this.cache.set(index, url);
      })
      .finally(() => {
        this.inflight.delete(index);
      });

    this.synthQueue = job;
    return job.then(() => (gen === this.generation ? this.cache.get(index) ?? null : null));
  }

  private prefetchAhead(fromIndex: number, gen: number): void {
    // Sliding window of 2 lookahead sentences
    for (let offset = 1; offset <= 2; offset += 1) {
      const idx = fromIndex + offset;
      if (idx < this.sentences.length && !this.cache.has(idx) && !this.inflight.has(idx)) {
        void this.enqueueSynthesize(idx, gen).catch(() => {});
      }
    }
  }

  private async playIndex(index: number, gen: number): Promise<void> {
    if (gen !== this.generation || !this.playing) return;
    if (index < 0 || index >= this.sentences.length) {
      this.playing = false;
      this.emit(false, null);
      return;
    }

    this.currentIndex = index;
    this.evictBefore(index);
    this.emit(true, null);

    let url: string | null = null;
    try {
      url = await this.enqueueSynthesize(index, gen);
    } catch (err) {
      if (gen !== this.generation) return;
      this.playing = false;
      this.emit(false, err instanceof Error ? err.message : String(err));
      return;
    }

    if (gen !== this.generation || !this.playing || !url) return;

    this.prefetchAhead(index, gen);
    this.stopPlaybackOnly();

    const audio = new Audio(url);
    this.audio = audio;
    this.emit(false, null);

    audio.onended = () => {
      if (gen !== this.generation || !this.playing) return;
      // Release played sentence audio immediately
      const playedUrl = this.cache.get(index);
      if (playedUrl) {
        URL.revokeObjectURL(playedUrl);
        this.cache.delete(index);
      }
      if (index + 1 < this.sentences.length) {
        void this.playIndex(index + 1, gen);
      } else {
        this.playing = false;
        this.emit(false, null);
      }
    };

    audio.onerror = () => {
      if (gen !== this.generation) return;
      this.playing = false;
      this.emit(false, '音频播放失败');
    };

    try {
      await audio.play();
    } catch (err) {
      if (gen !== this.generation) return;
      this.playing = false;
      this.emit(false, err instanceof Error ? err.message : '音频播放被阻止');
    }
  }

  private emit(loading: boolean, error: string | null): void {
    this.onStateChange({
      playing: this.playing,
      loading,
      index: this.currentIndex,
      total: this.sentences.length,
      sentence: this.sentences[this.currentIndex] ?? null,
      error,
    });
  }
}

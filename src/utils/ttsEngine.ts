import { invoke } from '@tauri-apps/api/core';
import type { BookParagraph } from '../types';

export interface TtsSentence {
  index: number;
  paragraphId: string;
  sentenceInParagraph: number;
  text: string;
}

export interface TtsLocator {
  paragraphId: string;
  sentenceInParagraph: number;
  voice?: string;
  speed?: number;
}

export interface TtsVoicePreset {
  id: string;
  label: string;
  lang: 'zh' | 'en';
}

/** Top 3 community-favorite female + top 3 male Edge Neural voices (ZH + Bilingual). */
export const EDGE_VOICES: TtsVoicePreset[] = [
  // 女声 Top 3
  { id: 'zh-CN-XiaoxiaoNeural', label: '女 · 晓晓（温暖自然）', lang: 'zh' },
  { id: 'zh-CN-XiaoyiNeural', label: '女 · 晓伊（柔和耐听）', lang: 'zh' },
  { id: 'en-US-AvaMultilingualNeural', label: '女 · Ava（中英双语）', lang: 'en' },
  // 男声 Top 3
  { id: 'zh-CN-YunxiNeural', label: '男 · 云希（清朗故事）', lang: 'zh' },
  { id: 'zh-CN-YunjianNeural', label: '男 · 云健（沉稳播音）', lang: 'zh' },
  { id: 'en-US-AndrewMultilingualNeural', label: '男 · Andrew（中英双语）', lang: 'en' },
];

export const DEFAULT_EDGE_VOICE = EDGE_VOICES[0].id;

const SENTENCE_SPLIT_RE = /[^。！？；.!?\n]+[。！？；.!?\n]?/g;
const TARGET_CHUNK_CHARS = 160;
const MAX_CHUNK_CHARS = 260;
const PREFETCH_AHEAD = 20;
const KEEP_BEHIND = 5;

function splitParagraphIntoChunks(raw: string): string[] {
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  if (!cleaned) return [];
  if (cleaned.length <= TARGET_CHUNK_CHARS) return [cleaned];

  const rawSentences = (cleaned.match(SENTENCE_SPLIT_RE) ?? [cleaned])
    .map((s) => s.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = '';

  for (const sent of rawSentences) {
    if (sent.length > MAX_CHUNK_CHARS) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      const subParts = sent.split(/(?<=[，,、：:])/);
      let subBuf = '';
      for (const sub of subParts) {
        if (subBuf.length + sub.length > MAX_CHUNK_CHARS && subBuf.trim()) {
          chunks.push(subBuf.trim());
          subBuf = sub;
        } else {
          subBuf += sub;
        }
      }
      if (subBuf.trim()) chunks.push(subBuf.trim());
      continue;
    }

    if (current && current.length + sent.length > TARGET_CHUNK_CHARS) {
      chunks.push(current);
      current = sent;
    } else {
      current = current ? `${current} ${sent}` : sent;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

export function buildSentencesFromParagraphs(paragraphs: BookParagraph[]): TtsSentence[] {
  const list: TtsSentence[] = [];
  for (const p of paragraphs) {
    if (p.type === 'image' || p.type === 'table') continue;
    if (p.type === 'quote' && p.lines) {
      for (const line of p.lines) {
        const parts = splitParagraphIntoChunks(line.text);
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
      const parts = splitParagraphIntoChunks(p.text);
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
      voice: typeof parsed.voice === 'string' ? parsed.voice : undefined,
      speed: typeof parsed.speed === 'number' ? parsed.speed : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Online Edge Neural TTS controller:
 * - Fetches 24kHz MP3 chunks via pure-Rust `msedge-tts` (`tts_synthesize`).
 * - Maintains a 20-chunk lookahead buffer + 5-chunk lookback cache (~1.2 MB total)
 *   for instant gapless playback and instant replay even on flaky networks.
 * - Adjusts speed (0.85x–2.5x) instantaneously on HTMLAudioElement with pitch preservation.
 */
export class SentenceTtsController {
  private sentences: TtsSentence[] = [];
  private currentIndex = 0;
  private voice = DEFAULT_EDGE_VOICE;
  private speed = 1.0;
  private playing = false;
  private generation = 0;

  private audio: HTMLAudioElement | null = null;
  private cache = new Map<number, string>();
  private inflight = new Map<number, Promise<string | null>>();
  private prefetchRunning = false;

  private onStateChange: (state: {
    playing: boolean;
    loading: boolean;
    index: number;
    total: number;
    sentence: TtsSentence | null;
    error: string | null;
  }) => void;

  constructor(onStateChange: SentenceTtsController['onStateChange']) {
    this.onStateChange = onStateChange;
  }

  setSentences(sentences: TtsSentence[], startIndex = 0): void {
    this.stopPlaybackOnly();
    this.clearCache();
    this.sentences = sentences;
    this.currentIndex = Math.max(0, Math.min(startIndex, Math.max(0, sentences.length - 1)));
    this.emit(false, null);
  }

  setVoice(voice: string): void {
    if (this.voice === voice) return;
    this.voice = voice;
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
    if (this.audio) {
      this.audio.playbackRate = speed;
      (this.audio as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = true;
    }
    this.emit(false, null);
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
    this.prefetchRunning = false;
  }

  private evictOutsideWindow(centerIndex: number): void {
    const minKeep = Math.max(0, centerIndex - KEEP_BEHIND);
    const maxKeep = centerIndex + PREFETCH_AHEAD + 2;
    for (const [idx, url] of this.cache.entries()) {
      if (idx < minKeep || idx > maxKeep) {
        URL.revokeObjectURL(url);
        this.cache.delete(idx);
      }
    }
  }

  private fetchChunk(index: number, gen: number): Promise<string | null> {
    if (index < 0 || index >= this.sentences.length) return Promise.resolve(null);
    const cached = this.cache.get(index);
    if (cached) return Promise.resolve(cached);

    const existing = this.inflight.get(index);
    if (existing) return existing;

    const sentence = this.sentences[index];
    const voice = this.voice;

    const promise = invoke<ArrayBuffer>('tts_synthesize', {
      text: sentence.text,
      voice,
    })
      .then((mp3Buffer) => {
        if (gen !== this.generation) return null;
        const url = URL.createObjectURL(new Blob([mp3Buffer], { type: 'audio/mpeg' }));
        this.cache.set(index, url);
        return url;
      })
      .finally(() => {
        if (this.inflight.get(index) === promise) {
          this.inflight.delete(index);
        }
      });

    this.inflight.set(index, promise);
    return promise;
  }

  private pumpPrefetchLoop(gen: number): void {
    if (this.prefetchRunning) return;
    this.prefetchRunning = true;

    void (async () => {
      try {
        while (gen === this.generation && this.playing) {
          let nextMissing = -1;
          const maxIdx = Math.min(
            this.sentences.length - 1,
            this.currentIndex + PREFETCH_AHEAD
          );
          for (let i = this.currentIndex + 1; i <= maxIdx; i += 1) {
            if (!this.cache.has(i) && !this.inflight.has(i)) {
              nextMissing = i;
              break;
            }
          }
          if (nextMissing === -1) break;
          try {
            await this.fetchChunk(nextMissing, gen);
          } catch {
            // Stop prefetching on transient network error; playback will retry when reached
            break;
          }
        }
      } finally {
        this.prefetchRunning = false;
      }
    })();
  }

  private async playIndex(index: number, gen: number): Promise<void> {
    if (gen !== this.generation || !this.playing) return;
    if (index < 0 || index >= this.sentences.length) {
      this.playing = false;
      this.emit(false, null);
      return;
    }

    this.currentIndex = index;
    this.evictOutsideWindow(index);
    this.emit(!this.cache.has(index), null);

    let url: string | null = null;
    try {
      url = await this.fetchChunk(index, gen);
    } catch (err) {
      if (gen !== this.generation) return;
      this.playing = false;
      this.emit(false, err instanceof Error ? err.message : String(err));
      return;
    }

    if (gen !== this.generation || !this.playing || !url) return;

    this.pumpPrefetchLoop(gen);
    this.stopPlaybackOnly();

    const audio = new Audio(url);
    audio.playbackRate = this.speed;
    (audio as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = true;
    this.audio = audio;
    this.emit(false, null);

    audio.onended = () => {
      if (gen !== this.generation || !this.playing) return;
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

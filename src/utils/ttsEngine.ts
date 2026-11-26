import { invoke } from '@tauri-apps/api/core';
import type { BookParagraph } from '../types';
import {
  buildTtsCacheKey,
  getCachedTtsBlob,
  markTtsChunkPlayed,
  pruneExpiredTtsCache,
  putCachedTtsBlob,
} from './ttsCache';

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
  name: string;
  desc: string;
  gender: 'female' | 'male';
  label: string;
  lang: 'zh' | 'en';
}

/** Top 3 community-favorite female + top 3 male Edge Neural voices (ZH + Bilingual). */
export const EDGE_VOICES: TtsVoicePreset[] = [
  // 女声 Top 3
  {
    id: 'zh-CN-XiaoxiaoNeural',
    name: '晓晓',
    desc: '温暖自然 · 通用首选',
    gender: 'female',
    label: '女 · 晓晓（温暖自然）',
    lang: 'zh',
  },
  {
    id: 'zh-CN-XiaoyiNeural',
    name: '晓伊',
    desc: '柔和耐听 · 适合长读',
    gender: 'female',
    label: '女 · 晓伊（柔和耐听）',
    lang: 'zh',
  },
  {
    id: 'en-US-AvaMultilingualNeural',
    name: 'Ava',
    desc: '中英双语 · 流畅自然',
    gender: 'female',
    label: '女 · Ava（中英双语）',
    lang: 'en',
  },
  // 男声 Top 3
  {
    id: 'zh-CN-YunxiNeural',
    name: '云希',
    desc: '清朗有声 · 叙事感强',
    gender: 'male',
    label: '男 · 云希（清朗故事）',
    lang: 'zh',
  },
  {
    id: 'zh-CN-YunjianNeural',
    name: '云健',
    desc: '沉稳磁性 · 播音质感',
    gender: 'male',
    label: '男 · 云健（沉稳播音）',
    lang: 'zh',
  },
  {
    id: 'en-US-AndrewMultilingualNeural',
    name: 'Andrew',
    desc: '中英双语 · 沉稳清晰',
    gender: 'male',
    label: '男 · Andrew（中英双语）',
    lang: 'en',
  },
];

export const DEFAULT_EDGE_VOICE = EDGE_VOICES[0].id;

const SENTENCE_SPLIT_RE = /[^。！？；.!?\n]+[。！？；.!?\n]?/g;
const TARGET_CHUNK_CHARS = 160;
const MAX_CHUNK_CHARS = 260;
const PREFETCH_AHEAD = 20;

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

interface AndroidTtsBridgeApi {
  isAvailable?: () => boolean;
  setLoading: (title: string, subtitle: string) => void;
  playAudio: (base64Mp3: string, speed: number, title: string, subtitle: string) => void;
  pause: () => void;
  resume: () => void;
  setSpeed: (speed: number) => void;
  stop: () => void;
}

type AndroidTtsEvent = 'ended' | 'play' | 'pause' | 'prev' | 'next' | 'stop' | 'error';

declare global {
  interface Window {
    AndroidTtsBridge?: AndroidTtsBridgeApi;
    __androidTtsEvent?: (event: AndroidTtsEvent) => void;
  }
}

function getAndroidTtsBridge(): AndroidTtsBridgeApi | null {
  if (typeof window === 'undefined') return null;
  const bridge = window.AndroidTtsBridge;
  if (bridge && typeof bridge.isAvailable === 'function' && bridge.isAvailable()) {
    return bridge;
  }
  return null;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const res = typeof reader.result === 'string' ? reader.result : '';
      const comma = res.indexOf(',');
      resolve(comma >= 0 ? res.slice(comma + 1) : res);
    };
    reader.onerror = () => reject(reader.error ?? new Error('音频编码失败'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Online Edge Neural TTS controller:
 * - Fetches 24kHz MP3 chunks via pure-Rust `msedge-tts` (`tts_synthesize`).
 * - Persists up to 20 lookahead chunks in IndexedDB (`ttsCache.ts`):
 *   unplayed chunks stay cached across sessions; played chunks auto-expire after 2 hours.
 * - On Android, routes audio playback through native `TtsMediaService` (MediaPlayer +
 *   Foreground Service + MediaSession + WakeLock) for lockscreen/status-bar controls and
 *   uninterrupted background/screen-off playback.
 * - On macOS/desktop, plays via HTMLAudioElement with instant pitch-preserving speed.
 */
export class SentenceTtsController {
  private bookId: string;
  private bookTitle: string;
  private sentences: TtsSentence[] = [];
  private currentIndex = 0;
  private voice = DEFAULT_EDGE_VOICE;
  private speed = 1.0;
  private playing = false;
  private generation = 0;
  private activeGen = 0;
  private nativePaused = false;

  private audio: HTMLAudioElement | null = null;
  private activeAudioUrl: string | null = null;
  private inflight = new Map<string, Promise<Blob | null>>();
  private prefetchRunning = false;
  private pruneTimer: number | null = null;

  private onStateChange: (state: {
    playing: boolean;
    loading: boolean;
    index: number;
    total: number;
    sentence: TtsSentence | null;
    error: string | null;
  }) => void;

  constructor(
    bookId: string,
    onStateChange: SentenceTtsController['onStateChange'],
    bookTitle?: string
  ) {
    this.bookId = bookId;
    this.bookTitle = bookTitle?.trim() || 'ReadingBook 听书';
    this.onStateChange = onStateChange;
    if (getAndroidTtsBridge()) {
      window.__androidTtsEvent = (event) => this.handleAndroidEvent(event);
    }
    // Prune any >2h played chunks on startup and periodically every 10 min
    void pruneExpiredTtsCache();
    this.pruneTimer = window.setInterval(() => {
      void pruneExpiredTtsCache();
    }, 10 * 60 * 1000);
  }

  setBookTitle(title: string): void {
    const trimmed = title.trim();
    if (trimmed) this.bookTitle = trimmed;
  }

  setSentences(sentences: TtsSentence[], startIndex = 0): void {
    this.stopPlaybackOnly();
    this.nativePaused = false;
    this.inflight.clear();
    this.prefetchRunning = false;
    this.sentences = sentences;
    this.currentIndex = Math.max(0, Math.min(startIndex, Math.max(0, sentences.length - 1)));
    this.emit(false, null);
  }

  setVoice(voice: string): void {
    if (this.voice === voice) return;
    this.voice = voice;
    const wasPlaying = this.playing;
    this.generation += 1;
    this.nativePaused = false;
    this.stopPlaybackOnly();
    this.inflight.clear();
    this.prefetchRunning = false;
    if (wasPlaying) {
      void this.play();
    } else {
      this.emit(false, null);
    }
  }

  setSpeed(speed: number): void {
    if (this.speed === speed) return;
    this.speed = speed;
    const bridge = getAndroidTtsBridge();
    if (bridge) {
      bridge.setSpeed(speed);
    } else if (this.audio) {
      this.audio.playbackRate = speed;
      (this.audio as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = true;
    }
    this.emit(false, null);
  }

  async play(fromIndex?: number): Promise<void> {
    if (this.sentences.length === 0) return;
    const bridge = getAndroidTtsBridge();
    if (bridge && fromIndex === undefined && this.nativePaused && !this.playing) {
      this.playing = true;
      this.nativePaused = false;
      bridge.resume();
      this.emit(false, null);
      return;
    }
    if (typeof fromIndex === 'number') {
      this.currentIndex = Math.max(0, Math.min(fromIndex, this.sentences.length - 1));
    }
    this.nativePaused = false;
    this.playing = true;
    const gen = ++this.generation;
    this.activeGen = gen;
    await this.playIndex(this.currentIndex, gen);
  }

  pause(): void {
    const bridge = getAndroidTtsBridge();
    if (bridge) {
      this.playing = false;
      this.nativePaused = true;
      bridge.pause();
      this.emit(false, null);
      return;
    }
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
    this.nativePaused = false;
    if (this.playing) {
      await this.play(this.currentIndex);
    } else {
      this.emit(false, null);
    }
  }

  async prev(): Promise<void> {
    if (this.currentIndex <= 0) return;
    this.currentIndex -= 1;
    this.nativePaused = false;
    if (this.playing) {
      await this.play(this.currentIndex);
    } else {
      this.emit(false, null);
    }
  }

  dispose(): void {
    this.playing = false;
    this.nativePaused = false;
    this.generation += 1;
    const bridge = getAndroidTtsBridge();
    if (bridge) {
      bridge.stop();
      if (window.__androidTtsEvent) {
        window.__androidTtsEvent = undefined;
      }
    }
    this.stopPlaybackOnly();
    this.inflight.clear();
    this.prefetchRunning = false;
    if (this.pruneTimer !== null) {
      window.clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
  }

  private buildSubtitle(sentence: TtsSentence | null): string {
    const total = this.sentences.length;
    const pct = total > 0 ? Math.round(((this.currentIndex + 1) / total) * 100) : 0;
    const prefix = total > 0 ? `${this.currentIndex + 1}/${total} (${pct}%)` : '';
    const snippet = sentence?.text?.trim().slice(0, 64) ?? '';
    return prefix && snippet ? `${prefix} · ${snippet}` : snippet || prefix || '正在朗读';
  }

  private handleAndroidEvent(event: AndroidTtsEvent): void {
    switch (event) {
      case 'ended': {
        if (!this.playing) return;
        const current = this.sentences[this.currentIndex];
        if (current) {
          const cacheKey = this.keyFor(current);
          void markTtsChunkPlayed(cacheKey).then(() => pruneExpiredTtsCache());
        }
        if (this.currentIndex + 1 < this.sentences.length) {
          void this.playIndex(this.currentIndex + 1, this.activeGen);
        } else {
          this.playing = false;
          this.nativePaused = false;
          getAndroidTtsBridge()?.stop();
          this.emit(false, null);
        }
        break;
      }
      case 'pause': {
        this.playing = false;
        this.nativePaused = true;
        this.emit(false, null);
        break;
      }
      case 'play': {
        if (this.playing) return;
        if (this.nativePaused) {
          this.playing = true;
          this.nativePaused = false;
          this.emit(false, null);
        } else {
          void this.play();
        }
        break;
      }
      case 'next': {
        if (this.currentIndex + 1 < this.sentences.length) {
          this.nativePaused = false;
          void this.play(this.currentIndex + 1);
        }
        break;
      }
      case 'prev': {
        if (this.currentIndex > 0) {
          this.nativePaused = false;
          void this.play(this.currentIndex - 1);
        }
        break;
      }
      case 'stop': {
        this.playing = false;
        this.nativePaused = false;
        this.generation += 1;
        this.emit(false, null);
        break;
      }
      case 'error': {
        this.playing = false;
        this.nativePaused = false;
        this.emit(false, '音频播放失败');
        break;
      }
    }
  }

  private stopPlaybackOnly(): void {
    if (this.audio) {
      this.audio.onended = null;
      this.audio.onerror = null;
      this.audio.pause();
      this.audio.src = '';
      this.audio = null;
    }
    if (this.activeAudioUrl) {
      URL.revokeObjectURL(this.activeAudioUrl);
      this.activeAudioUrl = null;
    }
  }

  private keyFor(sentence: TtsSentence): string {
    return buildTtsCacheKey(
      this.bookId,
      this.voice,
      sentence.paragraphId,
      sentence.sentenceInParagraph
    );
  }

  private async ensureChunkBlob(index: number, gen: number): Promise<Blob | null> {
    if (index < 0 || index >= this.sentences.length) return null;
    const sentence = this.sentences[index];
    const key = this.keyFor(sentence);

    const cached = await getCachedTtsBlob(key);
    if (cached) return cached;

    const existing = this.inflight.get(key);
    if (existing) return existing;

    const voice = this.voice;
    const bookId = this.bookId;

    const promise = invoke<ArrayBuffer>('tts_synthesize', {
      text: sentence.text,
      voice,
    })
      .then(async (mp3Buffer) => {
        const blob = new Blob([mp3Buffer], { type: 'audio/mpeg' });
        await putCachedTtsBlob(key, bookId, voice, blob);
        return gen === this.generation ? blob : null;
      })
      .finally(() => {
        if (this.inflight.get(key) === promise) {
          this.inflight.delete(key);
        }
      });

    this.inflight.set(key, promise);
    return promise;
  }

  private pumpPrefetchLoop(gen: number): void {
    if (this.prefetchRunning) return;
    this.prefetchRunning = true;

    void (async () => {
      try {
        while (gen === this.generation && this.playing) {
          const maxIdx = Math.min(
            this.sentences.length - 1,
            this.currentIndex + PREFETCH_AHEAD
          );
          let nextMissing = -1;
          for (let i = this.currentIndex + 1; i <= maxIdx; i += 1) {
            const key = this.keyFor(this.sentences[i]);
            if (this.inflight.has(key)) continue;
            const hit = await getCachedTtsBlob(key);
            if (!hit) {
              nextMissing = i;
              break;
            }
          }
          if (nextMissing === -1) break;
          try {
            await this.ensureChunkBlob(nextMissing, gen);
          } catch {
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
    const sentence = this.sentences[index];
    const cacheKey = this.keyFor(sentence);
    const bridge = getAndroidTtsBridge();

    if (bridge) {
      bridge.setLoading(this.bookTitle, this.buildSubtitle(sentence));
    }
    this.emit(true, null);

    let blob: Blob | null = null;
    try {
      blob = await this.ensureChunkBlob(index, gen);
    } catch (err) {
      if (gen !== this.generation) return;
      this.playing = false;
      bridge?.pause();
      this.emit(false, err instanceof Error ? err.message : String(err));
      return;
    }

    if (gen !== this.generation || !this.playing || !blob) return;

    this.pumpPrefetchLoop(gen);

    if (bridge) {
      try {
        const base64 = await blobToBase64(blob);
        if (gen !== this.generation || !this.playing) return;
        bridge.playAudio(base64, this.speed, this.bookTitle, this.buildSubtitle(sentence));
        this.emit(false, null);
      } catch (err) {
        if (gen !== this.generation) return;
        this.playing = false;
        this.emit(false, err instanceof Error ? err.message : '音频解码失败');
      }
      return;
    }

    this.stopPlaybackOnly();

    const url = URL.createObjectURL(blob);
    this.activeAudioUrl = url;

    const audio = new Audio(url);
    audio.playbackRate = this.speed;
    (audio as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = true;
    this.audio = audio;
    this.emit(false, null);

    audio.onended = () => {
      if (gen !== this.generation || !this.playing) return;
      // Stamp playedAt so this chunk auto-deletes 2 hours after playback;
      // unplayed prefetched chunks remain untouched.
      void markTtsChunkPlayed(cacheKey).then(() => pruneExpiredTtsCache());
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

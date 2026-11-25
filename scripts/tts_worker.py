#!/usr/bin/env python3
"""
Resident offline TTS worker for ReadingBook using sherpa-onnx (Kokoro v1.1-zh int8).

Protocol (JSON Lines over stdin/stdout):
  Request : {"id": 1, "text": "Hello 世界", "sid": 45, "speed": 1.0}
  Response: {"id": 1, "ok": true, "sample_rate": 24000, "wav_b64": "..."}
         or {"id": 1, "ok": false, "error": "..."}
"""

from __future__ import annotations

import base64
import io
import json
import math
import os
import struct
import sys
import wave
from pathlib import Path


def encode_wav_pcm16(samples, sample_rate: int) -> bytes:
    """Sanitize NaN/Inf samples and encode float [-1, 1] samples into 16-bit PCM WAV."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(int(sample_rate))
        pcm = bytearray(len(samples) * 2)
        pack_into = struct.pack_into
        for i, s in enumerate(samples):
            v = float(s)
            if not math.isfinite(v):
                v = 0.0
            elif v > 1.0:
                v = 1.0
            elif v < -1.0:
                v = -1.0
            pack_into("<h", pcm, i * 2, int(v * 32767.0))
        wf.writeframes(pcm)
    return buf.getvalue()


def build_tts(model_dir: Path, num_threads: int = 2):
    import sherpa_onnx  # type: ignore

    model_onnx = model_dir / "model.int8.onnx"
    if not model_onnx.is_file():
        model_onnx = model_dir / "model.onnx"
    if not model_onnx.is_file():
        raise FileNotFoundError(f"Kokoro ONNX model not found in {model_dir}")

    voices = model_dir / "voices.bin"
    tokens = model_dir / "tokens.txt"
    data_dir = model_dir / "espeak-ng-data"
    dict_dir = model_dir / "dict"

    lexicons = sorted(str(p) for p in model_dir.glob("lexicon*.txt"))
    rule_fsts = sorted(str(p) for p in model_dir.glob("*.fst"))

    kokoro_cfg = sherpa_onnx.OfflineTtsKokoroModelConfig(
        model=str(model_onnx),
        voices=str(voices),
        tokens=str(tokens),
        data_dir=str(data_dir) if data_dir.is_dir() else "",
        dict_dir=str(dict_dir) if dict_dir.is_dir() else "",
        lexicon=",".join(lexicons),
    )

    model_cfg = sherpa_onnx.OfflineTtsModelConfig(
        kokoro=kokoro_cfg,
        num_threads=max(1, num_threads),
        debug=False,
        provider="cpu",
    )

    tts_cfg = sherpa_onnx.OfflineTtsConfig(
        model=model_cfg,
        rule_fsts=",".join(rule_fsts),
        max_num_sentences=1,
    )

    if not tts_cfg.validate():
        raise RuntimeError("Invalid sherpa-onnx OfflineTtsConfig for Kokoro model")

    return sherpa_onnx.OfflineTts(tts_cfg)


def main() -> int:
    if len(sys.argv) < 2:
        print(json.dumps({"ready": False, "error": "missing model_dir"}), flush=True)
        return 1

    model_dir = Path(sys.argv[1])
    num_threads = int(sys.argv[2]) if len(sys.argv) >= 3 else 2

    try:
        tts = build_tts(model_dir, num_threads=num_threads)
    except Exception as exc:
        print(json.dumps({"ready": False, "error": str(exc)}), flush=True)
        return 1

    print(
        json.dumps(
            {
                "ready": True,
                "num_speakers": getattr(tts, "num_speakers", 103),
                "sample_rate": getattr(tts, "sample_rate", 24000),
            }
        ),
        flush=True,
    )

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            if req.get("cmd") == "quit":
                break
            req_id = req.get("id")
            text = str(req.get("text", "")).strip()
            sid = int(req.get("sid", 45))
            speed = float(req.get("speed", 1.0))
            speed = max(0.5, min(2.0, speed))

            if not text:
                print(
                    json.dumps({"id": req_id, "ok": False, "error": "empty text"}),
                    flush=True,
                )
                continue

            audio = tts.generate(text, sid=sid, speed=speed)
            wav_bytes = encode_wav_pcm16(audio.samples, audio.sample_rate)
            wav_b64 = base64.b64encode(wav_bytes).decode("ascii")
            print(
                json.dumps(
                    {
                        "id": req_id,
                        "ok": True,
                        "sample_rate": audio.sample_rate,
                        "wav_b64": wav_b64,
                    }
                ),
                flush=True,
            )
        except Exception as exc:
            print(
                json.dumps({"id": req_id, "ok": False, "error": str(exc)}),
                flush=True,
            )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

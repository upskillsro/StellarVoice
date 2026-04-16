"""
AI Voice Agent Backend - FastAPI WebSocket Server
- ASR:  NVIDIA Parakeet-TDT-0.6B-v3  (graceful fallback if unavailable)
- LLM:  Ollama gemma4:3b via /api/chat
- TTS:  Kokoro (local, graceful fallback if unavailable)
"""

import asyncio
import io
import logging
import os
import re
import tempfile
import traceback
import struct
import wave
import httpx
from contextlib import asynccontextmanager

import numpy as np
import requests
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

class ModelSelect(BaseModel):
    model: str

class ASRSelect(BaseModel):
    engine: str
    model: str = "base"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
OLLAMA_URL   = "http://localhost:11434/api/chat"
OLLAMA_MODEL = "gemma4:3b"

SAMPLE_RATE_IN  = 16000   # Parakeet expects 16 kHz mono
SAMPLE_RATE_OUT = 24000   # Kokoro output rate

SYSTEM_PROMPT = (
    "You are a helpful, conversational voice assistant. "
    "Respond in plain natural language with no markdown, bullets, or emojis. "
    "Keep answers short — two to four sentences max."
)

# ---------------------------------------------------------------------------
# ASR Engine Registry & Pool
# ---------------------------------------------------------------------------
active_asr = None
asr_config = {"engine": "whisper", "model": "base"}
_ASR_POOL  = {}

class ASREngine:
    def transcribe(self, pcm_bytes: bytes, sample_rate: int) -> str:
        raise NotImplementedError

class WhisperEngine(ASREngine):
    def __init__(self, model_size="base"):
        import whisper
        import torch
        device = "cuda" if torch.cuda.is_available() else "cpu"
        logger.info(f"Loading Whisper ASR ({model_size}) on {device}...")
        self.model = whisper.load_model(model_size, device=device)
        self.model_size = model_size

    def transcribe(self, pcm_bytes: bytes, sample_rate: int) -> str:
        from scipy.signal import resample_poly
        audio_np = np.frombuffer(pcm_bytes, dtype=np.float32).copy()
        if audio_np.size == 0: return ""
        if sample_rate != 16000:
            from math import gcd
            g = gcd(16000, sample_rate)
            audio_np = resample_poly(audio_np, 16000 // g, sample_rate // g).astype(np.float32)
        
        result = self.model.transcribe(audio_np, fp16=(self.model.device.type == "cuda"))
        return result["text"].strip()

class MoonshineEngine(ASREngine):
    def __init__(self):
        from moonshine_voice import Moonshine
        logger.info("Loading Moonshine ASR (base)...")
        self.model = Moonshine()

    def transcribe(self, pcm_bytes: bytes, sample_rate: int) -> str:
        audio_np = np.frombuffer(pcm_bytes, dtype=np.float32).copy()
        if audio_np.size == 0: return ""
        # Moonshine expects [1, N] array
        result = self.model.transcribe(audio_np[None, :])
        return result[0].strip()

def load_asr():
    global active_asr, _ASR_POOL
    try:
        engine = WhisperEngine(asr_config["model"])
        key = f"whisper:{asr_config['model']}"
        _ASR_POOL[key] = engine
        active_asr = engine
    except Exception:
        logger.error(f"Failed to load default ASR: {traceback.format_exc()}")


# ---------------------------------------------------------------------------
# Load TTS (Kokoro ONNX) — completely bypasses C++ build tools
# ---------------------------------------------------------------------------
def load_tts():
    global tts_pipeline
    try:
        from kokoro_onnx import Kokoro  # type: ignore
        import numpy as np
        logger.info("Loading Kokoro ONNX TTS …")
        # Monkey patch numpy to allow picking (security default since 1.25 blocks kokoro-onnx 0.5 loading voices)
        _old_load = np.load
        np.load = lambda *a, **k: _old_load(*a, allow_pickle=True, **k)
        tts_pipeline = Kokoro("kokoro-v1.0.onnx", "voices-v1.0.bin")
        np.load = _old_load
        logger.info("✅ Kokoro ONNX TTS loaded")
    except Exception:
        logger.warning("⚠️  Kokoro ONNX not available — TTS will be skipped.\n" + traceback.format_exc())


# ---------------------------------------------------------------------------
# Lifespan (replaces deprecated @app.on_event)
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, load_asr)
    await loop.run_in_executor(None, load_tts)
    yield   # server runs here
    logger.info("Shutting down.")


app = FastAPI(title="AI Voice Agent", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def transcribe(pcm_bytes: bytes, sample_rate: int = SAMPLE_RATE_IN) -> str:
    if active_asr is None:
        return ""
    try:
        return active_asr.transcribe(pcm_bytes, sample_rate)
    except Exception as e:
        logger.error(f"Transcription error: {e}")
        return ""


# ---------------------------------------------------------------------------
# Query Ollama via /api/chat  (proper message format)
# ---------------------------------------------------------------------------
async def query_llm_stream(user_text: str, history: list[dict]):
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    messages.extend(history)
    messages.append({"role": "user", "content": user_text})

    import json
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            async with client.stream(
                "POST",
                OLLAMA_URL,
                json={
                    "model": OLLAMA_MODEL,
                    "messages": messages,
                    "stream": True,
                    "options": {"temperature": 0.7, "num_predict": 300, "think": False},
                }
            ) as resp:
                resp.raise_for_status()

                buffer = ""
                in_think = False
                
                async for line in resp.aiter_lines():
                    if line:
                        data = json.loads(line)
                        chunk = data.get("message", {}).get("content", "")
                        
                        for char in chunk:
                            buffer += char
                            
                            if "<think>" in buffer:
                                in_think = True
                                buffer = buffer.replace("<think>", "")
                            
                            if "</think>" in buffer:
                                in_think = False
                                buffer = buffer.split("</think>")[-1]
                                
                            # Yield on sentence boundaries (reduced from 10 to 3 for fast start)
                            if not in_think and len(buffer) > 3 and (buffer.endswith('. ') or buffer.endswith('! ') or buffer.endswith('? ') or buffer.endswith('\n')):
                                clean_s = buffer.strip()
                                if clean_s:
                                    yield clean_s
                                buffer = ""
                                
                            # Fallback: if buffer is very long and has a comma, yield it anyway to avoid silence
                            if not in_think and len(buffer) > 40 and buffer.endswith(', '):
                                clean_s = buffer.strip()
                                if clean_s:
                                    yield clean_s
                                buffer = ""
                                
                if not in_think and buffer.strip():
                    yield buffer.strip()

    except Exception as e:
        logger.error(f"Ollama error: {e}")
        yield "Sorry, I couldn't reach the language model right now."


# ---------------------------------------------------------------------------
# Synthesize text → WAV bytes  (kokoro with ONNX)
# ---------------------------------------------------------------------------
def synthesize(text: str) -> bytes:
    if tts_pipeline is None:
        return b""

    try:
        # returns array of floats, and sample_rate (24000)
        samples, sample_rate = tts_pipeline.create(text, voice="af_heart", speed=1.0, lang="en-us")
        audio_np = np.asarray(samples, dtype=np.float32).flatten()
    except Exception:
        logger.error("TTS error:\n" + traceback.format_exc())
        return b""

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        pcm16 = (audio_np * 32767).clip(-32768, 32767).astype(np.int16)
        wf.writeframes(pcm16.tobytes())

    return buf.getvalue()


# ---------------------------------------------------------------------------
# WebSocket endpoint
# ---------------------------------------------------------------------------
@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    logger.info("🔌 Client connected")

    history: list[dict] = []
    loop = asyncio.get_running_loop()

    try:
        while True:
            raw = await ws.receive_bytes()

            if len(raw) < 4:
                continue

            sample_rate = struct.unpack_from("<I", raw, 0)[0]
            pcm_bytes   = raw[4:]

            # ── Step 1: Transcribe ──────────────────────────────────────
            await ws.send_json({"event": "status", "state": "transcribing"})
            transcript = await loop.run_in_executor(None, transcribe, pcm_bytes, sample_rate)
            logger.info(f"Transcript: {transcript!r}")

            if not transcript:
                await ws.send_json({"event": "status", "state": "idle"})
                continue

            # CRITICAL: Always push transcript to UI immediately so user sees we moved on
            await ws.send_json({"event": "transcript", "text": transcript})

            # ── Step 2 & 3: LLM Streaming + TTS ─────────────────────────
            await ws.send_json({"event": "status", "state": "thinking"})
            
            full_reply = ""
            first_chunk = True
            
            # Start streaming from Ollama (Asynchronously)
            async for chunk_text in query_llm_stream(transcript, history):
                if first_chunk:
                    await ws.send_json({"event": "status", "state": "speaking"})
                    first_chunk = False
                
                logger.info(f"Chunk to TTS: {chunk_text!r}")
                full_reply += " " + chunk_text
                
                # Send text partial to UI
                await ws.send_json({"event": "reply", "text": chunk_text})
                
                # Synthesize this specific chunk
                wav_bytes = await loop.run_in_executor(None, synthesize, chunk_text)
                if wav_bytes:
                    await ws.send_bytes(b"AUDIO" + wav_bytes)

            full_reply = full_reply.strip()
            history.append({"role": "user",      "content": transcript})
            history.append({"role": "assistant",  "content": full_reply})
            if len(history) > 20:
                history = history[-20:]

            await ws.send_json({"event": "status", "state": "idle"})


    except WebSocketDisconnect:
        logger.info("🔌 Client disconnected")
    except Exception:
        logger.error("WebSocket error:\n" + traceback.format_exc())
        try:
            await ws.send_json({"event": "error", "message": "Internal server error."})
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Health check endpoint
# ---------------------------------------------------------------------------
@app.get("/health")
async def health():
    llm_status = "unavailable"
    try:
        # Ping local Ollama to ensure it's alive and running
        r = requests.get("http://localhost:11434/api/tags", timeout=1)
        if r.status_code == 200:
            llm_status = "loaded"
    except Exception:
        pass

    return {
        "status": "ok",
        "asr":  asr_config["engine"] + ":" + asr_config["model"] if active_asr else "unavailable",
        "tts":  "loaded" if tts_pipeline is not None else "unavailable",
        "llm":  llm_status
    }

@app.post("/set_asr")
async def set_asr(req: ASRSelect):
    global active_asr, asr_config, _ASR_POOL
    try:
        key = f"{req.engine}:{req.model}"
        
        # Check cache first for instant switching
        if key in _ASR_POOL:
            active_asr = _ASR_POOL[key]
            logger.info(f"Switched to cached ASR: {key}")
        else:
            # Load in background thread to avoid blocking FastAPI (re-indexes, health checks)
            def init_engine():
                if req.engine == "whisper":
                    return WhisperEngine(req.model)
                elif req.engine == "moonshine":
                    return MoonshineEngine()
                return None

            new_engine = await asyncio.to_thread(init_engine)
            if new_engine:
                _ASR_POOL[key] = new_engine
                active_asr = new_engine
                logger.info(f"Loaded and cached new ASR: {key}")

        asr_config = {"engine": req.engine, "model": req.model}
        return {"status": "ok", "asr": asr_config}
    except Exception as e:
        logger.error(f"Set ASR error: {e}")
        return {"status": "error", "message": str(e)}

@app.get("/asr_models")
async def get_asr_models():
    return {
        "engines": ["whisper", "moonshine"],
        "whisper_models": ["tiny", "base", "small"]
    }

@app.post("/set_model")
async def set_model(req: ModelSelect):
    global OLLAMA_MODEL
    OLLAMA_MODEL = req.model
    logger.info(f"Ollama model changed to: {OLLAMA_MODEL}")
    return {"status": "ok", "model": OLLAMA_MODEL}

@app.get("/models")
async def get_models():
    try:
        r = requests.get("http://localhost:11434/api/tags", timeout=2)
        if r.status_code == 200:
            return {"models": [m["name"] for m in r.json().get("models", [])]}
    except Exception:
        pass
    return {"models": [OLLAMA_MODEL]}

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8765, log_level="info")

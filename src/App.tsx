import React, { Suspense, useEffect, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Environment } from '@react-three/drei';
import { motion, AnimatePresence } from 'framer-motion';
import { Mic, Square, PhoneOff, Wifi, WifiOff, Sparkles } from 'lucide-react';
import { useVoiceAgent } from './hooks/useVoiceAgent';
import type { AgentState } from './hooks/useVoiceAgent';
import { DotSphere } from './components/DotSphere';

// ─── State label / color helpers ────────────────────────────────────────
const STATE_LABELS: Record<AgentState, string> = {
  idle:          'Ready',
  listening:     'Listening…',
  transcribing:  'Transcribing…',
  thinking:      'Thinking…',
  speaking:      'Speaking…',
};

const STATE_DOT_COLORS: Record<AgentState, string> = {
  idle:          'bg-zinc-500',
  listening:     'bg-emerald-400',
  transcribing:  'bg-yellow-400',
  thinking:      'bg-sky-400',
  speaking:      'bg-violet-400',
};

const STATE_SPHERE_COLORS: Record<AgentState, string> = {
  idle:          '#6366f1',
  listening:     '#34d399',
  transcribing:  '#facc15',
  thinking:      '#38bdf8',
  speaking:      '#a78bfa',
};

function App() {
  const {
    agentState,
    transcript,
    liveTranscript,
    reply,
    error,
    isConnected,
    analyserNode,
    startListening,
    stopListening,
    connect,
    disconnect,
  } = useVoiceAgent();

  const [engines, setEngines] = useState({ asr: 'checking', tts: 'checking', llm: 'checking' });
  const [availableModels, setAvailableModels] = useState<string[]>(['gemma4:e4b']);
  const [activeModel, setActiveModel] = useState<string>('gemma4:e4b');
  
  const [asrData, setAsrData] = useState<{ engines: string[], whisper_models: string[] }>({ engines: [], whisper_models: [] });
  const [activeAsr, setActiveAsr] = useState({ engine: 'whisper', model: 'base' });
  
  useEffect(() => {
    const fetchModels = async () => {
      try {
        const r1 = await fetch('http://127.0.0.1:8765/models');
        if (r1.ok) {
           const d = await r1.json();
           if (d.models) setAvailableModels(d.models);
        }
        
        const r2 = await fetch('http://127.0.0.1:8765/asr_models');
        if (r2.ok) {
           const d = await r2.json();
           setAsrData(d);
        }
      } catch (e) {}
    };
    fetchModels();

    const failCount = { current: 0 };
    const checkH = async () => {
      try {
        const res = await fetch('http://127.0.0.1:8765/health', { signal: AbortSignal.timeout(2000) });
        if (res.ok) {
           const d = await res.json();
           setEngines({ asr: d.asr, tts: d.tts, llm: d.llm });
           failCount.current = 0;
        } else { throw new Error(); }
      } catch (e) {
        failCount.current++;
        if (failCount.current > 2) {
          setEngines({ asr: 'offline', tts: 'offline', llm: 'offline' });
        }
      }
    };
    checkH();
    const iv = setInterval(checkH, 3000);
    return () => clearInterval(iv);
  }, []);

  const isActive = agentState !== 'idle';
  const isListening = agentState === 'listening';

  return (
    <div className="relative w-full h-screen bg-[#050505] overflow-hidden flex flex-col font-sans text-white select-none">

      {/* ── 3-D Canvas ───────────────────────────────── */}
      <div className="absolute inset-0 z-0">
        <Canvas camera={{ position: [0, 0, 7], fov: 45 }}>
          <color attach="background" args={['#050505']} />
          <ambientLight intensity={0.4} />
          <Suspense fallback={null}>
            <DotSphere analyserNode={analyserNode} />
            <Environment preset="night" />
          </Suspense>
          <OrbitControls enableZoom={false} enablePan={false} autoRotate autoRotateSpeed={0.2} />
        </Canvas>
      </div>

      {/* ── UI Layer ─────────────────────────────────── */}
      <div className="relative z-10 flex flex-col h-full pointer-events-none">

        {/* Header */}
        <header className="flex justify-between items-center px-8 pt-8 w-full">
          <motion.div
            initial={{ opacity: 0, y: -16 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex items-center gap-2"
          >
            <Sparkles className="w-5 h-5 text-indigo-400" />
            <h1 className="text-xl font-medium tracking-wide">
              Antigravity<span className="font-light text-zinc-500">Voice</span>
            </h1>
          </motion.div>

          {/* Top Right Container */}
          <div className="flex flex-col items-end gap-3 pointer-events-auto">
            {/* Engine Status Indicators */}
            <div className="flex gap-4 px-2">
              {[
                { name: 'ASR', status: engines.asr },
                { name: 'Ollama', status: engines.llm },
                { name: 'Kokoro', status: engines.tts }
              ].map((engine) => (
                <div key={engine.name} className="flex items-center gap-1.5 text-xs text-zinc-500 uppercase tracking-widest font-semibold flex-row-reverse" title={engine.status}>
                  <div className={`w-1.5 h-1.5 rounded-full ${(!['offline', 'unavailable', 'checking'].includes(engine.status)) ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.5)]' : 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.5)]'}`} />
                  {engine.name}
                </div>
              ))}
            </div>

            {/* Actions Row */}
            <div className="flex items-center gap-3">
              {/* ASR Dropdown */}
              <select
                title="ASR Engine"
                className="bg-zinc-900/40 text-violet-300 text-[10px] tracking-wider uppercase border border-violet-400/10 rounded-full px-3 py-1.5 focus:outline-none backdrop-blur-sm hover:border-violet-400/30 transition-colors cursor-pointer"
                value={activeAsr.engine === 'whisper' ? `whisper:${activeAsr.model}` : activeAsr.engine}
                onChange={async (e) => {
                  const val = e.target.value;
                  let newAsr = { engine: val, model: 'base' };
                  if (val.startsWith('whisper:')) {
                    newAsr = { engine: 'whisper', model: val.split(':')[1] };
                  }
                  setActiveAsr(newAsr);
                  await fetch('http://127.0.0.1:8765/set_asr', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(newAsr)
                  });
                }}
              >
                <optgroup label="Whisper (GPU)" className="bg-zinc-900 normal-case">
                  {asrData.whisper_models.map(m => <option key={m} value={`whisper:${m}`}>Whisper {m}</option>)}
                </optgroup>
                <optgroup label="Real-time" className="bg-zinc-900 normal-case">
                  {asrData.engines.filter(e => e !== 'whisper').map(e => <option key={e} value={e}>{e}</option>)}
                </optgroup>
              </select>

              {/* LLM Dropdown */}
              <select
                title="Select Ollama Model"
                className="bg-zinc-900/40 text-emerald-300 text-[10px] tracking-wider uppercase border border-emerald-400/10 rounded-full px-3 py-1.5 focus:outline-none backdrop-blur-sm hover:border-emerald-400/30 transition-colors cursor-pointer"
                value={activeModel}
                onChange={async (e) => {
                  const m = e.target.value;
                  setActiveModel(m);
                  await fetch('http://127.0.0.1:8765/set_model', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ model: m })
                  });
                }}
              >
                {availableModels.map(name => <option key={name} value={name} className="bg-zinc-900 normal-case">{name}</option>)}
              </select>

              {/* Connection pill */}
              <AnimatePresence mode="wait">
                {isConnected ? (
                  <motion.div
                    key="connected"
                    initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.8 }}
                    className="flex items-center gap-2 bg-white/8 backdrop-blur-md px-4 py-1.5 rounded-full border border-white/5 cursor-default"
                  >
                    <div className={`w-2 h-2 rounded-full ${STATE_DOT_COLORS[agentState]} transition-colors duration-300 ${agentState !== 'idle' ? 'animate-pulse' : ''}`} />
                    <span className="text-sm font-medium text-zinc-300">{STATE_LABELS[agentState]}</span>
                  </motion.div>
                ) : (
                  <motion.button
                    key="disconnected"
                    initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.8 }}
                    onClick={connect}
                    className="flex items-center gap-2 bg-red-500/10 hover:bg-red-500/20 backdrop-blur-md px-4 py-1.5 rounded-full border border-red-500/20 cursor-pointer transition-colors"
                  >
                    <WifiOff className="w-4 h-4 text-red-400" />
                    <span className="text-sm font-medium text-red-400">Connect backend</span>
                  </motion.button>
                )}
              </AnimatePresence>
            </div>
          </div>
        </header>

        {/* Centre text stack */}
        <div className="flex-1 flex flex-col items-center justify-end pb-8 z-20 pointer-events-none">
          <div className="flex flex-col items-center gap-1 mb-4">
            {/* User Transcript (Static smaller line) */}
            <AnimatePresence mode="popLayout">
              {transcript && (
                <motion.div
                  key={'t-' + transcript}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 0.5, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="max-w-md text-center px-6"
                >
                  <p className="text-xs text-zinc-400 font-light italic line-clamp-1 italic">
                    "{transcript}"
                  </p>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Live Preview (During speaking) */}
            <AnimatePresence mode="wait">
              {liveTranscript && agentState === 'listening' && (
                <motion.div
                  key="live-transcript"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 0.8 }}
                  exit={{ opacity: 0 }}
                  className="max-w-md text-center px-6"
                >
                  <p className="text-sm text-emerald-400/60 font-light italic line-clamp-1">
                    "{liveTranscript}"
                  </p>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Assistant Reply (Main focus) */}
            <AnimatePresence mode="popLayout">
              {reply && (agentState === 'speaking' || agentState === 'idle') && (
                <motion.div
                  key={'r-' + reply}
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0 }}
                  className="max-w-lg text-center px-6 mt-1"
                >
                  <p className="text-base text-white font-light leading-relaxed line-clamp-2">
                    {reply}
                  </p>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {error && (
            <div className="mt-4 max-w-sm text-center text-red-400 text-xs bg-red-400/5 px-4 py-2 rounded-full border border-red-500/10">
              {error}
            </div>
          )}
        </div>

        {/* Bottom controls */}
        <div className="pb-12 flex justify-center items-center gap-6 pointer-events-auto">

          {/* Disconnect */}
          <button
            onClick={disconnect}
            disabled={!isConnected}
            className="w-14 h-14 rounded-full bg-white/8 hover:bg-white/15 backdrop-blur-md flex items-center justify-center transition-all border border-white/5 disabled:opacity-30"
          >
            <PhoneOff className="w-6 h-6 text-zinc-300" />
          </button>

          {/* Main mic button */}
          {!isConnected ? (
            <button
              onClick={connect}
              className="w-24 h-24 rounded-full bg-white text-black font-medium flex items-center justify-center transition-all shadow-[0_0_40px_rgba(255,255,255,0.15)] hover:shadow-[0_0_60px_rgba(255,255,255,0.25)] active:scale-95"
            >
              <Wifi className="w-8 h-8" />
            </button>
          ) : isListening ? (
            <button
              onClick={stopListening}
              className="w-24 h-24 rounded-full bg-emerald-500 flex items-center justify-center transition-all shadow-[0_0_40px_rgba(52,211,153,0.4)] hover:shadow-[0_0_60px_rgba(52,211,153,0.6)] active:scale-95"
            >
              <Square className="w-8 h-8 text-white fill-white" />
            </button>
          ) : (
            <button
              onClick={startListening}
              disabled={agentState !== 'idle'}
              className="w-24 h-24 rounded-full bg-white flex items-center justify-center transition-all shadow-[0_0_40px_rgba(255,255,255,0.15)] hover:shadow-[0_0_60px_rgba(255,255,255,0.25)] active:scale-95 disabled:opacity-40 disabled:scale-100 disabled:cursor-not-allowed"
            >
              <Mic className="w-8 h-8 text-black" />
            </button>
          )}

          {/* Spacer matching left button */}
          <div className="w-14 h-14" />
        </div>

      </div>
    </div>
  );
}

export default App;

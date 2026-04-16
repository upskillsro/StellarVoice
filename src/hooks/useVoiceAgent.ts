import { useRef, useState, useCallback, useEffect } from 'react';

export type AgentState = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking';

interface AgentEvent {
  event: string;
  state?: AgentState;
  text?: string;
  transcript?: string;
}

interface UseVoiceAgentReturn {
  agentState: AgentState;
  transcript: string;
  liveTranscript: string;
  reply: string;
  error: string | null;
  isConnected: boolean;
  analyserNode: AnalyserNode | null;  // active analyser (mic -or- AI audio)
  startListening: () => Promise<void>;
  stopListening: () => void;
  connect: () => void;
  disconnect: () => void;
}

export type InteractionMode = 'manual' | 'toggle' | 'continuous';

const WS_URL = 'ws://localhost:8765/ws';
// Minimum audio length to send (in ms) — avoids sending silence
const MIN_RECORD_MS = 500;
// Maximum recording time before auto-send (ms)
const MAX_RECORD_MS = 8000;

export function useVoiceAgent(mode: InteractionMode = 'manual'): UseVoiceAgentReturn {
  const [agentState, setAgentState] = useState<AgentState>('idle');
  const [transcript, setTranscript] = useState('');
  const [reply, setReply] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [analyserNode, setAnalyserNode] = useState<AnalyserNode | null>(null);

  const wsRef = useRef<WebSocket | null>(null);

  // Mic audio graph
  const micCtxRef = useRef<AudioContext | null>(null);
  const micAnalyserRef = useRef<AnalyserNode | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);

  // AI audio graph
  const aiCtxRef = useRef<AudioContext | null>(null);
  const aiAnalyserRef = useRef<AnalyserNode | null>(null);

  // Audio queue for streaming TTS
  const audioQueueRef = useRef<ArrayBuffer[]>([]);
  const isPlayingRef = useRef<boolean>(false);

  // Recording and VAD state
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const vadIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [liveTranscript, setLiveTranscript] = useState('');
  const speechRecognitionRef = useRef<any>(null);
  const continuousInactivityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---------------------------------------------------------------
  // WebSocket management
  // ---------------------------------------------------------------
  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(WS_URL);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    ws.onopen = () => {
      setIsConnected(true);
      setError(null);
      // Unlock AI AudioContext on user gesture
      if (aiCtxRef.current?.state === 'suspended') {
        aiCtxRef.current.resume();
      }
    };

    ws.onclose = () => {
      setIsConnected(false);
      setAgentState('idle');
    };

    ws.onerror = () => {
      setError('Cannot connect to backend. Is the Python server running?');
      setIsConnected(false);
    };

    ws.onmessage = async (evt) => {
      if (typeof evt.data === 'string') {
        const msg: AgentEvent = JSON.parse(evt.data);
        if (msg.event === 'status' && msg.state) setAgentState(msg.state);
        if (msg.event === 'transcript' && msg.text) setTranscript(msg.text);
        if (msg.event === 'reply' && msg.text) setReply(msg.text);
      } else {
        // Binary frame → WAV audio from TTS
        const buf = evt.data as ArrayBuffer;
        const marker = new Uint8Array(buf, 0, 5);
        const markerStr = String.fromCharCode(...marker);
        if (markerStr === 'AUDIO') {
          const wavBuf = buf.slice(5);
          await playAudio(wavBuf);
        }
      }
    };
  }, []);

  const disconnect = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
    stopListeningInternal();
  }, []);

  // ---------------------------------------------------------------
  // AI audio playback (routes through analyzer for visualization)
  // ---------------------------------------------------------------
  const processAudioQueue = useCallback(async () => {
    if (isPlayingRef.current || audioQueueRef.current.length === 0) return;
    
    isPlayingRef.current = true;
    const wavBuf = audioQueueRef.current.shift()!;
    
    try {
      // Create context if it doesn't exist
      if (!aiCtxRef.current) {
        aiCtxRef.current = new AudioContext();
      }
      const ctx = aiCtxRef.current;
      if (ctx.state === 'suspended') await ctx.resume();

      // Create analyser if it doesn't exist
      if (!aiAnalyserRef.current) {
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.8;
        aiAnalyserRef.current = analyser;
      }
      const analyser = aiAnalyserRef.current;
      setAnalyserNode(analyser); // sphere listens to AI

      const decoded = await ctx.decodeAudioData(wavBuf);
      const src = ctx.createBufferSource();
      src.buffer = decoded;
      src.connect(analyser);
      analyser.connect(ctx.destination);
      src.start();

      src.onended = () => {
        isPlayingRef.current = false;
        
        if (audioQueueRef.current.length > 0) {
          processAudioQueue();
        } else {
          // Switch back to mic analyser if still listening
          setAnalyserNode(micAnalyserRef.current);
          setAgentState((prev) => (prev === 'speaking' ? 'idle' : prev));

          // CONTINUOUS MODE LOOP
          if (mode === 'continuous' && isConnected) {
            // Give a tiny delay so the audio system cleans up
            setTimeout(() => {
              startListening();
            }, 300);
          }
        }
      };
    } catch (e) {
      console.error('Audio playback error', e);
      isPlayingRef.current = false;
      processAudioQueue();
    }
  }, []);

  const playAudio = useCallback((wavBuf: ArrayBuffer) => {
    // In continuous mode, if AI starts speaking, clear the inactivity timer
    if (continuousInactivityTimerRef.current) {
        clearTimeout(continuousInactivityTimerRef.current);
        continuousInactivityTimerRef.current = null;
    }
    audioQueueRef.current.push(wavBuf);
    processAudioQueue();
  }, [processAudioQueue]);

  // ---------------------------------------------------------------
  // Mic recording
  // ---------------------------------------------------------------
  const setupMicAudioGraph = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    micStreamRef.current = stream;

    const ctx = new AudioContext();
    micCtxRef.current = ctx;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.8;
    micAnalyserRef.current = analyser;

    const src = ctx.createMediaStreamSource(stream);
    src.connect(analyser);
    // Do NOT connect to destination — we don't want to hear ourselves

    setAnalyserNode(analyser); // visualize mic
    return stream;
  }, []);

  const sendAudio = useCallback(async (blob: Blob) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

    // Decode to float32 PCM then prefix with sample rate uint32
    const arrBuf = await blob.arrayBuffer();
    const ctx = new OfflineAudioContext(1, 1, 44100);
    const decoded = await ctx.decodeAudioData(arrBuf);
    const sampleRate = decoded.sampleRate;
    const pcm = decoded.getChannelData(0); // Float32Array

    const header = new ArrayBuffer(4);
    new DataView(header).setUint32(0, sampleRate, true);
    const combined = new Uint8Array(header.byteLength + pcm.buffer.byteLength);
    combined.set(new Uint8Array(header), 0);
    combined.set(new Uint8Array(pcm.buffer), 4);
    wsRef.current.send(combined.buffer);
  }, []);

  const stopListeningInternal = useCallback(() => {
    if (recordTimerRef.current) clearTimeout(recordTimerRef.current);
    if (vadIntervalRef.current) clearInterval(vadIntervalRef.current);
    if (speechRecognitionRef.current) {
        try { speechRecognitionRef.current.stop(); } catch(e) {}
        speechRecognitionRef.current = null;
    }
    mediaRecorderRef.current?.stop();
    mediaRecorderRef.current = null;
    micStreamRef.current?.getTracks().forEach(t => t.stop());
    micStreamRef.current = null;
    micCtxRef.current?.close();
    micCtxRef.current = null;
    micAnalyserRef.current = null;
  }, []);

  const startListening = useCallback(async () => {
    if (agentState !== 'idle' || !isConnected) return;
    setError(null);

    try {
      const stream = await setupMicAudioGraph();
      setAgentState('listening');
      chunksRef.current = [];
      
      // Ensure AI context is resumed on user interaction
      if (aiCtxRef.current?.state === 'suspended') {
        aiCtxRef.current.resume();
      }

      const mr = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
      mediaRecorderRef.current = mr;

      mr.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      mr.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        chunksRef.current = [];
        if (blob.size > 1000) { // skip near-empty blobs
          await sendAudio(blob);
        }
        stopListeningInternal();
      };

      mr.start(100); // collect data every 100ms

      // Set up Live Transcription (Web Speech API)
      setLiveTranscript('');
      const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (SpeechRecognition) {
        const reco = new SpeechRecognition();
        reco.continuous = true;
        reco.interimResults = true;
        reco.onresult = (evt: any) => {
          let text = '';
          for (let i = evt.resultIndex; i < evt.results.length; i++) {
             text += evt.results[i][0].transcript;
          }
          setLiveTranscript(text);
        };
        reco.start();
        speechRecognitionRef.current = reco;
      }

      // Voice Activity Detection (VAD) watcher
      let lastSpeechTime = Date.now();
      const SILENCE_THRESHOLD_MS = 2000; // 2 seconds of silence
      const VAD_VOLUME_THRESHOLD = 5;

      // Ensure we have dataArray to check volume
      const dataArray = new Uint8Array(512);

      vadIntervalRef.current = setInterval(() => {
        if (!micAnalyserRef.current) return;
        micAnalyserRef.current.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
        const volume = sum / dataArray.length;

        if (volume > VAD_VOLUME_THRESHOLD) {
          lastSpeechTime = Date.now();
          // In continuous mode, reset the inactivity timer on volume detection
          if (continuousInactivityTimerRef.current) {
            clearTimeout(continuousInactivityTimerRef.current);
            continuousInactivityTimerRef.current = null;
          }
        } else if (Date.now() - lastSpeechTime > SILENCE_THRESHOLD_MS) {
          // It's been quiet too long! Auto-send.
          stopListening();

          // Handle 30s inactivity for Continuous Mode
          if (mode === 'continuous' && !continuousInactivityTimerRef.current) {
             continuousInactivityTimerRef.current = setTimeout(() => {
                console.log("Continuous mode timed out due to 30s inactivity");
                // We don't call stopListening because it's already idle or transcribing
                // We just let the loop die by not calling startListening again
             }, 30000);
          }
        }
      }, 100);

      // Hard stop after MAX_RECORD_MS (just in case)
      recordTimerRef.current = setTimeout(() => {
        stopListening();
      }, MAX_RECORD_MS);
    } catch (e: any) {
      setError('Microphone error: ' + e.message);
      setAgentState('idle');
    }
  }, [agentState, isConnected, setupMicAudioGraph, sendAudio, stopListeningInternal]);

  const stopListening = useCallback(() => {
    if (recordTimerRef.current) clearTimeout(recordTimerRef.current);
    mediaRecorderRef.current?.stop(); // will trigger onstop → sendAudio
  }, []);

  // cleanup on unmount
  useEffect(() => () => {
    wsRef.current?.close();
    stopListeningInternal();
  }, []);

  return {
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
  };
}

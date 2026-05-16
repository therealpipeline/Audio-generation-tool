import { useState, useRef, useEffect } from 'react';
import { GoogleGenAI } from "@google/genai";
import { FFmpeg } from '@ffmpeg/ffmpeg';
import coreURL from '@ffmpeg/core?url';
import wasmURL from '@ffmpeg/core/wasm?url';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Play, 
  Pause,
  Download, 
  Loader2, 
  AlertCircle, 
  CheckCircle2,
  Mic2,
  FastForward,
  Zap,
  ShieldCheck,
  UserCheck,
  Upload,
  FileText,
  Activity
} from 'lucide-react';

const VOICES = [
  { id: 'Charon', label: 'Charon', sub: 'Deep & Confident', icon: ShieldCheck },
  { id: 'Fenrir', label: 'Fenrir', sub: 'Energetic & Punchy', icon: Zap },
  { id: 'Puck', label: 'Puck', sub: 'Fast & Expressive', icon: FastForward },
  { id: 'Aoede', label: 'Orus', sub: 'Strong & Serious', icon: Mic2 },
  { id: 'Kore', label: 'Kore', sub: 'Clear & Direct', icon: UserCheck },
];

enum ProcessStep {
  IDLE = 'idle',
  GENERATING = 'generating',
  REMOVING_SILENCE = 'removing_silence',
  POLISHING = 'polishing',
  DONE = 'done',
  ERROR = 'error'
}

export default function App() {
  const [script, setScript] = useState('');
  const [selectedVoice, setSelectedVoice] = useState(VOICES[0].id);
  const [step, setStep] = useState<ProcessStep>(ProcessStep.IDLE);
  const [error, setError] = useState<string | null>(null);
  const [finalAudioUrl, setFinalAudioUrl] = useState<string | null>(null);
  const [ffmpegLoaded, setFfmpegLoaded] = useState(false);
  const [progressRatio, setProgressRatio] = useState<number>(0);
  const [progressTime, setProgressTime] = useState<number>(0);
  const [ffmpegLog, setFfmpegLog] = useState<string>('');
  
  const ffmpegRef = useRef(new FFmpeg());
  const aiRef = useRef<GoogleGenAI | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [audioProgress, setAudioProgress] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);

  const togglePlay = () => {
    if (audioRef.current) {
      if (isPlaying) {
        audioRef.current.pause();
      } else {
        audioRef.current.play();
      }
      setIsPlaying(!isPlaying);
    }
  };

  const handleTimeUpdate = () => {
    if (audioRef.current) {
      setAudioProgress(audioRef.current.currentTime);
    }
  };

  const handleLoadedMetadata = () => {
    if (audioRef.current) {
      setAudioDuration(audioRef.current.duration);
    }
  };
  
  const handleAudioSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const time = Number(e.target.value);
    if (audioRef.current) {
      audioRef.current.currentTime = time;
      setAudioProgress(time);
    }
  };

  const formatTime = (time: number) => {
    const mins = Math.floor(time / 60);
    const secs = Math.floor(time % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  useEffect(() => {
    loadFFmpeg();
    const apiKey = import.meta.env.VITE_GEMINI_API_KEY || process.env.GEMINI_API_KEY;
    if (apiKey) {
      aiRef.current = new GoogleGenAI({ apiKey });
    }
  }, []);

  const loadFFmpeg = async () => {
    try {
      const ffmpeg = ffmpegRef.current;
      
      ffmpeg.on('progress', ({ progress, time }) => {
        setProgressRatio(Math.max(0, Math.min(1, progress)));
        setProgressTime(Number(time) / 1000000); 
      });
      
      ffmpeg.on('log', ({ message }) => {
        setFfmpegLog(message);
        console.log('[FFmpeg]', message);
      });

      setFfmpegLog('Loading Audio Engine...');
      await ffmpeg.load({
        coreURL,
        wasmURL,
      });
      setFfmpegLoaded(true);
      setFfmpegLog('');
    } catch (err: any) {
      console.error('Failed to load FFmpeg:', err);
      // We set an error but allow the user to see the UI. FFmpeg won't work though.
      setError('Audio Engine failed to load: ' + (err?.message || String(err)) + '. The app is loaded in an iframe, try opening it in a new tab.');
      setFfmpegLoaded(true); // Let them interact, it will fail gracefully on process.
    }
  };

  const decodeBase64ToUint8 = async (base64String: string) => {
    const res = await fetch(`data:application/octet-stream;base64,${base64String}`);
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  };

  const handleGenerate = async () => {
    if (!script.trim()) {
      setError('Please enter a script or upload a file.');
      return;
    }
    
    if (!aiRef.current) {
      setError('AI model not initialized. Check your API key.');
      return;
    }

    setStep(ProcessStep.GENERATING);
    setError(null);
    setFinalAudioUrl(null);
    setProgressRatio(0);
    setProgressTime(0);
    setIsPlaying(false);

    try {
      const fullPrompt = `You are recording an energetic, professional voiceover for a YouTube commentary video. Speak with high energy and clear articulation. The delivery should be punchy and engaging, but DO NOT rush. Maintain a clear, steady, and deliberate pace so the listener can easily follow along.\n\nScript: ${script}`;
      
      const actualVoiceToRequest = selectedVoice === 'Aoede' ? 'Zephyr' : selectedVoice;

      const response = await aiRef.current.models.generateContent({
        model: "gemini-3.1-flash-tts-preview",
        contents: [{ parts: [{ text: fullPrompt }] }],
        config: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: actualVoiceToRequest },
            },
          },
        },
      });

      const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (!base64Audio) {
        throw new Error('No audio data received. Try again or try a different script.');
      }

      const audioData = await decodeBase64ToUint8(base64Audio);
      const ffmpeg = ffmpegRef.current;
      
      if (!ffmpeg.loaded) {
        throw new Error('FFmpeg is not loaded correctly. Please refresh or try in a new tab.');
      }

      const inputName = 'input.pcm';
      const noSilenceName = 'nosilence.wav';
      const finalName = 'final.wav';
      
      await ffmpeg.writeFile(inputName, audioData);

      // STEP 2: REMOVE SILENCE
      setStep(ProcessStep.REMOVING_SILENCE);
      setProgressRatio(0);
      setProgressTime(0);
      
      const code1 = await ffmpeg.exec([
        '-f', 's16le',
        '-ar', '24000',
        '-ac', '1',
        '-i', inputName, 
        '-af', 'silenceremove=stop_periods=-1:stop_duration=0.2:stop_threshold=-40dB', 
        noSilenceName
      ]);
      
      if (code1 !== 0) throw new Error('Failed to remove silence gaps.');

      // STEP 3: NORMALIZE & POLISH
      setStep(ProcessStep.POLISHING);
      setProgressRatio(0);
      setProgressTime(0);
      
      const code2 = await ffmpeg.exec([
        '-i', noSilenceName,
        '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11,compand=attacks=0:points=-80/-80|-12/-12|0/-7.5:gain=0',
        finalName
      ]);

      if (code2 !== 0) throw new Error('Failed to polish audio.');

      const finalData = await ffmpeg.readFile(finalName);
      const audioBlob = new Blob([(finalData as any).buffer], { type: 'audio/wav' });
      const url = URL.createObjectURL(audioBlob);
      
      setFinalAudioUrl(url);
      setStep(ProcessStep.DONE);
      setProgressRatio(1);

      await ffmpeg.deleteFile(inputName);
      await ffmpeg.deleteFile(noSilenceName);
      await ffmpeg.deleteFile(finalName);

    } catch (err: any) {
      console.error(err);
      setError(err.message || 'An unexpected error occurred during audio generation.');
      setStep(ProcessStep.ERROR);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    if (step === ProcessStep.DONE) {
      setStep(ProcessStep.IDLE);
      setFinalAudioUrl(null);
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      if (event.target?.result && typeof event.target.result === 'string') {
        setScript(event.target.result);
      }
    };
    reader.readAsText(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const getStatusMessage = () => {
    switch (step) {
      case ProcessStep.GENERATING: return 'Generating AI speech...';
      case ProcessStep.REMOVING_SILENCE: return 'Removing silences...';
      case ProcessStep.POLISHING: return 'Mastering audio...';
      case ProcessStep.DONE: return 'Audio ready!';
      default: return '';
    }
  };

  return (
    <div className="h-[100dvh] w-full bg-[#050505] text-zinc-100 flex flex-col items-center justify-center p-2 sm:p-4 font-sans selection:bg-indigo-500/30 overflow-hidden relative">
      {/* Background */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-[-20%] left-[-10%] w-[60%] h-[60%] rounded-full bg-indigo-500/5 blur-[120px]" />
        <div className="absolute bottom-[-20%] right-[-10%] w-[60%] h-[60%] rounded-full bg-purple-500/5 blur-[120px]" />
      </div>

      <motion.div 
        initial={{ opacity: 0, scale: 0.98 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.4, ease: 'easeOut' }}
        className="w-full max-w-xl h-full flex flex-col bg-[#0d0d0d] border border-zinc-800/80 rounded-xl md:rounded-3xl shadow-2xl relative z-10 overflow-hidden"
      >
        {/* Header (Fixed) */}
        <div className="p-3 md:p-6 pb-2 shrink-0 border-b border-zinc-800/50">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-8 h-8 md:w-10 md:h-10 bg-zinc-900 rounded-lg md:rounded-xl border border-zinc-800/80 shadow-inner">
              <Activity className="w-4 h-4 md:w-5 md:h-5 text-indigo-400" />
            </div>
            <div>
              <h1 className="text-lg md:text-2xl font-semibold tracking-tight text-white leading-none">
                PART3-VG
              </h1>
              <p className="text-zinc-500 text-[10px] md:text-sm mt-0.5 md:mt-1 truncate">
                AI Commentary Generator
              </p>
            </div>
          </div>
        </div>

        {/* Scrollable Main Content */}
        <div className="flex-1 overflow-y-auto min-h-0 flex flex-col p-3 md:p-6 pb-2 space-y-3 md:space-y-6 custom-scrollbar">
          
          {/* Script Area (Takes available space) */}
          <div className="flex-1 flex flex-col min-h-[120px] space-y-2 relative group">
            <div className="flex items-center justify-between shrink-0">
              <label className="text-[10px] sm:text-xs font-semibold uppercase tracking-widest text-zinc-500">
                Script
              </label>
              <button 
                onClick={() => fileInputRef.current?.click()}
                className="text-[10px] sm:text-xs font-medium text-indigo-400 hover:text-indigo-300 flex items-center gap-1.5 transition-colors focus:outline-none"
                disabled={step !== ProcessStep.IDLE && step !== ProcessStep.DONE && step !== ProcessStep.ERROR}
              >
                <Upload className="w-3 h-3 md:w-3.5 md:h-3.5" />
                Upload .TXT
              </button>
              <input 
                ref={fileInputRef}
                type="file" 
                accept=".text, .txt"
                className="hidden" 
                onChange={handleFileUpload} 
              />
            </div>
            
            <div className="relative flex-1 flex flex-col">
              <textarea
                value={script}
                onChange={(e) => setScript(e.target.value)}
                placeholder="Paste script here..."
                className="flex-1 w-full bg-[#121212] border border-zinc-800 rounded-lg md:rounded-xl p-3 md:p-4 text-xs md:text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 transition-all resize-none placeholder:text-zinc-700 leading-relaxed text-zinc-300 shadow-inner custom-scrollbar"
                disabled={step !== ProcessStep.IDLE && step !== ProcessStep.DONE && step !== ProcessStep.ERROR}
              />
              {!script && (
                <div className="absolute right-3 bottom-3 md:right-4 md:bottom-4 pointer-events-none text-zinc-700">
                  <FileText className="w-4 h-4 md:w-5 md:h-5 opacity-40" />
                </div>
              )}
            </div>
          </div>

          {/* Voice Selector (Horizontal scroll on mobile, grid on desktop) */}
          <div className="space-y-2 shrink-0">
            <label className="text-[10px] sm:text-xs font-semibold uppercase tracking-widest text-zinc-500">
              Voice
            </label>
            <div className="flex overflow-x-auto gap-2 pb-2 md:grid md:grid-cols-2 md:pb-0 md:gap-3 hide-scrollbar snap-x">
              {VOICES.map((voice) => {
                const Icon = voice.icon;
                const isSelected = selectedVoice === voice.id;
                return (
                  <button
                    key={voice.id}
                    onClick={() => setSelectedVoice(voice.id)}
                    disabled={step !== ProcessStep.IDLE && step !== ProcessStep.DONE && step !== ProcessStep.ERROR}
                    className={`flex-shrink-0 w-[120px] md:w-auto snap-start flex flex-col gap-1 md:gap-1.5 p-2 md:p-3 rounded-lg md:rounded-xl border transition-all text-left ${
                      isSelected 
                        ? 'bg-indigo-500/10 border-indigo-500/40' 
                        : 'bg-[#121212] border-zinc-800/80 hover:border-zinc-700 text-zinc-500'
                    }`}
                  >
                    <div className="flex items-center justify-between w-full">
                      <Icon className={`w-3.5 h-3.5 md:w-4 md:h-4 ${isSelected ? 'text-indigo-400' : 'text-zinc-500'}`} />
                      <div className={`w-1.5 h-1.5 md:w-2 md:h-2 rounded-full transition-all ${isSelected ? 'bg-indigo-500 shadow-[0_0_8px_rgba(99,102,241,0.8)]' : 'bg-transparent border border-zinc-700'}`} />
                    </div>
                    <div className="mt-0.5 md:mt-1">
                      <div className={`font-medium text-xs md:text-sm ${isSelected ? 'text-indigo-100' : 'text-zinc-300'}`}>
                        {voice.label === 'Aoede' ? 'Orus' : voice.label}
                      </div>
                      <div className={`text-[9px] md:text-[10px] truncate ${isSelected ? 'text-indigo-300' : 'text-zinc-600'}`}>
                        {voice.sub}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

        </div>

        {/* Action Bottom Area (Fixed) */}
        <div className="p-3 md:p-6 pt-2 shrink-0 border-t border-zinc-800/50 bg-[#0d0d0d] z-20 space-y-2 md:space-y-3">
          {/* Status & Error Display */}
          <AnimatePresence mode="wait">
            {(step !== ProcessStep.IDLE && step !== ProcessStep.ERROR && step !== ProcessStep.DONE) && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="bg-[#121212] rounded-lg md:rounded-xl border border-zinc-800/80 p-2 md:p-4"
              >
                <div className="flex flex-col gap-2 md:gap-3">
                  <div className="flex items-center gap-2 md:gap-3">
                    <Loader2 className="w-3.5 h-3.5 md:w-4 md:h-4 text-indigo-400 animate-spin shrink-0" />
                    <div className="flex-1 flex justify-between items-center min-w-0">
                      <span className="text-[11px] md:text-sm font-medium text-white truncate">
                        {getStatusMessage()}
                      </span>
                      {step !== ProcessStep.GENERATING && (
                        <span className="text-[9px] md:text-[10px] text-zinc-500 font-mono shrink-0 ml-2">
                          {(progressTime >= 0 ? progressTime : 0).toFixed(1)}s
                        </span>
                      )}
                    </div>
                  </div>
                  
                  {step !== ProcessStep.GENERATING && (
                    <div className="h-1 w-full bg-zinc-900 rounded-full overflow-hidden">
                      <motion.div 
                        className="h-full bg-indigo-500 rounded-full"
                        initial={{ width: 0 }}
                        animate={{ width: `${Math.max(5, progressRatio * 100)}%` }}
                        transition={{ duration: 0.1 }}
                      />
                    </div>
                  )}
                </div>
              </motion.div>
            )}

            {error && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className="flex items-start gap-2 p-2 md:p-3 bg-red-500/10 border border-red-500/20 rounded-lg md:rounded-xl text-[11px] md:text-sm overflow-y-auto max-h-24 custom-scrollbar"
              >
                <AlertCircle className="w-3.5 h-3.5 md:w-4 md:h-4 text-red-400 shrink-0 mt-0.5" />
                <p className="text-red-300 leading-relaxed max-w-full break-words">{error}</p>
              </motion.div>
            )}

            {finalAudioUrl && step === ProcessStep.DONE && (
              <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className="flex flex-col gap-2"
              >
                <div className="flex-1 bg-[#121212] rounded-lg md:rounded-xl border border-zinc-800/80 p-2 md:p-3 flex flex-col gap-2">
                  <div className="flex items-center justify-between px-1">
                    <span className="text-emerald-400 font-medium text-[11px] md:text-xs flex items-center gap-1.5 md:gap-2">
                      <CheckCircle2 className="w-3.5 h-3.5 md:w-4 md:h-4" />
                      Audio Ready
                    </span>
                    <span className="text-zinc-500 text-[10px] md:text-xs font-mono">
                      {formatTime(audioProgress)} / {formatTime(audioDuration)}
                    </span>
                  </div>
                  
                  <div className="flex items-center gap-2 md:gap-3">
                    <button 
                      onClick={togglePlay}
                      className="w-8 h-8 md:w-10 md:h-10 shrink-0 bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-400 rounded-full flex items-center justify-center transition-colors focus:outline-none"
                    >
                      {isPlaying ? <Pause className="w-4 h-4 md:w-5 md:h-5 fill-current" /> : <Play className="w-4 h-4 md:w-5 md:h-5 fill-current ml-0.5" />}
                    </button>
                    
                    <input 
                      type="range"
                      min="0"
                      max={audioDuration || 100}
                      value={audioProgress}
                      step="0.01"
                      onChange={handleAudioSeek}
                      className="flex-1 h-1.5 md:h-2 bg-zinc-800 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 md:[&::-webkit-slider-thumb]:w-4 md:[&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:bg-indigo-500 [&::-webkit-slider-thumb]:rounded-full"
                    />
                    
                    <a
                      href={finalAudioUrl}
                      download={`commentary_${selectedVoice}.wav`}
                      className="w-8 h-8 md:w-10 md:h-10 shrink-0 bg-zinc-800/50 hover:bg-zinc-800 text-zinc-300 rounded-full flex items-center justify-center transition-colors"
                      title="Download .WAV"
                    >
                      <Download className="w-4 h-4 md:w-5 md:h-5" />
                    </a>
                  </div>
                  
                  <audio 
                    ref={audioRef}
                    src={finalAudioUrl} 
                    onTimeUpdate={handleTimeUpdate}
                    onLoadedMetadata={handleLoadedMetadata}
                    onEnded={() => setIsPlaying(false)}
                    className="hidden"
                  />
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Main Button */}
          <button
            onClick={handleGenerate}
            disabled={step !== ProcessStep.IDLE && step !== ProcessStep.DONE && step !== ProcessStep.ERROR || !ffmpegLoaded}
            className={`w-full h-10 md:h-[52px] rounded-lg md:rounded-xl font-semibold text-xs md:text-sm transition-all flex items-center justify-center gap-2 relative overflow-hidden active:scale-[0.98] ${
              step === ProcessStep.IDLE || step === ProcessStep.DONE || step === ProcessStep.ERROR
                ? 'bg-zinc-100 text-zinc-900 hover:bg-white shadow-[0_0_20px_rgba(255,255,255,0.1)]'
                : 'bg-zinc-800 text-zinc-500 cursor-not-allowed'
            }`}
          >
            {step === ProcessStep.IDLE || step === ProcessStep.DONE || step === ProcessStep.ERROR ? (
              <>
                <Play className="w-3.5 h-3.5 md:w-4 md:h-4 fill-current" />
                <span>{step === ProcessStep.DONE ? 'Generate Another' : 'Generate Audio'}</span>
              </>
            ) : (
              <>
                <Loader2 className="w-3.5 h-3.5 md:w-4 md:h-4 animate-spin text-zinc-500" />
                <span>Processing...</span>
              </>
            )}
          </button>
        </div>

        {/* Global Loading Overlay */}
        {!ffmpegLoaded && !error && (
          <div className="absolute inset-0 bg-[#0d0d0d]/90 backdrop-blur-sm flex flex-col items-center justify-center z-50">
            <Loader2 className="w-6 h-6 md:w-8 md:h-8 text-indigo-400 animate-spin mb-3 md:mb-4" />
            <p className="text-[10px] md:text-xs text-zinc-400 uppercase tracking-widest font-semibold ml-1">
              Initializing Engine
            </p>
            {ffmpegLog && (
              <p className="text-[9px] md:text-[10px] text-zinc-500 font-mono mt-2 max-w-[80%] text-center truncate">
                {ffmpegLog}
              </p>
            )}
            <p className="text-[9px] md:text-[10px] text-zinc-600 mt-2 md:mt-4 max-w-[180px] md:max-w-[200px] text-center px-4">
              Loading AI processing engine.
            </p>
          </div>
        )}
      </motion.div>

      <style dangerouslySetInnerHTML={{__html: `
        .hide-scrollbar::-webkit-scrollbar { display: none; }
        .hide-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
        
        .custom-scrollbar::-webkit-scrollbar {
          width: 4px;
        }
        @media (min-width: 768px) {
          .custom-scrollbar::-webkit-scrollbar {
            width: 6px;
          }
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #27272a;
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: #3f3f46;
        }
      `}} />
    </div>
  );
}

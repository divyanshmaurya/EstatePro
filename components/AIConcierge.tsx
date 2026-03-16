
import React, { useState, useRef, useEffect } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { Icons, PROPERTIES } from '../constants';
import { ChatMessage } from '../types';

// Utility functions for audio
function encode(bytes: Uint8Array) {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function decode(base64: string) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number,
  numChannels: number,
): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}

const STORAGE_KEY = 'estatepro_chat_history';

const AIConcierge: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [mode, setMode] = useState<'text' | 'voice'>('text');
  const [messages, setMessages] = useState<(ChatMessage & { grounding?: any[] })[]>([]);
  const [inputText, setInputText] = useState('');
  const [isConnecting, setIsConnecting] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isModelTyping, setIsModelTyping] = useState(false);
  
  const hasAutoPopped = useRef(false);

  const audioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const sessionRef = useRef<any>(null);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const nextStartTimeRef = useRef<number>(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    const savedHistory = localStorage.getItem(STORAGE_KEY);
    if (savedHistory) {
      try {
        const parsed = JSON.parse(savedHistory);
        const revived = parsed.map((m: any) => ({
          ...m,
          timestamp: new Date(m.timestamp)
        }));
        setMessages(revived);
      } catch (e) {
        console.error('Failed to parse chat history', e);
      }
    }
  }, []);

  useEffect(() => {
    if (messages.length > 0) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
    }
  }, [messages]);

  useEffect(() => {
    scrollToBottom();
  }, [messages, isOpen]);

  useEffect(() => {
    const handleScroll = () => {
      if (hasAutoPopped.current) return;
      const windowHeight = window.innerHeight;
      const scrollY = window.scrollY;
      const bodyHeight = document.body.offsetHeight;
      if (windowHeight + scrollY >= bodyHeight - 50) {
        setIsOpen(true);
        hasAutoPopped.current = true;
      }
    };
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const addMessage = (role: 'user' | 'model', text: string, grounding?: any[]) => {
    setMessages(prev => [...prev, {
      id: Math.random().toString(36).substr(2, 9),
      role,
      text,
      timestamp: new Date(),
      grounding
    }]);
  };

  const clearHistory = () => {
    if (window.confirm('Clear all chat history?')) {
      setMessages([]);
      localStorage.removeItem(STORAGE_KEY);
    }
  };

  const stopAllAudio = () => {
    sourcesRef.current.forEach(source => {
      try { source.stop(); } catch (e) {}
    });
    sourcesRef.current.clear();
    nextStartTimeRef.current = 0;
  };

  const startVoiceSession = async () => {
    if (isConnecting) return;
    setIsConnecting(true);
    setMode('voice');
    
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
      if (!audioContextRef.current) audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      if (!outputAudioContextRef.current) outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        callbacks: {
          onopen: () => {
            setIsConnecting(false);
            setIsListening(true);
            const source = audioContextRef.current!.createMediaStreamSource(stream);
            const scriptProcessor = audioContextRef.current!.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const l = inputData.length;
              const int16 = new Int16Array(l);
              for (let i = 0; i < l; i++) int16[i] = inputData[i] * 32768;
              const pcmBlob = { data: encode(new Uint8Array(int16.buffer)), mimeType: 'audio/pcm;rate=16000' };
              if (sessionRef.current) sessionRef.current.sendRealtimeInput({ media: pcmBlob });
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(audioContextRef.current!.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio && outputAudioContextRef.current) {
              const ctx = outputAudioContextRef.current;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              const audioBuffer = await decodeAudioData(decode(base64Audio), ctx, 24000, 1);
              const source = ctx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(ctx.destination);
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              sourcesRef.current.add(source);
              source.onended = () => sourcesRef.current.delete(source);
            }
            if (message.serverContent?.interrupted) stopAllAudio();
          },
          onerror: (e) => { setIsConnecting(false); setIsListening(false); },
          onclose: () => { setIsListening(false); setIsConnecting(false); }
        },
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: `You are the EstatePro Assistant. Portfolio: ${JSON.stringify(PROPERTIES)}.`,
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } }
        }
      });
      sessionRef.current = await sessionPromise;
    } catch (err) {
      console.error(err);
      setIsConnecting(false);
    }
  };

  const stopVoiceSession = () => {
    if (sessionRef.current) { sessionRef.current.close(); sessionRef.current = null; }
    stopAllAudio();
    setIsListening(false);
    setMode('text');
  };

  const handleTextSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim()) return;
    const userText = inputText;
    setInputText('');
    addMessage('user', userText);
    setIsModelTyping(true);

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: userText,
        config: {
          tools: [{ googleMaps: {} }],
          systemInstruction: `You are the EstatePro Assistant. Portfolio: ${JSON.stringify(PROPERTIES)}.`
        }
      });
      const text = response.text || "I apologize, I'm unable to process that at the moment.";
      const grounding = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
      addMessage('model', text, grounding);
    } catch (error) {
      addMessage('model', "I'm experiencing a minor connectivity interruption.");
    } finally {
      setIsModelTyping(false);
    }
  };

  const handleClose = () => { stopVoiceSession(); setIsOpen(false); };

  return (
    <div className="fixed bottom-8 right-8 z-[60] flex flex-col items-end">
      {isOpen && (
        <div className="mb-4 w-[400px] h-[600px] bg-white rounded-3xl shadow-2xl flex flex-col overflow-hidden border border-slate-200 animate-in slide-in-from-bottom-4 duration-300">
          <div className="bg-red-950 p-6 text-white flex justify-between items-center">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-red-600 rounded-xl flex items-center justify-center">
                <Icons.Chat />
              </div>
              <div>
                <h3 className="font-bold tracking-tight">AI Assistant</h3>
                {mode === 'voice' && <p className="text-[10px] text-red-400 uppercase tracking-widest">Listening...</p>}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {messages.length > 0 && (
                <button onClick={clearHistory} className="hover:bg-white/10 p-2 rounded-lg transition-colors text-slate-400 hover:text-white" title="Clear History">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                </button>
              )}
              <button onClick={handleClose} className="hover:bg-white/10 p-1 rounded-lg transition-colors"><Icons.X /></button>
            </div>
          </div>

          <div className="flex-grow overflow-y-auto p-6 space-y-4 bg-slate-50">
            {messages.length === 0 && (
              <div className="text-center py-10">
                <div className="w-16 h-16 bg-white border border-slate-200 rounded-2xl flex items-center justify-center mx-auto mb-4 text-red-600 shadow-sm"><Icons.Chat /></div>
                <h4 className="font-bold text-slate-900 mb-2">EstatePro Concierge</h4>
                <p className="text-slate-500 text-sm max-w-[240px] mx-auto leading-relaxed">How can I assist you with our portfolio today?</p>
              </div>
            )}
            {messages.map((m) => (
              <div key={m.id} className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
                <div className={`max-w-[85%] p-4 rounded-2xl text-sm leading-relaxed shadow-sm ${m.role === 'user' ? 'bg-red-600 text-white rounded-tr-none' : 'bg-white text-slate-700 border border-slate-100 rounded-tl-none'}`}>
                  {m.text}
                  {m.grounding && m.grounding.length > 0 && (
                    <div className="mt-3 pt-3 border-t border-slate-100 space-y-1">
                      <p className="text-[10px] font-bold text-red-400 uppercase tracking-tighter">Verified Locations</p>
                      {m.grounding.map((chunk, i) => chunk.maps && <a key={i} href={chunk.maps.uri} target="_blank" rel="noopener noreferrer" className="block text-[11px] text-red-600 hover:underline truncate">📍 {chunk.maps.title || 'View on Maps'}</a>)}
                    </div>
                  )}
                </div>
                <span className="text-[10px] text-slate-400 mt-1 px-1">{m.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              </div>
            ))}
            {isModelTyping && <div className="flex gap-1 p-2"><div className="w-1 h-1 bg-red-400 rounded-full animate-bounce" /><div className="w-1 h-1 bg-red-400 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }} /><div className="w-1 h-1 bg-red-400 rounded-full animate-bounce" style={{ animationDelay: '0.4s' }} /></div>}
            {mode === 'voice' && (
              <div className="flex flex-col items-center justify-center py-12 space-y-4">
                <div className="flex items-end gap-1.5 h-16">
                  {[...Array(7)].map((_, i) => <div key={i} className="w-1.5 bg-red-600 rounded-full animate-pulse" style={{ animationDelay: `${i * 0.1}s`, height: isListening ? `${24 + Math.random() * 40}px` : '6px' }} />)}
                </div>
                <button onClick={stopVoiceSession} className="mt-6 bg-red-950 text-white px-8 py-3 rounded-xl text-sm font-bold shadow-lg hover:bg-red-600 transition-all active:scale-95">Return to Text</button>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {mode === 'text' && (
            <div className="p-4 bg-white border-t border-slate-100">
              <form onSubmit={handleTextSubmit} className="flex gap-2 mb-2">
                <input type="text" value={inputText} onChange={(e) => setInputText(e.target.value)} placeholder="Type your message..." className="flex-grow bg-slate-100 border-none rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-red-600/20 transition-all" />
                <button type="submit" className="bg-red-600 text-white w-12 h-12 rounded-xl hover:bg-red-700 transition-all shadow-sm flex items-center justify-center flex-shrink-0" aria-label="Send message"><span className="rotate-90 inline-block transform scale-125"><Icons.Send /></span></button>
              </form>
              <div className="flex justify-between items-center px-1">
                <button type="button" onClick={startVoiceSession} className="flex items-center gap-1.5 text-red-600 text-[11px] font-bold hover:text-red-700 transition-colors"><Icons.Mic />Talk</button>
                <p className="text-[9px] text-slate-400 font-medium uppercase tracking-widest">Sterling Assistant v2.5</p>
              </div>
            </div>
          )}
        </div>
      )}

      {!isOpen && (
        <button onClick={() => setIsOpen(true)} className="bg-red-950 text-white w-14 h-14 rounded-2xl shadow-2xl flex items-center justify-center hover:scale-105 transition-all active:scale-95 group relative border border-white/10">
          <Icons.Chat />
          <span className="absolute -top-12 right-0 bg-red-950 text-white px-4 py-2 rounded-xl text-xs font-bold whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity shadow-xl border border-white/10">Assistant</span>
        </button>
      )}
    </div>
  );
};

export default AIConcierge;
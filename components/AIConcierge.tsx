
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { Icons, PROPERTIES } from '../constants';
import { ChatMessage } from '../types';

// Audio utility functions
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

// Session data interface for lead tracking
interface SessionData {
  stage: 'intent' | 'core_needs' | 'core_needs_timeline' | 'intent_specific' | 'value_exchange' | 'lead_name' | 'lead_phone' | 'lead_email' | 'handoff' | 'complete';
  intent?: string;
  location?: string;
  budget?: string;
  timeline?: string;
  financing?: string;
  bedrooms?: string;
  zipCode?: string;
  listingPreference?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  email?: string;
  contactPreference?: string;
  bestTime?: string;
}

const DEFAULT_SESSION: SessionData = { stage: 'intent' };

const WELCOME_MESSAGE = "Hi! I'm your real estate AI assistant. I can help you buy, rent, or sell... Are you looking to buy, rent, or sell today?";

// Build dynamic system instruction based on conversation stage
function buildSystemInstruction(session: SessionData): string {
  return `You are a friendly, warm real estate assistant chatbot for EstatePro. You talk like a real person — short, simple, casual sentences. Think of yourself as a helpful friend who knows real estate well.

ABSOLUTE RULES FOR YOUR TONE:
- NEVER use markdown formatting (no **, no ##, no bullet points)
- NEVER explain your internal reasoning or what you're doing behind the scenes
- NEVER say things like "I've registered..." or "My focus is now on..." or "I'm structuring..."
- NEVER use corporate/robotic language
- Just talk like a normal, friendly human in a chat
- Keep responses to 1-3 short sentences max
- Use casual, warm language

CURRENT STAGE: ${session.stage}
COLLECTED DATA: ${JSON.stringify(session)}

PROPERTY PORTFOLIO:
${JSON.stringify(PROPERTIES)}

CONVERSATION FLOW — respond based on the CURRENT STAGE only:

intent:
User was asked if they want to buy, rent, or sell. Figure out their intent. If unclear: "Sorry, I didn't catch that. Are you looking to buy, rent, or sell?" If clear, confirm casually and ask: "Great! Which area are you targeting? And what's your approximate budget range?"

core_needs:
They told you area/budget. Say something like "Nice choice!" then ask: "And what's your timeline?"

core_needs_timeline:
They gave a timeline. Acknowledge it, then ask:
- If buying: "Are you already pre-approved for a mortgage, or paying cash?"
- If renting: "How many bedrooms are you looking for?"
- If selling: "What's the zip code of the property you'd like to sell?"

intent_specific:
They answered the intent question. Now pick 2 matching properties from the portfolio and say something like:
"Found it! Here are 2 quick previews:

1. [Price] in [Location] — [one cool feature]
2. [Price] in [Location] — [one cool feature]

Which one catches your eye, 1 or 2?"

value_exchange:
They picked one. Say: "Great taste! Can I get your name?"

lead_name:
They gave their name. Say: "Thanks, [Name]! To send you the full photos and details, what's your cell phone number?"

lead_phone:
They gave a phone number. Say: "Got it! And what's your email address?"
If they refuse to give a number: "I totally get it — but I do need a way to send you the photos. How about just sharing your number for now?"
Keep asking until they give a number. Phone is required.

lead_email:
They gave (or skipped) email. Say: "Last thing — would you prefer our agent to reach out by text or call? And what time works best for you?"

handoff:
They gave contact preference and time. Say: "Perfect, [Name]! Our agent will [text/call] you around [time]. Excited to help you out!"

complete:
Chat naturally about properties if they have more questions.

IMPORTANT — After your conversational response, add this on a new line (the user will NOT see this):
|||EXTRACT|||{"stage":"${session.stage}","next_stage":"<next_stage>","data":{<extracted_fields>}}|||END|||

Stage transitions: intent->core_needs, core_needs->core_needs_timeline, core_needs_timeline->intent_specific, intent_specific->value_exchange, value_exchange->lead_name, lead_name->lead_phone, lead_phone->lead_email, lead_email->handoff, handoff->complete
Data keys: intent, location, budget, timeline, financing, bedrooms, zipCode, listingPreference, firstName, lastName, phone, email, contactPreference, bestTime
Set next_stage to current stage if you couldn't extract what's needed yet.`;
}

// Generate chat analysis for email
async function generateChatAnalysis(messages: (ChatMessage & { grounding?: any[] })[], session: SessionData): Promise<string> {
  try {
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
    const chatLog = messages.map(m => `${m.role === 'user' ? 'Customer' : 'Assistant'}: ${m.text}`).join('\n');

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: `Analyze this real estate lead conversation and provide a structured summary for the sales agent:

CONVERSATION LOG:
${chatLog}

COLLECTED LEAD DATA:
${JSON.stringify(session, null, 2)}

Provide:
1. Lead Quality Assessment (Hot/Warm/Cold)
2. Customer Intent: ${session.intent || 'Unknown'}
3. Key Requirements Summary
4. Recommended Follow-up Approach
5. Notable Preferences or Concerns
6. Complete Contact Details`,
      config: {
        systemInstruction: 'You are a real estate lead analyst. Provide a concise, professional analysis formatted for an agent to quickly review before contacting the lead.'
      }
    });

    return response.text || 'Analysis generation failed.';
  } catch (err) {
    console.error('Analysis generation failed:', err);
    return `Lead Summary:
Name: ${session.firstName} ${session.lastName}
Phone: ${session.phone}
Email: ${session.email || 'Not provided'}
Intent: ${session.intent}
Location: ${session.location}
Budget: ${session.budget}
Timeline: ${session.timeline}
Contact Preference: ${session.contactPreference}
Best Time: ${session.bestTime}`;
  }
}

// Send lead email via Vercel API route (Nodemailer + Gmail SMTP)
async function sendLeadEmail(session: SessionData, analysis: string) {
  const payload = {
    leadName: `${session.firstName || ''} ${session.lastName || ''}`.trim(),
    phone: session.phone || '',
    email: session.email || '',
    intent: session.intent || '',
    location: session.location || '',
    budget: session.budget || '',
    timeline: session.timeline || '',
    financing: session.financing || '',
    bedrooms: session.bedrooms || '',
    zipCode: session.zipCode || '',
    listingPreference: session.listingPreference || '',
    contactPreference: session.contactPreference || '',
    bestTime: session.bestTime || '',
    analysis,
  };

  try {
    const response = await fetch('/api/send-email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (response.ok) {
      console.log('Lead email sent successfully');
      return true;
    }
    const errorData = await response.json().catch(() => ({}));
    console.error('Email API error:', errorData);
    return false;
  } catch (err) {
    console.error('Email sending failed:', err);
    return false;
  }
}

const AIConcierge: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [mode, setMode] = useState<'text' | 'voice'>('text');
  const [messages, setMessages] = useState<(ChatMessage & { grounding?: any[] })[]>([]);
  const [inputText, setInputText] = useState('');
  const [isConnecting, setIsConnecting] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isModelTyping, setIsModelTyping] = useState(false);
  const [session, setSession] = useState<SessionData>(DEFAULT_SESSION);
  const [emailSent, setEmailSent] = useState(false);

  const hasAutoPopped = useRef(false);
  const welcomeSent = useRef(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const sessionRef = useRef<any>(null);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const nextStartTimeRef = useRef<number>(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const speechRecognitionRef = useRef<any>(null);
  const aiVoiceTextRef = useRef<string>('');
  const mediaStreamRef = useRef<MediaStream | null>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };


  useEffect(() => {
    scrollToBottom();
  }, [messages, isOpen]);

  // Auto-pop chatbot near page bottom
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

  // Send welcome message when chat opens for the first time
  useEffect(() => {
    if (isOpen && messages.length === 0 && !welcomeSent.current) {
      welcomeSent.current = true;
      addMessage('model', WELCOME_MESSAGE);
    }
  }, [isOpen]);

  const addMessage = useCallback((role: 'user' | 'model', text: string, grounding?: any[]) => {
    setMessages(prev => [...prev, {
      id: Math.random().toString(36).substr(2, 9),
      role,
      text,
      timestamp: new Date(),
      grounding
    }]);
  }, []);

  const clearHistory = () => {
    if (window.confirm('Clear chat and start over?')) {
      setMessages([]);
      setSession(DEFAULT_SESSION);
      setEmailSent(false);
      welcomeSent.current = false;
    }
  };

  const stopAllAudio = () => {
    sourcesRef.current.forEach(source => {
      try { source.stop(); } catch (e) {}
    });
    sourcesRef.current.clear();
    nextStartTimeRef.current = 0;
  };

  // Process extraction data from AI response
  const processExtraction = useCallback(async (fullText: string, allMessages: (ChatMessage & { grounding?: any[] })[]) => {
    if (!fullText.includes('|||EXTRACT|||')) return fullText;

    const parts = fullText.split('|||EXTRACT|||');
    const displayText = parts[0].trim();
    const jsonStr = parts[1]?.split('|||END|||')[0]?.trim();

    if (jsonStr) {
      try {
        const extracted = JSON.parse(jsonStr);
        setSession(prev => {
          const updated = { ...prev };
          if (extracted.data) {
            Object.entries(extracted.data).forEach(([key, value]) => {
              if (value !== undefined && value !== null && value !== '') {
                (updated as any)[key] = value;
              }
            });
          }
          if (extracted.next_stage) {
            updated.stage = extracted.next_stage;
          }

          // Trigger email when handoff completes
          if (updated.stage === 'complete' && updated.bestTime && !emailSent) {
            setEmailSent(true);
            (async () => {
              try {
                const analysis = await generateChatAnalysis(allMessages, updated);
                const sent = await sendLeadEmail(updated, analysis);
                if (sent) {
                  addMessage('model', 'Awesome — I\'ve sent your details over to our team. They\'ll be reaching out soon!');
                } else {
                  addMessage('model', 'I\'ve saved your details. Our team will follow up with you shortly!');
                }
              } catch (err) {
                console.error('Email notification failed:', err);
                addMessage('model', 'Your info is saved! Our team will reach out to you soon.');
              }
            })();
          }

          return updated;
        });
      } catch (e) {
        console.error('Failed to parse extraction data:', e, jsonStr);
      }
    }

    return displayText;
  }, [emailSent, addMessage]);

  // Voice session management
  const startVoiceSession = async () => {
    if (isConnecting) return;
    setIsConnecting(true);
    setMode('voice');

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
      if (!audioContextRef.current) audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      if (!outputAudioContextRef.current) outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      // Start Web Speech API for user transcription
      const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (SpeechRecognition) {
        const recognition = new SpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = false;
        recognition.lang = 'en-US';
        recognition.onresult = (event: any) => {
          const last = event.results.length - 1;
          const transcript = event.results[last][0].transcript.trim();
          if (transcript) {
            addMessage('user', transcript);
          }
        };
        recognition.onerror = (e: any) => {
          console.warn('Speech recognition error:', e.error);
          if (e.error !== 'aborted') {
            try { recognition.start(); } catch (_) {}
          }
        };
        recognition.onend = () => {
          // Restart if still in voice mode
          if (mode === 'voice' && isListening) {
            try { recognition.start(); } catch (_) {}
          }
        };
        recognition.start();
        speechRecognitionRef.current = recognition;
      }

      // Build voice system instruction (same flow but without extraction tags)
      const voiceSystemInstruction = `You are a friendly real estate assistant on a voice call. Talk like a real person — casual, warm, short sentences.

ABSOLUTE RULES:
- NEVER describe what you're doing internally. NEVER say things like "I've got the parameters locked down" or "I'm shifting focus" or "According to the process."
- NEVER use markdown formatting (no **, no ##, no bullet points).
- NEVER narrate your thought process or reasoning.
- Just say what you would actually say out loud to a person on the phone.
- Keep it to 1-3 short, natural sentences.

CURRENT STAGE: ${session.stage}
COLLECTED DATA: ${JSON.stringify(session)}
PROPERTY PORTFOLIO: ${JSON.stringify(PROPERTIES)}

WHAT TO SAY based on stage:
- intent: Figure out if they want to buy, rent, or sell. If unclear: "Sorry, I didn't catch that. Are you looking to buy, rent, or sell?" If clear: "Great! Which area are you targeting? And what's your approximate budget range?"
- core_needs: They told you area/budget. Say something like "Nice!" then ask "What's your timeline?"
- core_needs_timeline: They gave timeline. Then ask: for buy "Are you pre-approved for a mortgage, or paying cash?", for rent "How many bedrooms?", for sell "What's the zip code?"
- intent_specific: They answered. Pick 2 matching properties and say "Here are 2 quick options: 1. [Price] in [Location], has [feature]. 2. [Price] in [Location], has [feature]. Which one sounds better, 1 or 2?"
- value_exchange: They picked. Say "Great taste! Can I get your name?"
- lead_name: They gave name. Say "Thanks [Name]! What's your cell number so I can send you photos?"
- lead_phone: They gave number. Say "Got it! And your email?" If they refuse: "I totally get it, but I need a way to send the photos. How about just your number for now?"
- lead_email: They gave/skipped email. Say "Last thing — prefer a text or call from our agent? And what time works best?"
- handoff: They answered. Say "Perfect [Name]! Our agent will [text/call] you around [time]. Excited to help!"
- complete: Just chat naturally about properties.`;

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
            const parts = message.serverContent?.modelTurn?.parts || [];

            for (const part of parts) {
              // Handle audio playback
              if (part.inlineData?.data && outputAudioContextRef.current) {
                const ctx = outputAudioContextRef.current;
                nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
                const audioBuffer = await decodeAudioData(decode(part.inlineData.data), ctx, 24000, 1);
                const source = ctx.createBufferSource();
                source.buffer = audioBuffer;
                source.connect(ctx.destination);
                source.start(nextStartTimeRef.current);
                nextStartTimeRef.current += audioBuffer.duration;
                sourcesRef.current.add(source);
                source.onended = () => sourcesRef.current.delete(source);
              }

            }

            // When model turn is complete, get clean text via separate text call
            if (message.serverContent?.turnComplete) {
              (async () => {
                try {
                  const textAi = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
                  // Get recent messages for context
                  const recentMsgs = messages.slice(-10).map(m => ({
                    role: m.role as 'user' | 'model',
                    parts: [{ text: m.text }]
                  }));
                  const textResponse = await textAi.models.generateContent({
                    model: 'gemini-2.5-flash',
                    contents: recentMsgs.length > 0 ? recentMsgs : 'Hello',
                    config: {
                      systemInstruction: `You are a friendly real estate assistant. Based on the conversation so far, write ONLY what you would say next. Keep it short (1-3 sentences), casual, warm. No markdown, no internal reasoning. Just the spoken words.

PROPERTY PORTFOLIO: ${JSON.stringify(PROPERTIES)}
COLLECTED DATA: ${JSON.stringify(session)}`
                    }
                  });
                  const text = textResponse.text?.trim();
                  if (text) {
                    addMessage('model', text);
                  }
                } catch (err) {
                  console.error('Voice text transcription failed:', err);
                }
              })();
            }

            if (message.serverContent?.interrupted) stopAllAudio();
          },
          onerror: (e) => {
            console.error('Voice session error:', e);
            setIsConnecting(false);
            setIsListening(false);
          },
          onclose: () => {
            setIsListening(false);
            setIsConnecting(false);
          }
        },
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: voiceSystemInstruction,
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } }
        }
      });
      sessionRef.current = await sessionPromise;
    } catch (err) {
      console.error('Voice session start failed:', err);
      setIsConnecting(false);
      setMode('text');
    }
  };

  const stopVoiceSession = () => {
    // Stop speech recognition
    if (speechRecognitionRef.current) {
      try { speechRecognitionRef.current.stop(); } catch (_) {}
      speechRecognitionRef.current = null;
    }
    // Stop media stream
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }
    // Close Gemini session
    if (sessionRef.current) {
      sessionRef.current.close();
      sessionRef.current = null;
    }
    stopAllAudio();
    aiVoiceTextRef.current = '';
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

      // Build conversation history for context
      const history = messages.map(m => ({
        role: m.role as 'user' | 'model',
        parts: [{ text: m.text }]
      }));
      history.push({ role: 'user' as const, parts: [{ text: userText }] });

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: history,
        config: {
          tools: [{ googleMaps: {} }],
          systemInstruction: buildSystemInstruction(session)
        }
      });

      let fullText = response.text || "I apologize, I'm unable to process that at the moment.";
      const grounding = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];

      // Process extraction and get display text
      const updatedMessages = [...messages, {
        id: Math.random().toString(36).substr(2, 9),
        role: 'user' as const,
        text: userText,
        timestamp: new Date()
      }];
      const displayText = await processExtraction(fullText, updatedMessages);
      addMessage('model', displayText, grounding);
    } catch (error) {
      console.error('Text submit error:', error);
      addMessage('model', "I'm experiencing a minor connectivity interruption. Please try again.");
    } finally {
      setIsModelTyping(false);
    }
  };

  const handleClose = () => {
    stopVoiceSession();
    setIsOpen(false);
  };

  // Stage indicator for UI
  const getStageLabel = (): string => {
    const labels: Record<string, string> = {
      intent: 'Getting Started',
      core_needs: 'Understanding Needs',
      core_needs_timeline: 'Timeline',
      intent_specific: 'Details',
      value_exchange: 'Property Matching',
      lead_name: 'Almost There',
      lead_phone: 'Contact Info',
      lead_email: 'Contact Info',
      handoff: 'Scheduling',
      complete: 'Connected'
    };
    return labels[session.stage] || '';
  };

  return (
    <div className="fixed bottom-8 right-8 z-[60] flex flex-col items-end">
      {isOpen && (
        <div className="mb-4 w-[400px] h-[600px] bg-white rounded-3xl shadow-2xl flex flex-col overflow-hidden border border-slate-200 animate-in slide-in-from-bottom-4 duration-300">
          {/* Header */}
          <div className="bg-red-950 p-6 text-white flex justify-between items-center">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-red-600 rounded-xl flex items-center justify-center">
                <Icons.Chat />
              </div>
              <div>
                <h3 className="font-bold tracking-tight">AI Assistant</h3>
                {mode === 'voice' ? (
                  <p className="text-[10px] text-red-400 uppercase tracking-widest">Listening...</p>
                ) : (
                  <p className="text-[10px] text-red-300 uppercase tracking-widest">{getStageLabel()}</p>
                )}
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

          {/* Messages area */}
          <div className="flex-grow overflow-y-auto p-6 space-y-4 bg-slate-50">
            {messages.map((m) => (
              <div key={m.id} className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
                <div className={`max-w-[85%] p-4 rounded-2xl text-sm leading-relaxed shadow-sm ${m.role === 'user' ? 'bg-red-600 text-white rounded-tr-none' : 'bg-white text-slate-700 border border-slate-100 rounded-tl-none'}`}>
                  {m.text.split('\n').map((line, i) => (
                    <React.Fragment key={i}>
                      {i > 0 && <br />}
                      {line}
                    </React.Fragment>
                  ))}
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
            {isModelTyping && (
              <div className="flex gap-1 p-2">
                <div className="w-1 h-1 bg-red-400 rounded-full animate-bounce" />
                <div className="w-1 h-1 bg-red-400 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }} />
                <div className="w-1 h-1 bg-red-400 rounded-full animate-bounce" style={{ animationDelay: '0.4s' }} />
              </div>
            )}
            {mode === 'voice' && (
              <div className="flex flex-col items-center justify-center py-12 space-y-4">
                <div className="flex items-end gap-1.5 h-16">
                  {[...Array(7)].map((_, i) => <div key={i} className="w-1.5 bg-red-600 rounded-full animate-pulse" style={{ animationDelay: `${i * 0.1}s`, height: isListening ? `${24 + Math.random() * 40}px` : '6px' }} />)}
                </div>
                <p className="text-xs text-slate-500">Voice conversation is being transcribed below</p>
                <button onClick={stopVoiceSession} className="mt-6 bg-red-950 text-white px-8 py-3 rounded-xl text-sm font-bold shadow-lg hover:bg-red-600 transition-all active:scale-95">Return to Text</button>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Input area */}
          {mode === 'text' && (
            <div className="p-4 bg-white border-t border-slate-100">
              <form onSubmit={handleTextSubmit} className="flex gap-2 mb-2">
                <input type="text" value={inputText} onChange={(e) => setInputText(e.target.value)} placeholder="Type your message..." className="flex-grow bg-slate-100 border-none rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-red-600/20 transition-all" />
                <button type="submit" className="bg-red-600 text-white w-12 h-12 rounded-xl hover:bg-red-700 transition-all shadow-sm flex items-center justify-center flex-shrink-0" aria-label="Send message"><span className="rotate-90 inline-block transform scale-125"><Icons.Send /></span></button>
              </form>
              <div className="flex justify-between items-center px-1">
                <button type="button" onClick={startVoiceSession} className="flex items-center gap-1.5 text-red-600 text-[11px] font-bold hover:text-red-700 transition-colors"><Icons.Mic />Talk</button>
                <p className="text-[9px] text-slate-400 font-medium uppercase tracking-widest">EstatePro AI v3.0</p>
              </div>
            </div>
          )}
        </div>
      )}

      {!isOpen && (
        <button onClick={() => setIsOpen(true)} className="bg-red-950 text-white w-14 h-14 rounded-2xl shadow-2xl flex items-center justify-center hover:scale-105 transition-all active:scale-95 group relative border border-white/10">
          <Icons.Chat />
          <span className="absolute -top-12 right-0 bg-red-950 text-white px-4 py-2 rounded-xl text-xs font-bold whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity shadow-xl border border-white/10">AI Assistant</span>
        </button>
      )}
    </div>
  );
};

export default AIConcierge;

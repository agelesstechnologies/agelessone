import { useEffect, useRef, useState } from 'react';
import { Mic, Square } from 'lucide-react';

// Text field with a mic button: speak and the words are typed into the field (browser speech recognition).
type Recognition = {
  lang: string; continuous: boolean; interimResults: boolean; start(): void; stop(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onaudiostart: (() => void) | null; onsoundstart: (() => void) | null; onspeechstart: (() => void) | null; onend: (() => void) | null;
};
type RecognitionCtor = new () => Recognition;

export function VoiceInput({ id, name, placeholder, maxLength, required }: {
  id: string; name: string; placeholder?: string; maxLength?: number; required?: boolean;
}) {
  const [value, setValue] = useState('');
  const [listening, setListening] = useState(false);
  const [error, setError] = useState('');
  const rec = useRef<Recognition | null>(null);
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;

  useEffect(() => () => rec.current?.stop(), []);

  async function toggle() {
    if (listening) { rec.current?.stop(); return; }
    if (!Ctor) { setError('Voice input is not supported in this browser. Use Chrome or Edge.'); return; }
    setError('');
    // Ask for the microphone first so the browser shows its permission prompt.
    try { (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((t) => t.stop()); }
    catch { setError('Microphone access was blocked. Click the lock icon in the address bar and allow Microphone (needs https or localhost).'); return; }
    const base = value;
    let heard = false; let failed = false;
    const join = (text: string) => `${base}${base && !base.endsWith(' ') ? ' ' : ''}${text.trim()}`.slice(0, maxLength);
    const r = new Ctor();
    r.lang = 'en-IN'; r.continuous = true; r.interimResults = true;
    r.onresult = (e) => {
      let text = '';
      for (let i = 0; i < e.results.length; i++) text += e.results[i]![0].transcript;
      if (text) { heard = true; setValue(join(text)); }
    };
    r.onerror = (e) => {
      failed = true;
      setError(e.error === 'not-allowed' || e.error === 'service-not-allowed'
        ? 'Microphone access was blocked. Click the lock icon in the address bar and allow Microphone.'
        : e.error === 'no-speech' ? 'No speech heard. Tap Voice and try again.'
        : e.error === 'network' ? 'Voice typing needs an internet connection.'
        : e.error === 'audio-capture' ? 'No microphone found.' : `Voice input stopped (${e.error}). Try again.`);
    };
    let sound = false; let speech = false;
    r.onsoundstart = () => { sound = true; };
    r.onspeechstart = () => { speech = true; setError(''); };
    const timer = window.setTimeout(() => {
      if (heard || failed) return;
      setError(speech
        ? 'Your voice was heard but Chrome could not turn it into text. Voice typing needs internet access to Google speech servers (check VPN or firewall).'
        : sound ? 'Sound is coming in, but it is not clear speech. Speak closer to the microphone.'
        : 'Chrome cannot hear your microphone. Pick the right one in chrome://settings/content/microphone and check it is not muted.');
    }, 6000);
    r.onend = () => { window.clearTimeout(timer); setListening(false); if (!heard && !failed) setError('Did not catch anything. Tap Voice and speak after it says Listening.'); };
    rec.current = r;
    try { r.start(); setListening(true); } catch { setError('Could not start the microphone.'); }
  }

  return <>
    <span style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 }}>
      <input id={id} name={name} value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder}
        maxLength={maxLength} required={required} style={{ flex: 1, minWidth: 0, marginTop: 0 }} />
      <button type="button" className="outline-btn" onClick={toggle} aria-label={listening ? 'Stop voice input' : 'Speak instead of typing'}
        title={listening ? 'Stop' : 'Speak'} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: listening ? '#c0392b' : undefined }}>
        {listening ? <Square size={14} /> : <Mic size={14} />}{listening ? 'Listening…' : 'Voice'}</button>
    </span>
    {error && <small className="sub" role="alert">{error}</small>}
  </>;
}

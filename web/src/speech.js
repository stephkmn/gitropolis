// Browser voice in (Web Speech API, Chrome) and voice out (speechSynthesis).

let voice = null;
function pickVoice() {
  const voices = window.speechSynthesis?.getVoices() ?? [];
  const prefs = ["Google UK English Male", "Daniel", "Google US English", "Samantha", "Microsoft Guy", "Microsoft Aria"];
  voice = prefs.map((p) => voices.find((v) => v.name.includes(p))).find(Boolean)
    ?? voices.find((v) => v.lang?.startsWith("en")) ?? null;
}
if ("speechSynthesis" in window) {
  pickVoice();
  window.speechSynthesis.onvoiceschanged = pickVoice;
}

export let muted = false;
export const setMuted = (m) => { muted = m; if (m) window.speechSynthesis?.cancel(); };

// Resolves when speech ends. Has a timeout fallback because Chrome sometimes never fires onend.
export function speak(text) {
  const fallbackMs = 1200 + text.split(/\s+/).length * 380;
  if (muted || !("speechSynthesis" in window)) return new Promise((r) => setTimeout(r, fallbackMs));
  window.speechSynthesis.cancel();
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    if (voice) u.voice = voice;
    u.rate = 1.02;
    u.pitch = 0.95;
    const done = () => { clearTimeout(t); resolve(); };
    const t = setTimeout(done, fallbackMs + 4000);
    u.onend = done;
    u.onerror = done;
    window.speechSynthesis.speak(u);
  });
}

export const stopSpeaking = () => window.speechSynthesis?.cancel();

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
export const canListen = !!Recognition;

// Push-to-talk. Returns { stop } ; calls onText(finalTranscript) once.
export function listen({ onText, onInterim, onEnd }) {
  if (!Recognition) return null;
  const rec = new Recognition();
  rec.lang = "en-US";
  rec.interimResults = true;
  rec.continuous = true;
  let finalText = "";
  let latest = "";
  rec.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    latest = (finalText + interim).trim();
    onInterim?.(latest);
  };
  // Use interim text too: if the user releases the key early, Chrome may not have finalized yet.
  rec.onend = () => { onEnd?.(); if (latest) onText(latest); };
  rec.onerror = () => {};
  rec.start();
  return { stop: () => rec.stop() };
}

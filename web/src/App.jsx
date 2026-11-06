import { Component, useCallback, useEffect, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import Scene from "./Scene.jsx";
import { speak, stopSpeaking, listen, canListen, setMuted } from "./speech.js";

const API = (import.meta.env.VITE_API_URL || "http://localhost:8787").replace(/\/$/, "");
const DEFAULT_REPO = "excalidraw/excalidraw";
const slugOf = (repo) => repo.replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$|\/$/g, "").replace("/", "__").toLowerCase();
const baseName = (p) => p.split("/").pop().replace(/\.(tsx?|jsx?|mjs|cjs)$/, "");
// Must match normQuestion in server/answers.mjs (tolerates case, punctuation and spacing).
const normQuestion = (q) => String(q).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const SUGGESTIONS = {
  excalidraw__excalidraw: ["How does undo work?", "How is live collaboration end-to-end encrypted?", "How does text-to-diagram turn a prompt into a drawing?", "Which files are the riskiest to change?"],
};

async function post(path, body) {
  const r = await fetch(`${API}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({ error: `Server error ${r.status}` }));
  if (!r.ok || j.error) throw new Error(j.error || `Server error ${r.status}`);
  return j;
}

async function loadCity(repo) {
  const slug = slugOf(repo);
  // Pre-baked cities ship with the frontend: instant load, no cold server.
  const r = await fetch(`/cities/${slug}.json`).catch(() => null);
  if (r?.ok && r.headers.get("content-type")?.includes("json")) return r.json();
  return post("/api/city", { repoUrl: repo.includes("github.com") ? repo : `https://github.com/${repo}` });
}

// A render error inside the Canvas would otherwise unmount the whole app (blank screen).
class SceneBoundary extends Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error) { console.error(error); }
  render() {
    if (this.state.error) return <div className="loading">Couldn't draw this city: {this.state.error.message}</div>;
    return this.props.children;
  }
}

export default function App() {
  const [repo, setRepo] = useState(() => new URLSearchParams(location.search).get("repo") || DEFAULT_REPO);
  const [city, setCity] = useState(null);
  const [loading, setLoading] = useState("Surveying the land…");
  const [hover, setHover] = useState(null);
  const [selected, setSelected] = useState(null);
  const [tour, setTour] = useState(null); // { stops, active }
  const [busy, setBusy] = useState(false);
  const [caption, setCaption] = useState(null); // { title, text }
  const [question, setQuestion] = useState("");
  const [listening, setListening] = useState(false);
  const [muted, setMute] = useState(false);
  const [repoInput, setRepoInput] = useState("");
  const camera = useRef(null);
  const tourId = useRef(0);
  const rec = useRef(null);
  const frozenAnswers = useRef({});

  useEffect(() => {
    let cancelled = false;
    setLoading(`Surveying ${repo}…`);
    setCity(null); setTour(null); setSelected(null); setCaption(null);
    loadCity(repo)
      .then((c) => {
        if (!c.buildings.length) throw new Error("no JS/TS source files found. Try a different repository.");
        if (!cancelled) { setCity(c); setLoading(null); }
      })
      .catch((e) => !cancelled && setLoading(`Couldn't build this city: ${e.message}`));
    return () => { cancelled = true; };
  }, [repo]);

  // Frozen demo answers ship with the frontend (web/public/answers, made by server/freeze.mjs):
  // those questions play instantly and identically, without waking the server.
  useEffect(() => {
    frozenAnswers.current = {};
    if (!city) return;
    let cancelled = false;
    fetch(`/answers/${city.slug}.json`)
      .then((r) => (r.ok && r.headers.get("content-type")?.includes("json") ? r.json() : null))
      .then((d) => { if (!cancelled && d?.citySha === city.sha) frozenAnswers.current = d.answers ?? {}; })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [city]);

  const endTour = useCallback(() => {
    tourId.current++;
    stopSpeaking();
    setTour(null); setCaption(null); setBusy(false);
    camera.current?.overview();
  }, []);

  const ask = useCallback(async (q) => {
    q = q.trim();
    if (!q || !city) return;
    const id = ++tourId.current;
    const alive = () => id === tourId.current;
    stopSpeaking();
    setSelected(null); setTour(null); setBusy(true);
    setCaption({ title: "Scanning the city", text: `“${q}”` });
    camera.current?.overview();
    let res;
    const hit = frozenAnswers.current[normQuestion(q)];
    if (hit) {
      const index = new Map(city.buildings.map((b, i) => [b.path, i]));
      const stops = hit.stops.map((s) => ({ ...s, index: index.get(s.path) }));
      if (stops.every((s) => s.index !== undefined)) {
        res = { answer: hit.answer, stops };
        await new Promise((r) => setTimeout(r, 1500)); // keep the scanning beat; an instant cut looks canned
        if (!alive()) return;
      }
    }
    if (!res) try {
      res = await post("/api/ask", { slug: city.slug, question: q }).catch(async (e) => {
        if (!/Unknown city/.test(e.message)) throw e; // server restarted and forgot a live-loaded city
        await post("/api/city", { repoUrl: `https://github.com/${city.repo}` });
        return post("/api/ask", { slug: city.slug, question: q });
      });
    } catch (e) {
      if (alive()) { setBusy(false); setCaption({ title: "The city is silent", text: e.message }); }
      return;
    }
    if (!alive()) return;
    setBusy(false);
    if (!res.stops.length) { setCaption({ title: "Nothing found", text: res.answer }); speak(res.answer); return; }

    setTour({ stops: res.stops, active: null });
    setCaption({ title: q, text: res.answer });
    await speak(res.answer);
    let prev = null;
    for (const [k, s] of res.stops.entries()) {
      if (!alive()) return;
      const b = city.buildings[s.index];
      setTour({ stops: res.stops, active: s.index });
      setCaption({ title: `${k + 1}/${res.stops.length} · ${baseName(s.path)}`, text: s.why, path: s.path });
      await Promise.all([camera.current.hop(prev, b), speak(s.why)]);
      prev = b;
    }
    if (alive()) setCaption((c) => c && { ...c, done: true });
  }, [city]);

  // Push-to-talk: hold Space (outside text inputs)
  const startListening = useCallback(() => {
    if (!canListen || rec.current) return;
    stopSpeaking();
    setListening(true);
    rec.current = listen({
      onInterim: (t) => setQuestion(t),
      onText: (t) => { setQuestion(t); ask(t); },
      onEnd: () => { rec.current = null; setListening(false); },
    });
  }, [ask]);
  const stopListening = useCallback(() => rec.current?.stop(), []);
  useEffect(() => {
    const typing = (e) => ["INPUT", "TEXTAREA"].includes(e.target.tagName);
    const down = (e) => {
      if (e.code === "Space" && !typing(e) && !e.repeat) { e.preventDefault(); startListening(); }
      if (e.code === "Escape") endTour();
    };
    const up = (e) => { if (e.code === "Space" && !typing(e)) stopListening(); };
    addEventListener("keydown", down); addEventListener("keyup", up);
    return () => { removeEventListener("keydown", down); removeEventListener("keyup", up); };
  }, [startListening, stopListening, endTour]);

  const onSelect = useCallback((i) => {
    if (tour) return;
    setSelected(i);
    if (i != null && city) camera.current?.flyTo(city.buildings[i]);
  }, [tour, city]);

  const sel = selected != null && city ? city.buildings[selected] : null;
  const importedBy = sel ? city.buildings.filter((b) => b.imports.includes(selected)).length : 0;

  return (
    <div className="app">
      <SceneBoundary key={repo}>
      <Canvas
        camera={{ fov: 45, near: 0.5, far: 8000, position: [400, 400, 400] }}
        dpr={[1, 2]}
        gl={{ antialias: false, powerPreference: "high-performance" }}
        onPointerMissed={() => !tour && setSelected(null)}
      >
        {city && (
          <Scene city={city} hover={hover} setHover={setHover} selected={selected} onSelect={onSelect}
            tour={tour} busy={busy} apiRef={camera} />
        )}
      </Canvas>
      </SceneBoundary>

      <header className="top">
        <div className="brand">
          <div className="logo">GITROPOLIS</div>
          {city && (
            <div className="sub">
              <a href={`https://github.com/${city.repo}`} target="_blank" rel="noreferrer">{city.repo}</a>
              <span>{city.stats.files.toLocaleString()} buildings · {city.stats.loc.toLocaleString()} lines · {city.stats.edges.toLocaleString()} imports</span>
            </div>
          )}
        </div>
        <form className="repo-form" onSubmit={(e) => { e.preventDefault(); if (repoInput.trim()) { setRepo(repoInput.trim()); history.replaceState(null, "", `?repo=${encodeURIComponent(repoInput.trim())}`); } }}>
          <input value={repoInput} onChange={(e) => setRepoInput(e.target.value)} placeholder="github.com/owner/repo" spellCheck={false} />
          <button>Build city</button>
        </form>
      </header>

      {loading && <div className="loading"><div className="spinner" />{loading}</div>}

      {sel && !tour && (
        <aside className="panel">
          <div className="p-path">{sel.path}</div>
          <div className="p-stats">
            <div><b>{sel.loc.toLocaleString()}</b><span>lines</span></div>
            <div><b>{sel.churn}</b><span>commits / yr</span></div>
            <div><b className="cyan">{sel.imports.length}</b><span>imports</span></div>
            <div><b className="pink">{importedBy}</b><span>imported by</span></div>
          </div>
          {sel.exports.length > 0 && <div className="p-exports">{sel.exports.map((x) => <code key={x}>{x}</code>)}</div>}
          {sel.doc && <p className="p-doc">{sel.doc}</p>}
          <a className="p-link" href={`https://github.com/${city.repo}/blob/${city.sha}/${sel.path}`} target="_blank" rel="noreferrer">Open on GitHub ↗</a>
        </aside>
      )}

      {caption && (
        <div className={`caption ${busy ? "scanning" : ""}`}>
          <div className="c-title">{caption.title}</div>
          <div className="c-text">{caption.text}</div>
          {caption.path && <div className="c-path">{caption.path}</div>}
          {(tour || caption.done) && <button className="c-close" onClick={endTour}>End tour · Esc</button>}
        </div>
      )}

      {city && (
        <div className="askbar">
          {!tour && !busy && !question && SUGGESTIONS[city.slug] && (
            <div className="chips">{SUGGESTIONS[city.slug].map((s) => <button key={s} onClick={() => { setQuestion(s); ask(s); }}>{s}</button>)}</div>
          )}
          <form onSubmit={(e) => { e.preventDefault(); ask(question); }}>
            <button type="button" className={`mic ${listening ? "on" : ""}`} disabled={!canListen}
              onPointerDown={startListening} onPointerUp={stopListening} title={canListen ? "Hold to talk (or hold Space)" : "Voice needs Chrome"}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
            </button>
            <input value={question} onChange={(e) => setQuestion(e.target.value)}
              placeholder={listening ? "Listening…" : "Ask the city…  (hold Space to talk)"} />
            <button className="go" disabled={busy}>{busy ? "…" : "Ask"}</button>
            <button type="button" className="mute" onClick={() => { setMuted(!muted); setMute(!muted); }} title={muted ? "Narration off" : "Narration on"}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 9v6h4l5 4V5L8 9H4z" />{muted ? <path d="M17 9l5 6M22 9l-5 6" /> : <path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" />}</svg>
            </button>
          </form>
        </div>
      )}

      <div className="legend">
        <div className="ramp" />
        <div className="ramp-labels"><span>quiet</span><span>commits in the last year</span><span>hot</span></div>
        <div className="legend-row"><i className="sw cyan" />imports <i className="sw pink" />imported by <span className="dim">· height = lines of code</span></div>
      </div>
    </div>
  );
}

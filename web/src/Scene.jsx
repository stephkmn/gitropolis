import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { CameraControls, Html, QuadraticBezierLine, Edges } from "@react-three/drei";
import { EffectComposer, Bloom, Vignette } from "@react-three/postprocessing";

// One shared unit box with its base at y=0, so scale.y = building height.
const unitBox = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
const baseName = (p) => p.split("/").pop();

// Churn heat ramp: cold steel blue -> amber -> hot red.
const COLD = new THREE.Color("#2c4266"), WARM = new THREE.Color("#e8a33d"), HOT = new THREE.Color("#ff3b2f");
const NO_CHURN = new THREE.Color("#25344f");
export function heat(b, out = new THREE.Color()) {
  if (b.churn === 0) return out.copy(NO_CHURN);
  const t = b.churnPct ** 1.6; // ease: most files stay cool, the top few burn
  return t < 0.6 ? out.copy(COLD).lerp(WARM, t / 0.6) : out.copy(WARM).lerp(HOT, (t - 0.6) / 0.4);
}

function Buildings({ city, focus, onHover, onSelect }) {
  const ref = useRef();
  const n = city.buildings.length;
  useLayoutEffect(() => {
    const m = new THREE.Matrix4(), q = new THREE.Quaternion();
    city.buildings.forEach((b, i) => {
      m.compose(new THREE.Vector3(b.x, b.y, b.z), q, new THREE.Vector3(Math.max(0.5, b.w * 0.92), Math.max(0.5, b.h), Math.max(0.5, b.d * 0.92)));
      ref.current.setMatrixAt(i, m);
    });
    ref.current.instanceMatrix.needsUpdate = true;
    ref.current.computeBoundingSphere();
  }, [city]);
  useLayoutEffect(() => {
    const c = new THREE.Color();
    city.buildings.forEach((b, i) => {
      heat(b, c);
      if (focus.size && !focus.has(i)) c.multiplyScalar(0.28); // dim everything not in the tour
      ref.current.setColorAt(i, c);
    });
    ref.current.instanceColor.needsUpdate = true;
  }, [city, focus]);
  return (
    <instancedMesh
      key={city.slug}
      ref={ref}
      args={[unitBox, undefined, n]}
      onPointerMove={(e) => { e.stopPropagation(); onHover(e.instanceId); }}
      onPointerOut={() => onHover(null)}
      onClick={(e) => { e.stopPropagation(); onSelect(e.instanceId); }}
    >
      <meshStandardMaterial roughness={0.6} metalness={0.15} />
    </instancedMesh>
  );
}

// Glowing roof caps on the top 5% churn files (bloom picks them up).
function HotRoofs({ city }) {
  const ref = useRef();
  const hot = useMemo(() => city.buildings.filter((b) => b.churn > 0 && b.churnPct >= 0.95), [city]);
  useLayoutEffect(() => {
    const m = new THREE.Matrix4(), q = new THREE.Quaternion();
    hot.forEach((b, i) => {
      m.compose(new THREE.Vector3(b.x, b.y + b.h, b.z), q, new THREE.Vector3(b.w * 0.94, 0.5, b.d * 0.94));
      ref.current.setMatrixAt(i, m);
    });
    ref.current.instanceMatrix.needsUpdate = true;
  }, [hot]);
  if (!hot.length) return null;
  return (
    <instancedMesh key={city.slug + "-hot"} ref={ref} args={[unitBox, undefined, hot.length]} raycast={() => null}>
      <meshBasicMaterial color={[5, 1.1, 0.4]} toneMapped={false} />
    </instancedMesh>
  );
}

function Districts({ city }) {
  const ref = useRef();
  useLayoutEffect(() => {
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), c = new THREE.Color();
    city.districts.forEach((d, i) => {
      m.compose(new THREE.Vector3(d.x, d.y, d.z), q, new THREE.Vector3(d.w, d.t, d.d));
      ref.current.setMatrixAt(i, m);
      ref.current.setColorAt(i, c.setHSL(0.62, 0.35, 0.09 + Math.min(d.depth, 6) * 0.025));
    });
    ref.current.instanceMatrix.needsUpdate = true;
    ref.current.instanceColor.needsUpdate = true;
  }, [city]);
  return (
    <instancedMesh key={city.slug + "-d"} ref={ref} args={[unitBox, undefined, city.districts.length]} raycast={() => null}>
      <meshStandardMaterial roughness={0.9} />
    </instancedMesh>
  );
}

function DistrictLabels({ city }) {
  const labels = useMemo(() => {
    const minArea = (city.size * city.size) / 60;
    return city.districts.filter((d) => d.depth <= 2 && d.w * d.d > minArea);
  }, [city]);
  return labels.map((d) => (
    <Html key={d.path} position={[d.x, d.y + d.t + 0.2, d.z + d.d / 2 - 2]} center zIndexRange={[10, 0]} style={{ pointerEvents: "none" }}>
      <div className={`dlabel depth${d.depth}`}>{d.name}</div>
    </Html>
  ));
}

function Landmark({ city }) {
  const b = useMemo(() => city.buildings.reduce((a, c) => (c.loc > a.loc ? c : a)), [city]);
  return (
    <Html position={[b.x, b.y + b.h + 6, b.z]} center zIndexRange={[20, 10]} style={{ pointerEvents: "none" }}>
      <div className="landmark">
        <div className="lm-kicker">{b.loc >= 3000 ? "THE GOD COMPONENT" : "TALLEST TOWER"}</div>
        <div className="lm-name">{baseName(b.path)}</div>
        <div className="lm-meta">{b.loc.toLocaleString()} lines · {b.churn} commits this year</div>
      </div>
    </Html>
  );
}

function Focus({ city, indices, active }) {
  const group = useRef();
  useFrame(({ clock }) => {
    if (!group.current) return;
    const s = 1 + Math.sin(clock.elapsedTime * 4) * 0.04;
    group.current.children.forEach((c) => c.userData.active && c.scale.set(c.userData.w * s, c.userData.h * s, c.userData.d * s));
  });
  return (
    <group ref={group}>
      {indices.map((i) => {
        const b = city.buildings[i];
        const isActive = i === active;
        const w = b.w * 1.05, h = b.h * 1.03, d = b.d * 1.05;
        return (
          <mesh key={i} position={[b.x, b.y, b.z]} scale={[w, h, d]} geometry={unitBox} raycast={() => null} userData={{ active: isActive, w, h, d }}>
            <meshBasicMaterial color={isActive ? [0.4, 2.6, 3.2] : [0.3, 1.2, 1.6]} transparent opacity={isActive ? 0.35 : 0.18} toneMapped={false} depthWrite={false} />
            <Edges color={isActive ? "#9ff4ff" : "#4fb8d6"} />
          </mesh>
        );
      })}
    </group>
  );
}

function Bridges({ city, index, incoming }) {
  const b = city.buildings[index];
  const lines = useMemo(() => {
    const top = (x) => [x.x, x.y + x.h, x.z];
    const arc = (a, c, color) => {
      const dist = Math.hypot(a.x - c.x, a.z - c.z);
      const mid = [(a.x + c.x) / 2, Math.max(a.y + a.h, c.y + c.h) + 6 + dist * 0.35, (a.z + c.z) / 2];
      return { start: top(a), end: top(c), mid, color };
    };
    const out = b.imports.slice(0, 60).map((j) => arc(b, city.buildings[j], "#46e3ff"));
    const inc = (incoming[index] ?? []).slice(0, 60).map((j) => arc(city.buildings[j], b, "#ff4fd8"));
    return [...out, ...inc];
  }, [city, index, incoming, b]);
  return lines.map((l, k) => (
    <QuadraticBezierLine key={k} start={l.start} end={l.end} mid={l.mid} color={l.color} lineWidth={1.6} transparent opacity={0.85} toneMapped={false} />
  ));
}

function ScanRing({ size, active }) {
  const ref = useRef();
  useFrame(({ clock }) => {
    if (!ref.current) return;
    ref.current.visible = active;
    const t = (clock.elapsedTime * 0.6) % 1;
    const r = 4 + t * size * 0.75;
    ref.current.scale.set(r, r, 1);
    ref.current.material.opacity = 0.9 * (1 - t);
  });
  return (
    <mesh ref={ref} rotation-x={-Math.PI / 2} position-y={0.3} raycast={() => null}>
      <ringGeometry args={[0.97, 1, 128]} />
      <meshBasicMaterial color={[0.5, 2.5, 3]} transparent toneMapped={false} depthWrite={false} />
    </mesh>
  );
}

function Tooltip({ city, index }) {
  const b = city.buildings[index];
  return (
    <Html position={[b.x, b.y + b.h + 1, b.z]} center zIndexRange={[30, 20]} style={{ pointerEvents: "none" }}>
      <div className="tooltip">
        <div className="tt-name">{baseName(b.path)}</div>
        <div className="tt-meta">{b.loc.toLocaleString()} lines · {b.churn} commits/yr</div>
      </div>
    </Html>
  );
}

// Camera API exposed to App: overview(), flyTo(b), hop(from, to)
function Rig({ city, apiRef, busy }) {
  const cc = useRef();
  const lastInput = useRef(0);
  const S = city.size;
  useEffect(() => {
    const c = cc.current;
    const view = (px, py, pz, tx, ty, tz) => c.setLookAt(px, py, pz, tx, ty, tz, true);
    const focusPose = (b) => {
      const r = Math.max(b.h * 1.6, Math.max(b.w, b.d) * 3.5, 55);
      const ty = b.y + b.h * 0.6;
      // Steep angle so taller neighbours don't block the view.
      return [b.x + r * 0.55, ty + r * 0.9, b.z + r * 0.7, b.x, ty, b.z];
    };
    apiRef.current = {
      overview: () => view(S * 0.62, S * 0.62, S * 0.95, 0, S * 0.06, 0),
      flyTo: (b) => view(...focusPose(b)),
      // Pull up to an aerial view between two stops, then dive in: reads as "travel" on video.
      hop: async (a, b) => {
        if (a) {
          const dist = Math.hypot(a.x - b.x, a.z - b.z);
          const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
          const alt = Math.max(70, dist * 0.9, b.h * 1.6);
          await view(mx + alt * 0.35, alt, mz + alt * 0.6, mx, 0, mz);
        }
        await view(...focusPose(b));
      },
      touch: () => (lastInput.current = performance.now()),
    };
    // Intro: start high and far, then sweep into the overview.
    c.setLookAt(-S * 0.9, S * 1.4, S * 1.6, 0, 0, 0, false);
    const t = setTimeout(() => apiRef.current.overview(), 300);
    const onStart = () => (lastInput.current = performance.now());
    c.addEventListener("controlstart", onStart);
    return () => { clearTimeout(t); c.removeEventListener("controlstart", onStart); };
  }, [city, apiRef, S]);
  // Slow idle orbit after 8s without input: makes the thumbnail/video loop alive.
  useFrame((_, dt) => {
    if (!busy && performance.now() - lastInput.current > 8000) cc.current?.rotate(dt * 0.04, 0, false);
  });
  return (
    <CameraControls ref={cc} makeDefault smoothTime={0.9} minDistance={8} maxDistance={S * 3} maxPolarAngle={Math.PI * 0.47} dollyToCursor />
  );
}

export default function Scene({ city, hover, setHover, selected, onSelect, tour, busy, apiRef }) {
  const incoming = useMemo(() => {
    const inc = {};
    city.buildings.forEach((b, i) => b.imports.forEach((j) => (inc[j] ??= []).push(i)));
    return inc;
  }, [city]);
  const focus = useMemo(() => new Set(tour?.stops.map((s) => s.index) ?? []), [tour]);
  const bridgeFor = tour?.active ?? selected;
  return (
    <>
      <color attach="background" args={["#060a14"]} />
      <fog attach="fog" args={["#060a14", city.size * 0.9, city.size * 3.2]} />
      <hemisphereLight args={["#9fb7ff", "#0a0f1e", 0.9]} />
      <directionalLight position={[city.size, city.size * 1.5, city.size * 0.6]} intensity={1.6} />
      <mesh rotation-x={-Math.PI / 2} position-y={-0.02} raycast={() => null}>
        <planeGeometry args={[city.size * 8, city.size * 8]} />
        <meshStandardMaterial color="#0a1020" roughness={1} />
      </mesh>
      <gridHelper args={[city.size * 4, 80, "#16223d", "#101a30"]} position-y={0.01} />
      <Districts city={city} />
      <Buildings city={city} focus={focus} onHover={setHover} onSelect={onSelect} />
      {!tour && <HotRoofs city={city} />}
      <DistrictLabels city={city} />
      {!tour && <Landmark city={city} />}
      {tour && <Focus city={city} indices={[...focus]} active={tour.active} />}
      {selected != null && !tour && <Focus city={city} indices={[selected]} active={selected} />}
      {bridgeFor != null && <Bridges city={city} index={bridgeFor} incoming={incoming} />}
      {hover != null && <Tooltip city={city} index={hover} />}
      <ScanRing size={city.size} active={busy} />
      <Rig city={city} apiRef={apiRef} busy={busy || !!tour} />
      <EffectComposer multisampling={0}>
        <Bloom mipmapBlur luminanceThreshold={1} intensity={1.1} radius={0.7} />
        <Vignette offset={0.3} darkness={0.7} />
      </EffectComposer>
    </>
  );
}

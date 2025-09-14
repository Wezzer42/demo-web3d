// src/app/p/[slug]/ViewerClient.tsx
"use client";

import * as React from "react";
import * as THREE from "three";
import type { ThreeEvent } from "@react-three/fiber";
import { Canvas, useFrame, useLoader, useThree } from "@react-three/fiber";
import { Environment, OrbitControls, ContactShadows } from "@react-three/drei";
import { GLTFLoader, GLTF, KTX2Loader, MeshoptDecoder } from "three-stdlib";
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from "three-mesh-bvh";
import type { ModelItem } from "@/data/models";

/* -------------------------------------------------------------
   three-mesh-bvh integration (faster raycasting on complex meshes)
------------------------------------------------------------- */
THREE.Mesh.prototype.raycast = acceleratedRaycast as unknown as typeof THREE.Mesh.prototype.raycast;
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;

/* --------------------------- Types --------------------------- */
type LightType = "ambient" | "directional" | "point" | "hemisphere";
type LightDef = {
  id: string;
  type: LightType;
  color: string;
  intensity: number;
  position?: [number, number, number];
};

const ENV_PRESETS = [
  "city",
  "sunset",
  "dawn",
  "night",
  "apartment",
  "studio",
  "forest",
  "warehouse",
  "park",
  "lobby"
] as const;
type EnvPreset = (typeof ENV_PRESETS)[number];

type Stats = { fps: number; calls: number; renderer: string; dpr: number };
type ExplodeCache = { base: THREE.Vector3; dir: THREE.Vector3 };

/* ------------------------ Type guards ------------------------ */
const isMesh = (o: THREE.Object3D): o is THREE.Mesh => (o as THREE.Mesh).isMesh === true;
const isInstanced = (o: THREE.Object3D): o is THREE.InstancedMesh =>
  (o as THREE.InstancedMesh).isInstancedMesh === true;
const isSkinned = (o: THREE.Object3D): o is THREE.SkinnedMesh =>
  (o as THREE.SkinnedMesh).isSkinnedMesh === true;

/* -------------------------------------------------------------
   Geometry helpers (copy ALL attributes, safe for PBR + skinning)
------------------------------------------------------------- */

/** Build a sub-geometry from a group range, copying ALL attributes (position, normal, uv, uv2, color, tangent, skinIndex, skinWeight, etc.). */
function createSubGeometryFromGroup(
  geom: THREE.BufferGeometry,
  groupRange: { start: number; count: number }
): THREE.BufferGeometry {
  const indexAttr = geom.getIndex();
  const srcVertexIdx: number[] = indexAttr
    ? Array.from((indexAttr.array as ArrayLike<number>).slice(groupRange.start, groupRange.start + groupRange.count))
    : Array.from({ length: groupRange.count }, (_, i) => groupRange.start + i);

  const remap = new Map<number, number>();
  const newIndices: number[] = [];
  for (const oi of srcVertexIdx) {
    let ni = remap.get(oi);
    if (ni === undefined) {
      ni = remap.size;
      remap.set(oi, ni);
    }
    newIndices.push(ni);
  }
  const vertCount = remap.size;

  const oldByNew: number[] = [];
  remap.forEach((ni, oi) => {
    oldByNew[ni] = oi;
  });

  const dst = new THREE.BufferGeometry();
  const attrs = geom.attributes as Record<string, THREE.BufferAttribute>;

  for (const name of Object.keys(attrs)) {
    const a = attrs[name];
    if (!a?.isBufferAttribute) continue;
    const itemSize = a.itemSize;
    const out = new Float32Array(vertCount * itemSize);
    for (let ni = 0; ni < vertCount; ni++) {
      const oi = oldByNew[ni];
      for (let k = 0; k < itemSize; k++) {
        out[ni * itemSize + k] = (a.array as unknown as number[])[oi * itemSize + k];
      }
    }
    dst.setAttribute(name, new THREE.BufferAttribute(out, itemSize));
  }

  const idxArray = vertCount > 65535 ? new Uint32Array(newIndices) : new Uint16Array(newIndices);
  dst.setIndex(new THREE.BufferAttribute(idxArray, 1));
  dst.computeBoundingBox();
  dst.computeBoundingSphere();
  return dst;
}

/** Split a SkinnedMesh by geometry.groups into multiple SkinnedMesh, all bound to the same Skeleton. */
function splitSkinnedByGroups(skinned: THREE.SkinnedMesh): THREE.SkinnedMesh[] {
  const geom = skinned.geometry as THREE.BufferGeometry;
  const groups = geom.groups ?? [];
  if (!groups.length) return [skinned];

  const mats = Array.isArray(skinned.material) ? skinned.material : [skinned.material];
  const parts: THREE.SkinnedMesh[] = [];

  for (const g of groups) {
    const sub = createSubGeometryFromGroup(geom, { start: g.start, count: g.count });
    const mat = mats[g.materialIndex ?? 0] ?? mats[0];
    const m = new THREE.SkinnedMesh(sub, mat);
    m.castShadow = true;
    m.receiveShadow = true;
    m.position.copy(skinned.position);
    m.quaternion.copy(skinned.quaternion);
    m.scale.copy(skinned.scale);
    m.bind(skinned.skeleton, skinned.bindMatrix.clone());
    parts.push(m);
  }
  return parts;
}

/** Split a non-skinned geometry into up to 8 parts by triangle centroid octants (relative to bbox center). */
function splitByOctants(src: THREE.BufferGeometry): THREE.BufferGeometry[] {
  src.computeBoundingBox();
  const center = src.boundingBox ? src.boundingBox.getCenter(new THREE.Vector3()) : new THREE.Vector3();

  const index = src.getIndex();
  const pos = src.getAttribute("position") as THREE.BufferAttribute;
  const triCount = index ? index.count / 3 : pos.count / 3;

  const buckets: number[][] = Array.from({ length: 8 }, () => []);

  for (let t = 0; t < triCount; t++) {
    const i0 = index ? index.getX(3 * t) : 3 * t;
    const i1 = index ? index.getX(3 * t + 1) : 3 * t + 1;
    const i2 = index ? index.getX(3 * t + 2) : 3 * t + 2;

    const cx = (pos.getX(i0) + pos.getX(i1) + pos.getX(i2)) / 3;
    const cy = (pos.getY(i0) + pos.getY(i1) + pos.getY(i2)) / 3;
    const cz = (pos.getZ(i0) + pos.getZ(i1) + pos.getZ(i2)) / 3;

    const ox = cx >= center.x ? 1 : 0;
    const oy = cy >= center.y ? 1 : 0;
    const oz = cz >= center.z ? 1 : 0;
    const id = (ox << 2) | (oy << 1) | oz; // 0..7

    buckets[id].push(i0, i1, i2);
  }

  return buckets.filter((b) => b.length).map((b) => {
    // Reuse the generic builder that copies ALL attributes
    const geom = new THREE.BufferGeometry();
    // Convert triangle vertex indices into a flat vertex index list
    // createSubGeometryFromGroup expects a contiguous slice; for buckets we mimic by custom copier:
    return createSubGeometryFromIndices(src, b);
  });
}

/** Generic sub-geometry builder from an explicit vertex index list (copies ALL attributes). */
function createSubGeometryFromIndices(original: THREE.BufferGeometry, vertexIndices: number[]): THREE.BufferGeometry {
  const attrs = original.attributes as Record<string, THREE.BufferAttribute>;
  const remap = new Map<number, number>();
  const newIndices: number[] = [];

  for (const oi of vertexIndices) {
    let ni = remap.get(oi);
    if (ni === undefined) {
      ni = remap.size;
      remap.set(oi, ni);
    }
    newIndices.push(ni);
  }
  const vertCount = remap.size;

  const oldByNew: number[] = [];
  remap.forEach((ni, oi) => {
    oldByNew[ni] = oi;
  });

  const dst = new THREE.BufferGeometry();

  for (const name of Object.keys(attrs)) {
    const a = attrs[name];
    if (!a?.isBufferAttribute) continue;
    const itemSize = a.itemSize;
    const out = new Float32Array(vertCount * itemSize);
    for (let ni = 0; ni < vertCount; ni++) {
      const oi = oldByNew[ni];
      for (let k = 0; k < itemSize; k++) {
        out[ni * itemSize + k] = (a.array as unknown as number[])[oi * itemSize + k];
      }
    }
    dst.setAttribute(name, new THREE.BufferAttribute(out, itemSize));
  }

  const idxArray = vertCount > 65535 ? new Uint32Array(newIndices) : new Uint16Array(newIndices);
  dst.setIndex(new THREE.BufferAttribute(idxArray, 1));
  dst.computeBoundingBox();
  dst.computeBoundingSphere();
  return dst;
}

/* -------------------------------------------------------------
   Explode logic
   - Parent-local directions
   - Distance scales by scene radius
   - One-time preparation (split skinned by groups; split single-mesh by groups or octants)
------------------------------------------------------------- */

function applyExplodeOffset(mesh: THREE.Mesh, rootCenterWorld: THREE.Vector3, dist: number) {
  const parent = mesh.parent ?? mesh;
  const box = new THREE.Box3().setFromObject(mesh);
  const meshCenterWorld = box.getCenter(new THREE.Vector3());
  const meshCenterLocal = parent.worldToLocal(meshCenterWorld.clone());
  const rootCenterLocal = parent.worldToLocal(rootCenterWorld.clone());

  const dir = meshCenterLocal.sub(rootCenterLocal);
  if (dir.lengthSq() < 1e-12) dir.set(0, 1, 0);
  dir.normalize();

  const uc = mesh.userData as { __explode?: ExplodeCache };
  if (!uc.__explode) {
    uc.__explode = { base: mesh.position.clone(), dir: dir.clone() };
  } else {
    uc.__explode.dir.copy(dir);
  }

  mesh.position.copy(uc.__explode.base).addScaledVector(uc.__explode.dir, dist);
  mesh.updateMatrixWorld();
}

function createExplodeEffect(root: THREE.Group, k: number) {
  // Distance scaled by scene radius
  const rootBox = new THREE.Box3().setFromObject(root);
  const rootCenterWorld = rootBox.getCenter(new THREE.Vector3());
  const rootRadius = rootBox.getSize(new THREE.Vector3()).length() * 0.5;
  const dist = k * rootRadius; // k in 0..1

  // One-time preparation: split meshes as needed
  const preparedFlag = (root.userData as { __prepared?: boolean }).__prepared;
  if (!preparedFlag) {
    const toAdd: { parent: THREE.Object3D; parts: THREE.Object3D[]; remove: THREE.Object3D }[] = [];

    root.traverse((o) => {
      // Skinned: split by geometry.groups into multiple SkinnedMesh
      if (isSkinned(o)) {
        const sk = o as THREE.SkinnedMesh;
        const groups = (sk.geometry as THREE.BufferGeometry).groups ?? [];
        if (groups.length > 1 && sk.parent) {
          const parts = splitSkinnedByGroups(sk);
          toAdd.push({ parent: sk.parent, parts, remove: sk });
        }
        return;
      }

      // Non-skinned single mesh with no groups: optional octant split for demo visibility
      if (isMesh(o) && !isInstanced(o)) {
        const m = o as THREE.Mesh;
        const geom = m.geometry as THREE.BufferGeometry;
        const groups = geom.groups ?? [];
        if (groups.length <= 1 && m.parent) {
          const subs = splitByOctants(geom);
          if (subs.length > 1) {
            const parts = subs.map((g) => {
              const child = new THREE.Mesh(g, m.material);
              child.castShadow = true;
              child.receiveShadow = true;
              child.position.copy(m.position);
              child.quaternion.copy(m.quaternion);
              child.scale.copy(m.scale);
              return child;
            });
            toAdd.push({ parent: m.parent, parts, remove: m });
          }
        }
      }
    });

    for (const op of toAdd) {
      op.parent.remove(op.remove);
      op.parts.forEach((p) => op.parent.add(p));
    }
    (root.userData as { __prepared?: boolean }).__prepared = true;
  }

  // Apply offsets to every mesh
  const all: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) all.push(m);
  });

  for (const m of all) applyExplodeOffset(m, rootCenterWorld, dist);
}

/* -------------------------------------------------------------
   Explode capability detector (to disable UI when it’s pointless)
------------------------------------------------------------- */
function getExplodeCapability(root: THREE.Object3D) {
  let meshCount = 0;
  let groupSum = 0;
  let hasSkinnedWithGroups = false;
  let hasOnlySkinnedSinglePrimitive = false;

  root.traverse((o) => {
    if (isSkinned(o)) {
      const groups = (o.geometry as THREE.BufferGeometry).groups ?? [];
      if (groups.length > 1) hasSkinnedWithGroups = true;
      else hasOnlySkinnedSinglePrimitive = true;
    }
    if (isMesh(o)) {
      meshCount++;
      groupSum += (o.geometry as THREE.BufferGeometry).groups?.length ?? 0;
    }
  });

  // Can explode if: multiple meshes OR any geometry has groups OR skinned has groups
  const can = meshCount > 1 || groupSum > 1 || hasSkinnedWithGroups;
  const reason = can ? "" : hasOnlySkinnedSinglePrimitive ? "skinned-single-primitive" : "single-primitive";
  return { canExplode: can, reason };
}

/* ============================================================
   ExplodableModel
   - Loads model, enables BVH & shadows
   - Explode distance scales with scene size
   - One-time split where applicable
============================================================ */
function ExplodableModel({
  url,
  settings,
  k,
  onExplodeDetect
}: {
  url: string;
  settings?: ModelItem["settings"];
  k: number; // 0..1
  onExplodeDetect: (can: boolean) => void;
}) {
  const { gl } = useThree();
  const gltf = useLoader(
    GLTFLoader,
    url,
    (loader) => {
      const ktx2 = new KTX2Loader().setTranscoderPath("/basis/").detectSupport(gl);
      (loader as GLTFLoader).setKTX2Loader(ktx2);
      (loader as GLTFLoader).setMeshoptDecoder(MeshoptDecoder);
    }
  ) as GLTF;

  const root = React.useMemo<THREE.Group>(() => gltf.scene.clone(true), [gltf.scene]);

  // Normalize pose and ensure world matrices are up to date
  React.useEffect(() => {
    if (settings?.yUp === false) root.rotateX(-Math.PI / 2);
    root.scale.setScalar(settings?.scale ?? 1);
    root.updateWorldMatrix(true, true);
  }, [root, settings]);

  // BVH + shadows
  React.useEffect(() => {
    root.traverse((obj) => {
      if (!isMesh(obj)) return;
      obj.geometry.computeBoundsTree?.();
      obj.castShadow = true;
      obj.receiveShadow = true;
    });
    return () => {
      root.traverse((obj) => {
        if (isMesh(obj)) obj.geometry.disposeBoundsTree?.();
      });
    };
  }, [root]);

  // Detect capability once model is ready
  React.useEffect(() => {
    const { canExplode } = getExplodeCapability(root);
    onExplodeDetect(canExplode);
  }, [root, onExplodeDetect]);

  // Apply explode (idempotent; preparation happens only once)
  React.useEffect(() => {
    createExplodeEffect(root, k);
  }, [root, k]);

  const onPointerDown = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
  };
  return <primitive object={root} onPointerDown={onPointerDown} />;
}

/* ---------------------- Stats collector ---------------------- */
function StatsCollector({ onStats, exposure }: { onStats: (s: Stats) => void; exposure: number }) {
  const { gl } = useThree();
  const last = React.useRef(performance.now());
  const frames = React.useRef(0);
  useFrame(() => {
    frames.current += 1;
    const now = performance.now();
    gl.toneMappingExposure = exposure;
    if (now - last.current >= 1000) {
      onStats({
        fps: frames.current,
        calls: gl.info.render.calls,
        renderer: gl.capabilities.isWebGL2 ? "WebGL2" : "WebGL",
        dpr: Math.round(window.devicePixelRatio * 10) / 10
      });
      frames.current = 0;
      last.current = now;
    }
  });
  return null;
}

/* ---------------------- Fixed control panel ---------------------- */
function ControlPanel({
  stats,
  k,
  setK,
  canExplode,
  envPreset,
  setEnvPreset,
  exposure,
  setExposure,
  lights,
  setLights
}: {
  stats: Stats;
  k: number;
  setK: (v: number) => void;
  canExplode: boolean;
  envPreset: EnvPreset;
  setEnvPreset: (v: EnvPreset) => void;
  exposure: number;
  setExposure: (v: number) => void;
  lights: LightDef[];
  setLights: React.Dispatch<React.SetStateAction<LightDef[]>>;
}) {
  const [sel, setSel] = React.useState<string | null>(lights[0]?.id ?? null);
  const selected = lights.find((l) => l.id === sel) ?? null;

  const upd = (patch: Partial<LightDef>) => {
    if (!selected) return;
    setLights((ls) => ls.map((l) => (l.id === selected.id ? { ...l, ...patch } : l)));
  };
  const updPos = (idx: 0 | 1 | 2, v: number) => {
    if (!selected) return;
    const pos = selected.position ?? [0, 0, 0];
    const np: [number, number, number] = [pos[0], pos[1], pos[2]];
    np[idx] = v;
    upd({ position: np });
  };
  const addLight = (type: LightType) => {
    const id = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Date.now());
    const base: LightDef = {
      id,
      type,
      color: "#ffffff",
      intensity: type === "ambient" ? 0.35 : 1.6,
      position: type === "directional" || type === "point" ? [4, 6, 4] : undefined
    };
    setLights((ls) => [...ls, base]);
    setSel(id);
  };
  const delLight = () => {
    if (!selected) return;
    setLights((ls) => ls.filter((l) => l.id !== selected.id));
    setSel(null);
  };

  return (
    <aside
      style={{
        position: "fixed",
        right: 16,
        top: 16,
        width: 340,
        zIndex: 50,
        background: "rgba(13,16,22,0.9)",
        backdropFilter: "blur(6px)",
        border: "1px solid #2b2f3a",
        borderRadius: 12,
        color: "#fff",
        padding: 12,
        fontFamily: "ui-monospace,monospace"
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
        <b>Controls</b>
        <span style={{ fontSize: 12, color: "#9aa4b2" }}>
          {stats.renderer} · DPR {stats.dpr} · FPS {stats.fps} · Calls {stats.calls}
        </span>
      </div>

      {/* Explode slider (disabled if not applicable) */}
      <label style={{ display: "grid", gridTemplateColumns: "90px 1fr", gap: 8, alignItems: "center" }}>
        <span>Explode</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={k}
          onChange={(e) => setK(parseFloat(e.target.value))}
          disabled={!canExplode}
          style={{ accentColor: "#1b88ff" }}
        />
      </label>
      {!canExplode && (
        <div style={{ marginTop: 4, fontSize: 11, color: "#9aa4b2" }}>
          Explode is unavailable for this model.
        </div>
      )}

      {/* Exposure and environment */}
      <label
        style={{ display: "grid", gridTemplateColumns: "90px 1fr", gap: 8, alignItems: "center", marginTop: 8 }}
      >
        <span>Exposure</span>
        <input
          type="range"
          min={0.2}
          max={2.5}
          step={0.01}
          value={exposure}
          onChange={(e) => setExposure(parseFloat(e.target.value))}
          style={{ accentColor: "#1b88ff" }}
        />
      </label>

      <label
        style={{ display: "grid", gridTemplateColumns: "90px 1fr", gap: 8, alignItems: "center", marginTop: 8 }}
      >
        <span>Environment</span>
        <select
          value={envPreset}
          onChange={(e) => setEnvPreset(e.target.value as EnvPreset)}
          style={{
            background: "#1a1d26",
            border: "1px solid #3a3f4b",
            borderRadius: "4px",
            color: "#fff",
            padding: "4px 6px",
            fontSize: "11px",
            outline: "none"
          }}
        >
          {ENV_PRESETS.map((p) => (
            <option key={p} value={p} style={{ background: "#1a1d26", color: "#fff" }}>
              {p}
            </option>
          ))}
        </select>
      </label>

      {/* Lights */}
      <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
        <button onClick={() => addLight("ambient")} className="btn" style={{ fontSize: "11px", padding: "4px 6px" }}>
          + Ambient
        </button>
        <button
          onClick={() => addLight("directional")}
          className="btn"
          style={{ fontSize: "11px", padding: "4px 6px" }}
        >
          + Directional
        </button>
        <button onClick={() => addLight("point")} className="btn" style={{ fontSize: "11px", padding: "4px 6px" }}>
          + Point
        </button>
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
        {lights.map((l) => (
          <button
            key={l.id}
            onClick={() => setSel(l.id)}
            style={{
              padding: "3px 6px",
              borderRadius: 6,
              border: "1px solid #3a3f4b",
              background: sel === l.id ? "#1b88ff" : "#14161c",
              color: "#fff",
              fontSize: "11px"
            }}
          >
            {l.type}
          </button>
        ))}
        {selected && (
          <button
            onClick={delLight}
            className="btn"
            style={{ marginLeft: "auto", background: "#d32f2f", fontSize: "11px", padding: "3px 6px" }}
          >
            Delete
          </button>
        )}
      </div>

      {selected && (
        <div style={{ display: "grid", gap: 6, marginTop: 8, padding: 6, border: "1px solid #3a3f4b", borderRadius: 6 }}>
          <div style={{ display: "grid", gridTemplateColumns: "70px 1fr", gap: 6, alignItems: "center" }}>
            <span style={{ fontSize: "11px" }}>Type</span>
            <code style={{ fontSize: "11px" }}>{selected.type}</code>
          </div>
          <label style={{ display: "grid", gridTemplateColumns: "70px 1fr", gap: 6, alignItems: "center" }}>
            <span style={{ fontSize: "11px" }}>Color</span>
            <input
              type="color"
              value={selected.color}
              onChange={(e) => upd({ color: e.target.value })}
              style={{ width: "100%", height: "24px" }}
            />
          </label>
          <label style={{ display: "grid", gridTemplateColumns: "70px 1fr", gap: 6, alignItems: "center" }}>
            <span style={{ fontSize: "11px" }}>Intensity</span>
            <input
              type="range"
              min={0}
              max={5}
              step={0.01}
              value={selected.intensity}
              onChange={(e) => upd({ intensity: parseFloat(e.target.value) })}
              style={{ accentColor: "#1b88ff" }}
            />
          </label>
          {(selected.type === "directional" || selected.type === "point") && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 4 }}>
              {(["x", "y", "z"] as const).map((ax, idx) => (
                <label key={ax} style={{ display: "grid", gap: 2 }}>
                  <span style={{ fontSize: 11, color: "#9aa4b2" }}>pos {ax}</span>
                  <input
                    type="number"
                    step={0.1}
                    value={(selected.position ?? [4, 6, 4])[idx]}
                    onChange={(e) => updPos(idx as 0 | 1 | 2, Number.isFinite(+e.target.value) ? parseFloat(e.target.value) : 0)}
                    style={{
                      width: "100%",
                      padding: "2px 4px",
                      fontSize: "11px",
                      background: "#1a1d26",
                      border: "1px solid #3a3f4b",
                      borderRadius: "4px",
                      color: "#fff",
                      outline: "none"
                    }}
                  />
                </label>
              ))}
            </div>
          )}
        </div>
      )}

      <style jsx>{`
        .btn {
          background: #2a2f3a;
          border: 1px solid #3a3f4b;
          color: #fff;
          padding: 6px 10px;
          border-radius: 8px;
          cursor: pointer;
        }
        .btn:hover {
          background: #394050;
        }
      `}</style>
    </aside>
  );
}

/* ---------------------- Viewer root ---------------------- */
export default function Viewer({ model }: { model: ModelItem }) {
  const [k, setK] = React.useState(0); // 0..1
  const [envPreset, setEnvPreset] = React.useState<EnvPreset>("city");
  const [exposure, setExposure] = React.useState(1.2);
  const [canExplode, setCanExplode] = React.useState(false);

  const [lights, setLights] = React.useState<LightDef[]>([
  ]);
  const [stats, setStats] = React.useState<Stats>({ fps: 0, calls: 0, renderer: "WebGL", dpr: 1 });

  const cam = model.settings?.camera?.pos ?? [2.2, 1.4, 2.2];
  const fov = model.settings?.camera?.fov ?? 45;

  return (
    <div
      style={{
        height: "75vh",
        position: "relative",
        border: "1px solid #242833",
        borderRadius: 12,
        overflow: "hidden"
      }}
    >
      <ControlPanel
        stats={stats}
        k={k}
        setK={setK}
        canExplode={canExplode}
        envPreset={envPreset}
        setEnvPreset={setEnvPreset}
        exposure={exposure}
        setExposure={setExposure}
        lights={lights}
        setLights={setLights}
      />

      <Canvas
        shadows
        dpr={[1, 2]}
        camera={{ position: cam as [number, number, number], fov }}
        onCreated={({ gl }) => {
          gl.outputColorSpace = THREE.SRGBColorSpace;
          gl.toneMapping = THREE.ACESFilmicToneMapping;
          gl.toneMappingExposure = exposure;
          gl.shadowMap.enabled = true;
          gl.shadowMap.type = THREE.PCFSoftShadowMap;
        }}
      >
        <color attach="background" args={["#0e0f12"]} />

        {/* Lights */}
        {lights.map((l) => {
          if (l.type === "ambient") return <ambientLight key={l.id} color={l.color} intensity={l.intensity} />;
          if (l.type === "hemisphere") return <hemisphereLight key={l.id} intensity={l.intensity} />;
          if (l.type === "directional") {
            return (
              <directionalLight
                key={l.id}
                castShadow
                color={l.color}
                intensity={l.intensity}
                position={l.position ?? [3, 3, 3]}
                shadow-mapSize-width={2048}
                shadow-mapSize-height={2048}
                shadow-camera-near={0.1}
                shadow-camera-far={20}
                shadow-camera-left={-6}
                shadow-camera-right={6}
                shadow-camera-top={6}
                shadow-camera-bottom={-6}
              />
            );
          }
          if (l.type === "point") {
            return (
              <pointLight key={l.id} castShadow color={l.color} intensity={l.intensity} position={l.position ?? [2, 2, 2]} />
            );
          }
          return null;
        })}

        <React.Suspense fallback={null}>
          <ExplodableModel
            url={model.glb}
            settings={model.settings}
            k={k}
            onExplodeDetect={setCanExplode}
          />
          <Environment preset={envPreset} />
        </React.Suspense>

        <ContactShadows position={[0, -0.001, 0]} opacity={0.55} scale={10} blur={3} far={10} />
        <OrbitControls enableDamping />
        <StatsCollector onStats={setStats} exposure={exposure} />
      </Canvas>
    </div>
  );
}
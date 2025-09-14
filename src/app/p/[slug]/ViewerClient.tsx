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

/* Integrate three-mesh-bvh: faster raycasts on complex meshes */
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

type ExplodeUserData = {
  startPos?: THREE.Vector3;
  dir?: THREE.Vector3;
  __origMat?: THREE.Material | THREE.Material[];
};

/** Narrowing guards without `any` */
const isMesh = (o: THREE.Object3D): o is THREE.Mesh => (o as THREE.Mesh).isMesh === true;
const isInstanced = (o: THREE.Object3D): o is THREE.InstancedMesh => (o as THREE.InstancedMesh).isInstancedMesh === true;

/** For reading optional material fields without `any` */
type MaterialMaybePBR = THREE.Material & {
  color?: THREE.Color;
  map?: THREE.Texture;
  side?: THREE.Side;
};

// Advanced explode with geometry subdivision for single meshes
function createExplodeEffect(root: THREE.Group, explodeAmount: number) {
  const rootBox = new THREE.Box3().setFromObject(root);
  const rootCenter = rootBox.getCenter(new THREE.Vector3());
  
  // Collect all meshes
  const meshes: THREE.Mesh[] = [];
  root.traverse((obj) => {
    if (isMesh(obj)) meshes.push(obj);
  });
  
  // If only one mesh, try to subdivide it
  if (meshes.length === 1) {
    const mesh = meshes[0];
    const subdivided = subdivideMesh(mesh, 4);
    
    if (subdivided.length > 1) {
      // Replace original mesh with subdivided parts
      const parent = mesh.parent;
      if (parent) {
        parent.remove(mesh);
        subdivided.forEach(subMesh => {
          parent.add(subMesh);
          // Apply explode to each part
          applyExplodeToMesh(subMesh, rootCenter, explodeAmount);
        });
      }
      return;
    }
  }
  
  // Apply explode to all meshes
  meshes.forEach(mesh => {
    applyExplodeToMesh(mesh, rootCenter, explodeAmount);
  });
}

// Apply explode effect to a single mesh
function applyExplodeToMesh(mesh: THREE.Mesh, rootCenter: THREE.Vector3, explodeAmount: number) {
  const meshBox = new THREE.Box3().setFromObject(mesh);
  const meshCenter = meshBox.getCenter(new THREE.Vector3());
  
  // Get direction vector
  const direction = meshCenter.clone().sub(rootCenter).normalize();
  
  // Store original position if not already stored
  if (!mesh.userData.originalPosition) {
    mesh.userData.originalPosition = mesh.position.clone();
  }
  
  // Apply explode offset
  const offset = direction.multiplyScalar(explodeAmount);
  mesh.position.copy(mesh.userData.originalPosition).add(offset);
}

// Subdivide a single mesh into multiple parts
function subdivideMesh(mesh: THREE.Mesh, numParts: number): THREE.Mesh[] {
  const geometry = mesh.geometry as THREE.BufferGeometry;
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  
  if (!position) return [mesh];
  
  // Compute bounding box
  geometry.computeBoundingBox();
  const bbox = geometry.boundingBox!;
  const size = bbox.getSize(new THREE.Vector3());
  
  // Find the axis with the largest extent
  const maxAxis = size.x > size.y ? (size.x > size.z ? 'x' : 'z') : (size.y > size.z ? 'y' : 'z');
  
  // Sort vertices by the chosen axis
  const vertices: Array<{ index: number; value: number }> = [];
  
  for (let i = 0; i < position.count; i++) {
    const pos = new THREE.Vector3();
    pos.set(position.getX(i), position.getY(i), position.getZ(i));
    vertices.push({
      index: i,
      value: pos.getComponent(maxAxis === 'x' ? 0 : maxAxis === 'y' ? 1 : 2)
    });
  }
  
  // Sort by the chosen axis
  vertices.sort((a, b) => a.value - b.value);
  
  // Create subdivisions
  const subdivisions: THREE.Mesh[] = [];
  const verticesPerPart = Math.ceil(vertices.length / numParts);
  
  for (let part = 0; part < numParts; part++) {
    const startIdx = part * verticesPerPart;
    const endIdx = Math.min(startIdx + verticesPerPart, vertices.length);
    
    if (startIdx >= vertices.length) break;
    
    // Get vertex indices for this part
    const partIndices = vertices.slice(startIdx, endIdx).map(v => v.index);
    const partSet = new Set(partIndices);
    
    // Find triangles that belong to this part
    const partTriangles: number[] = [];
    const index = geometry.getIndex();
    
    if (index) {
      for (let i = 0; i < index.count; i += 3) {
        const a = index.getX(i);
        const b = index.getX(i + 1);
        const c = index.getX(i + 2);
        
        if (partSet.has(a) || partSet.has(b) || partSet.has(c)) {
          partTriangles.push(a, b, c);
        }
      }
    } else {
      for (let i = 0; i < position.count; i += 3) {
        if (partSet.has(i) || partSet.has(i + 1) || partSet.has(i + 2)) {
          partTriangles.push(i, i + 1, i + 2);
        }
      }
    }
    
    if (partTriangles.length === 0) continue;
    
    // Create new geometry for this part
    const partGeometry = createSubGeometry(geometry, partTriangles);
    
    // Create mesh for this part
    const partMesh = new THREE.Mesh(partGeometry, mesh.material);
    partMesh.position.copy(mesh.position);
    partMesh.quaternion.copy(mesh.quaternion);
    partMesh.scale.copy(mesh.scale);
    partMesh.castShadow = true;
    partMesh.receiveShadow = true;
    
    subdivisions.push(partMesh);
  }
  
  return subdivisions.length > 1 ? subdivisions : [mesh];
}

// Create sub-geometry from triangle indices
function createSubGeometry(originalGeometry: THREE.BufferGeometry, triangleIndices: number[]): THREE.BufferGeometry {
  const position = originalGeometry.getAttribute('position') as THREE.BufferAttribute;
  const normal = originalGeometry.getAttribute('normal') as THREE.BufferAttribute | null;
  const uv = originalGeometry.getAttribute('uv') as THREE.BufferAttribute | null;
  
  // Remap indices to compact vertex array
  const vertexMap = new Map<number, number>();
  const newPositions: number[] = [];
  const newNormals: number[] = [];
  const newUvs: number[] = [];
  const newIndices: number[] = [];
  
  let newVertexIndex = 0;
  
  for (let i = 0; i < triangleIndices.length; i += 3) {
    const indices = [triangleIndices[i], triangleIndices[i + 1], triangleIndices[i + 2]];
    
    for (const oldIndex of indices) {
      if (!vertexMap.has(oldIndex)) {
        vertexMap.set(oldIndex, newVertexIndex++);
        
        // Copy position
        const pos = new THREE.Vector3();
        pos.set(position.getX(oldIndex), position.getY(oldIndex), position.getZ(oldIndex));
        newPositions.push(pos.x, pos.y, pos.z);
        
        // Copy normal if available
        if (normal) {
          const norm = new THREE.Vector3();
          norm.set(normal.getX(oldIndex), normal.getY(oldIndex), normal.getZ(oldIndex));
          newNormals.push(norm.x, norm.y, norm.z);
        }
        
        // Copy UV if available
        if (uv) {
          const uvCoords = new THREE.Vector2();
          uvCoords.set(uv.getX(oldIndex), uv.getY(oldIndex));
          newUvs.push(uvCoords.x, uvCoords.y);
        }
      }
      
      newIndices.push(vertexMap.get(oldIndex)!);
    }
  }
  
  // Create new geometry
  const subGeometry = new THREE.BufferGeometry();
  subGeometry.setAttribute('position', new THREE.Float32BufferAttribute(newPositions, 3));
  if (newNormals.length > 0) {
    subGeometry.setAttribute('normal', new THREE.Float32BufferAttribute(newNormals, 3));
  }
  if (newUvs.length > 0) {
    subGeometry.setAttribute('uv', new THREE.Float32BufferAttribute(newUvs, 2));
  }
  subGeometry.setIndex(newIndices);
  
  subGeometry.computeBoundingBox();
  subGeometry.computeBoundingSphere();
  
  return subGeometry;
}

/* ============================================================
   ExplodableModel
   - Normal mode: renders original scene as-is (keeps custom shaders).
   - Explode mode: builds and renders a separate exploded clone with
     safe MeshStandard/Physical materials, never touching the original.
   ============================================================ */
function ExplodableModel({
  url,
  settings,
  k
}: {
  url: string;
  settings?: ModelItem["settings"];
  k: number;
}) {
  const { gl } = useThree();
  const gltf = useLoader(GLTFLoader, url, loader => {
    const ktx2 = new KTX2Loader().setTranscoderPath("/basis/").detectSupport(gl);
    (loader as GLTFLoader).setKTX2Loader(ktx2);
    (loader as GLTFLoader).setMeshoptDecoder(MeshoptDecoder);
  }) as GLTF;

  const root = React.useMemo<THREE.Group>(() => gltf.scene.clone(true), [gltf.scene]);

  // Normalize pose and ensure world matrices are up to date
  React.useEffect(() => {
    if (settings?.yUp === false) root.rotateX(-Math.PI / 2);
    root.scale.setScalar(settings?.scale ?? 1);
    root.updateWorldMatrix(true, true);
  }, [root, settings]);

  // Enable shadows and BVH
  React.useEffect(() => {
    root.traverse(obj => {
      if (!isMesh(obj)) return;
      obj.geometry.computeBoundsTree?.();
      obj.castShadow = true;
      obj.receiveShadow = true;
    });

    return () => { root.traverse(obj => isMesh(obj) && obj.geometry.disposeBoundsTree?.()); };
  }, [root]);

  // Apply explode effect
  React.useEffect(() => {
    createExplodeEffect(root, k * 2); // multiply by 2 for more visible effect
  }, [root, k]);

  const onPointerDown = (e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); };
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
      intensity: type === "ambient" ? 0.3 : 1.2,
      position: type === "directional" || type === "point" ? [3, 4, 3] : undefined
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
        width: 320,
        zIndex: 50,
        background: "rgba(13,16,22,0.9)",
        backdropFilter: "blur(6px)",
        border: "1px solid #2b2f3a",
        borderRadius: 12,
        color: "#fff",
        padding: 10,
        fontFamily: "ui-monospace,monospace"
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
        <b>Controls</b>
        <span style={{ fontSize: 12, color: "#9aa4b2" }}>
          {stats.renderer} · DPR {stats.dpr} · FPS {stats.fps} · Calls {stats.calls}
        </span>
      </div>

      <label style={{ display: "grid", gridTemplateColumns: "90px 1fr", gap: 8, alignItems: "center" }}>
        <span>Explode</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={k} 
          onChange={(e) => setK(parseFloat(e.target.value))}
          style={{ accentColor: "#1b88ff" }}
        />
      </label>

      {/* Exposure and environment */}
      <label style={{ display: "grid", gridTemplateColumns: "90px 1fr", gap: 8, alignItems: "center", marginTop: 8 }}>
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

      <label style={{ display: "grid", gridTemplateColumns: "90px 1fr", gap: 8, alignItems: "center", marginTop: 8 }}>
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
      <div style={{ display: "flex", gap: 4, marginTop: 6, flexWrap: "wrap" }}>
        <button onClick={() => addLight("ambient")} className="btn" style={{ fontSize: "11px", padding: "4px 6px" }}>
          + Ambient
        </button>
        <button onClick={() => addLight("directional")} className="btn" style={{ fontSize: "11px", padding: "4px 6px" }}>
          + Directional
        </button>
        <button onClick={() => addLight("point")} className="btn" style={{ fontSize: "11px", padding: "4px 6px" }}>
          + Point
        </button>
      </div>

      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 6 }}>
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
          <button onClick={delLight} className="btn" style={{ marginLeft: "auto", background: "#d32f2f", fontSize: "11px", padding: "3px 6px" }}>
            Delete
          </button>
        )}
      </div>

      {selected && (
        <div style={{ display: "grid", gap: 6, marginTop: 6, padding: 6, border: "1px solid #3a3f4b", borderRadius: 6 }}>
          <div style={{ display: "grid", gridTemplateColumns: "70px 1fr", gap: 6, alignItems: "center" }}>
            <span style={{ fontSize: "11px" }}>Type</span>
            <code style={{ fontSize: "11px" }}>{selected.type}</code>
          </div>
          <label style={{ display: "grid", gridTemplateColumns: "70px 1fr", gap: 6, alignItems: "center" }}>
            <span style={{ fontSize: "11px" }}>Color</span>
            <input type="color" value={selected.color} onChange={(e) => upd({ color: e.target.value })} style={{ width: "100%", height: "24px" }} />
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
                    value={(selected.position ?? [3, 4, 3])[idx]}
                    onChange={(e) => updPos(idx as 0 | 1 | 2, parseFloat(e.target.value) || 0)}
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
  const [k, setK] = React.useState(0);
  const [envPreset, setEnvPreset] = React.useState<EnvPreset>("city");
  const [exposure, setExposure] = React.useState(1.0);
  const [lights, setLights] = React.useState<LightDef[]>([
    { id: "amb", type: "ambient", color: "#ffffff", intensity: 0.35 },
    { id: "key", type: "directional", color: "#ffffff", intensity: 1.8, position: [4, 6, 4] }
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
            return <pointLight key={l.id} castShadow color={l.color} intensity={l.intensity} position={l.position ?? [2, 2, 2]} />;
          }
          return null;
        })}

        <React.Suspense fallback={null}>
          <ExplodableModel url={model.glb} settings={model.settings} k={k} />
          <Environment preset={envPreset} />
        </React.Suspense>

        <ContactShadows position={[0, -0.001, 0]} opacity={0.55} scale={10} blur={3} far={10} />
        <OrbitControls enableDamping />
        <StatsCollector onStats={setStats} exposure={exposure} />
      </Canvas>
    </div>
  );
}

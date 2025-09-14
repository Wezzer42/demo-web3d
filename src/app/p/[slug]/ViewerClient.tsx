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

/** Per-mesh explode metadata stored on the exploded clone */
type ExplodeData = { basePos: THREE.Vector3; dir: THREE.Vector3 };

/** Narrowing guards without `any` */
const isMesh = (o: THREE.Object3D): o is THREE.Mesh => (o as THREE.Mesh).isMesh === true;
const isSkinned = (o: THREE.Object3D): o is THREE.SkinnedMesh => (o as THREE.SkinnedMesh).isSkinnedMesh === true;
const isInstanced = (o: THREE.Object3D): o is THREE.InstancedMesh => (o as THREE.InstancedMesh).isInstancedMesh === true;

/** For reading optional material fields without `any` */
type MaterialMaybePBR = THREE.Material & {
  color?: THREE.Color;
  map?: THREE.Texture;
  side?: THREE.Side;
};

/* ============================================================
   Geometry subdivision helper
   ============================================================ */
function subdivideGeometry(mesh: THREE.Mesh, numParts: number): THREE.Mesh[] {
  const geometry = mesh.geometry as THREE.BufferGeometry;
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const normal = geometry.getAttribute('normal') as THREE.BufferAttribute | null;
  const uv = geometry.getAttribute('uv') as THREE.BufferAttribute | null;
  const index = geometry.getIndex();
  
  if (!position) return [];
  
  // Compute bounding box
  geometry.computeBoundingBox();
  const bbox = geometry.boundingBox!;
  const size = bbox.getSize(new THREE.Vector3());
  
  // Find the axis with the largest extent
  const maxAxis = size.x > size.y ? (size.x > size.z ? 'x' : 'z') : (size.y > size.z ? 'y' : 'z');
  
  // Sort vertices by the chosen axis
  const vertices: Array<{ index: number; value: number; pos: THREE.Vector3 }> = [];
  
  for (let i = 0; i < position.count; i++) {
    const pos = new THREE.Vector3();
    pos.set(position.getX(i), position.getY(i), position.getZ(i));
    vertices.push({
      index: i,
      value: pos.getComponent(maxAxis === 'x' ? 0 : maxAxis === 'y' ? 1 : 2),
      pos: pos
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
    const triangleToPart = new Map<number, number>();
    
    if (index) {
      for (let i = 0; i < index.count; i += 3) {
        const a = index.getX(i);
        const b = index.getX(i + 1);
        const c = index.getX(i + 2);
        
        // Check if any vertex of this triangle belongs to this part
        if (partSet.has(a) || partSet.has(b) || partSet.has(c)) {
          partTriangles.push(a, b, c);
          triangleToPart.set(i / 3, part);
        }
      }
    } else {
      // Non-indexed geometry
      for (let i = 0; i < position.count; i += 3) {
        if (partSet.has(i) || partSet.has(i + 1) || partSet.has(i + 2)) {
          partTriangles.push(i, i + 1, i + 2);
        }
      }
    }
    
    if (partTriangles.length === 0) continue;
    
    // Create new geometry for this part
    const partGeometry = new THREE.BufferGeometry();
    
    // Remap indices to compact vertex array
    const vertexMap = new Map<number, number>();
    const newPositions: number[] = [];
    const newNormals: number[] = [];
    const newUvs: number[] = [];
    const newIndices: number[] = [];
    
    let newVertexIndex = 0;
    
    for (let i = 0; i < partTriangles.length; i += 3) {
      const indices = [partTriangles[i], partTriangles[i + 1], partTriangles[i + 2]];
      
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
    
    // Set attributes
    partGeometry.setAttribute('position', new THREE.Float32BufferAttribute(newPositions, 3));
    if (newNormals.length > 0) {
      partGeometry.setAttribute('normal', new THREE.Float32BufferAttribute(newNormals, 3));
    }
    if (newUvs.length > 0) {
      partGeometry.setAttribute('uv', new THREE.Float32BufferAttribute(newUvs, 2));
    }
    partGeometry.setIndex(newIndices);
    
    partGeometry.computeBoundingBox();
    partGeometry.computeBoundingSphere();
    
    // Create mesh for this part
    const partMesh = new THREE.Mesh(partGeometry, mesh.material);
    partMesh.position.copy(mesh.position);
    partMesh.quaternion.copy(mesh.quaternion);
    partMesh.scale.copy(mesh.scale);
    partMesh.castShadow = true;
    partMesh.receiveShadow = true;
    
    subdivisions.push(partMesh);
  }
  
  return subdivisions;
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
  explode,
  amount,
  subdivisionParts
}: {
  url: string;
  settings?: ModelItem["settings"];
  explode: boolean;
  amount: number; // normalized 0..1 range
  subdivisionParts: number; // number of parts for subdivision
}) {
  const { gl } = useThree();

  // Load GLTF with KTX2 + Meshopt support
  const gltf = useLoader(
    GLTFLoader,
    url,
    (loader) => {
      const ktx2 = new KTX2Loader().setTranscoderPath("/basis/").detectSupport(gl);
      (loader as GLTFLoader).setKTX2Loader(ktx2);
      (loader as GLTFLoader).setMeshoptDecoder(MeshoptDecoder);
    }
  ) as GLTF;

  // Original scene: never mutated, preserves every original material/shader
  const origRoot = React.useMemo<THREE.Group>(() => gltf.scene.clone(true), [gltf.scene]);

  // Normalize coordinate system and scale once on the original
  React.useEffect(() => {
    if (settings?.yUp === false) origRoot.rotateX(-Math.PI / 2);
    origRoot.scale.setScalar(settings?.scale ?? 1);
    origRoot.updateWorldMatrix(true, true);
  }, [origRoot, settings]);

  // Runtime containers for exploded clone resources
  const safeMatCache = React.useRef(new Map<THREE.Material, THREE.Material>());
  const createdMatsRef = React.useRef<THREE.Material[]>([]);
  const createdGeomsRef = React.useRef<THREE.BufferGeometry[]>([]);
  const [explodedGroup, setExplodedGroup] = React.useState<THREE.Group | null>(null);
  const prevAmount = React.useRef<number>(amount);

  /** Convert a material to a "safe" PBR material for explode clone.
   *  - If already Standard/Physical, clone it and strip onBeforeCompile hooks.
   *  - Otherwise approximate with MeshStandardMaterial keeping color/map/side if present.
   *  - Reuse via cache to avoid duplicates.
   */
  function toSafeMaterial(matIn: THREE.Material | THREE.Material[]): THREE.Material | THREE.Material[] {
    const convert = (m: THREE.Material): THREE.Material => {
      const cached = safeMatCache.current.get(m);
      if (cached) return cached;

      let safe: THREE.Material;
      if (m instanceof THREE.MeshStandardMaterial || m instanceof THREE.MeshPhysicalMaterial) {
        const copy = m.clone();
        copy.onBeforeCompile = () => {};
        copy.needsUpdate = true;
        safe = copy;
      } else {
        const src = m as MaterialMaybePBR;
        const base = new THREE.MeshStandardMaterial({
          color: src.color ? src.color.clone() : new THREE.Color(0xffffff),
          map: src.map,
          metalness: 0.2,
          roughness: 0.6
        });
        if (typeof src.side !== "undefined") base.side = src.side;
        base.needsUpdate = true;
        safe = base;
      }
      createdMatsRef.current.push(safe);
      safeMatCache.current.set(m, safe);
      return safe;
    };
    return Array.isArray(matIn) ? matIn.map(convert) : convert(matIn);
  }

  /** Build exploded clone when toggled ON; dispose it when OFF or when rebuilding */
  React.useEffect(() => {
    // Dispose current exploded clone and its resources
    const disposeCurrent = () => {
      if (explodedGroup) {
        explodedGroup.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh && m.geometry) m.geometry.dispose();
        });
      }
      createdGeomsRef.current.forEach((g) => g.dispose());
      createdMatsRef.current.forEach((m) => m.dispose());
      createdGeomsRef.current = [];
      createdMatsRef.current = [];
      safeMatCache.current.clear();
      setExplodedGroup(null);
    };

    disposeCurrent();
    prevAmount.current = amount;

    if (!explode) return;

    const cloneRoot = new THREE.Group();
    cloneRoot.position.copy(origRoot.position);
    cloneRoot.quaternion.copy(origRoot.quaternion);
    cloneRoot.scale.copy(origRoot.scale);

    // Make sure matrices are up to date for coordinate conversions
    origRoot.updateWorldMatrix(true, true);

    // Compute world-space center of the whole assembly
    const rootBox = new THREE.Box3().setFromObject(origRoot);
    const rootCw = rootBox.getCenter(new THREE.Vector3());

    // Collect meshes from the original (including SkinnedMesh)
    const meshes: THREE.Mesh[] = [];
    const allObjects: THREE.Object3D[] = [];
    origRoot.traverse((o) => {
      allObjects.push(o);
      if (isMesh(o) && !isInstanced(o)) {
        meshes.push(o as THREE.Mesh);
      }
    });
    
    console.log('Explode debug:', {
      explode,
      amount,
      totalObjects: allObjects.length,
      meshesFound: meshes.length,
      meshTypes: meshes.map(m => ({
        type: m.type,
        isMesh: m.isMesh,
        isSkinned: (m as any).isSkinnedMesh,
        isInstanced: (m as any).isInstancedMesh,
        geometryGroups: m.geometry?.groups?.length || 0,
        hasGeometry: !!m.geometry
      })),
      allObjectTypes: allObjects.map(o => o.type)
    });

    // Helper to clone a mesh (reuse geometry, convert material to safe)
    const cloneMesh = (src: THREE.Mesh, safeMat?: THREE.Material | THREE.Material[]) => {
      const dst = new THREE.Mesh(src.geometry, safeMat ?? toSafeMaterial(src.material));
      dst.position.copy(src.position);
      dst.quaternion.copy(src.quaternion);
      dst.scale.copy(src.scale);
      dst.castShadow = true;
      dst.receiveShadow = true;
      return dst;
    };

    // Case A: multiple meshes — each one moves away from the assembly center
    if (meshes.length >= 2) {
      console.log('Multiple meshes found, exploding each mesh');
      meshes.forEach((src) => {
        const box = new THREE.Box3().setFromObject(src);
        const cw = box.getCenter(new THREE.Vector3());

        const parent = src.parent!;
        const cLocal = parent.worldToLocal(cw.clone());
        const rootCLocal = parent.worldToLocal(rootCw.clone());

        const dir = cLocal.sub(rootCLocal);
        if (dir.lengthSq() < 1e-12) dir.set(0, 1, 0);
        dir.normalize();

        const dst = cloneMesh(src);
        (dst.userData as ExplodeData) = { basePos: dst.position.clone(), dir: dir.clone() };
        dst.position.addScaledVector(dir, amount);
        dst.updateMatrixWorld();
        cloneRoot.add(dst);
      });

      setExplodedGroup(cloneRoot);
      return;
    }

    // Case B: single mesh — split by geometry.groups into submeshes if possible
    const only = meshes[0];
    if (only) {
      console.log('Single mesh found, checking for geometry groups');
      const geom = only.geometry as THREE.BufferGeometry;
      const groups = geom.groups ?? [];
      const origMaterials = Array.isArray(only.material) ? only.material : [only.material];

      // If no groups, try to split geometry by spatial regions
      if (!groups.length) {
        console.log('No geometry groups found, attempting spatial subdivision');
        
        // Try to split the geometry into spatial chunks
        const subdividedMeshes = subdivideGeometry(only, subdivisionParts);
        
        if (subdividedMeshes.length > 1) {
          console.log(`Successfully subdivided into ${subdividedMeshes.length} parts`);
          subdividedMeshes.forEach((subMesh, index) => {
            // Calculate direction from submesh center to assembly center
            const subBox = new THREE.Box3().setFromObject(subMesh);
            const subCenter = subBox.getCenter(new THREE.Vector3());
            const parent = only.parent!;
            const subCenterLocal = parent.worldToLocal(subCenter.clone());
            const rootCenterLocal = parent.worldToLocal(rootCw.clone());
            
            const dir = subCenterLocal.sub(rootCenterLocal);
            if (dir.lengthSq() < 1e-12) dir.set(0, 1, 0);
            dir.normalize();
            
            (subMesh.userData as ExplodeData) = { basePos: subMesh.position.clone(), dir: dir.clone() };
            subMesh.position.addScaledVector(dir, amount * 1.5);
            subMesh.updateMatrixWorld();
            cloneRoot.add(subMesh);
          });
          setExplodedGroup(cloneRoot);
          return;
        } else {
          // Fallback: simple explode effect
          console.log('Spatial subdivision failed, using simple explode effect');
          const dst = cloneMesh(only);
          
          const meshBox = new THREE.Box3().setFromObject(only);
          const meshCenter = meshBox.getCenter(new THREE.Vector3());
          const parent = only.parent!;
          const meshCenterLocal = parent.worldToLocal(meshCenter.clone());
          const rootCenterLocal = parent.worldToLocal(rootCw.clone());
          
          const dir = meshCenterLocal.sub(rootCenterLocal);
          if (dir.lengthSq() < 1e-12) dir.set(0, 1, 0);
          dir.normalize();
          
          (dst.userData as ExplodeData) = { basePos: dst.position.clone(), dir: dir.clone() };
          dst.position.addScaledVector(dir, amount * 2);
          dst.updateMatrixWorld();
          cloneRoot.add(dst);
          setExplodedGroup(cloneRoot);
          return;
        }
      }

      const indexAttr = geom.getIndex();
      const pos = geom.getAttribute("position") as THREE.BufferAttribute;
      const nrm = geom.getAttribute("normal") as THREE.BufferAttribute | null;
      const uv = geom.getAttribute("uv") as THREE.BufferAttribute | null;

      // Whole-mesh center in local space (used to compute local directions)
      geom.computeBoundingBox();
      const wholeCenter = geom.boundingBox
        ? geom.boundingBox.getCenter(new THREE.Vector3())
        : new THREE.Vector3(0, 0, 0);

      console.log(`Found ${groups.length} geometry groups, splitting mesh`);
      for (const g of groups) {
        const start = g.start;
        const count = g.count;
        const matIdx = g.materialIndex ?? 0;

        // Collect indices for this group
        const srcIndices: number[] = indexAttr
          ? Array.from(indexAttr.array).slice(start, start + count)
          : Array.from({ length: count }, (_, i) => start + i);

        // Build a compacted sub-geometry for the group
        const remap = new Map<number, number>();
        const newIndices: number[] = [];
        const newPos: number[] = [];
        const newNrm: number[] = [];
        const newUv: number[] = [];

        for (const oi of srcIndices) {
          let ni = remap.get(oi);
          if (ni === undefined) {
            ni = remap.size;
            remap.set(oi, ni);
            newPos.push(pos.getX(oi), pos.getY(oi), pos.getZ(oi));
            if (nrm) newNrm.push(nrm.getX(oi), nrm.getY(oi), nrm.getZ(oi));
            if (uv) newUv.push(uv.getX(oi), uv.getY(oi));
          }
          newIndices.push(ni);
        }

        const sub = new THREE.BufferGeometry();
        sub.setIndex(newIndices);
        sub.setAttribute("position", new THREE.Float32BufferAttribute(newPos, 3));
        if (newNrm.length) sub.setAttribute("normal", new THREE.Float32BufferAttribute(newNrm, 3));
        if (newUv.length) sub.setAttribute("uv", new THREE.Float32BufferAttribute(newUv, 2));
        sub.computeBoundingBox();
        sub.computeBoundingSphere();
        createdGeomsRef.current.push(sub);

        // Local explode direction: subset center vs whole center
        const subCenter = sub.boundingBox
          ? sub.boundingBox.getCenter(new THREE.Vector3())
          : new THREE.Vector3(0, 0, 0);
        const dirLocal = subCenter.clone().sub(wholeCenter);
        if (dirLocal.lengthSq() < 1e-12) dirLocal.set(0, 1, 0);
        dirLocal.normalize();

        const matSafe = toSafeMaterial(origMaterials[matIdx] ?? origMaterials[0]);
        const subMesh = new THREE.Mesh(sub, matSafe as THREE.Material);

        // Copy TRS from original, then offset along dirLocal
        subMesh.position.copy(only.position);
        subMesh.quaternion.copy(only.quaternion);
        subMesh.scale.copy(only.scale);

        (subMesh.userData as ExplodeData) = { basePos: subMesh.position.clone(), dir: dirLocal.clone() };
        subMesh.position.addScaledVector(dirLocal, amount);

        subMesh.castShadow = true;
        subMesh.receiveShadow = true;

        cloneRoot.add(subMesh);
      }

      setExplodedGroup(cloneRoot);
      return;
    }

    // No meshes: still set empty group to keep toggle stable
    console.log('No meshes found, setting empty exploded group');
    setExplodedGroup(cloneRoot);
  }, [explode, amount, origRoot]); // rebuild when toggling or when we want initial offsets to reflect amount

  /** Update positions when slider changes without rebuilding geometry */
  useFrame(() => {
    if (!explode || !explodedGroup) return;
    if (prevAmount.current === amount) return;

    explodedGroup.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const ud = m.userData as ExplodeData;
      if (!ud?.basePos || !ud?.dir) return;
      m.position.copy(ud.basePos).addScaledVector(ud.dir, amount);
      m.updateMatrixWorld();
    });

    prevAmount.current = amount;
  });

  return (
    <>
      {/* Original scene (keeps all original shaders/materials) */}
      <primitive
        object={origRoot}
        visible={!explode}
        onPointerDown={(e: ThreeEvent<MouseEvent>) => e.stopPropagation()}
      />
      {/* Exploded clone (safe PBR materials only) */}
      {explode && explodedGroup && (
        <primitive
          object={explodedGroup}
          visible
          onPointerDown={(e: ThreeEvent<MouseEvent>) => e.stopPropagation()}
        />
      )}
    </>
  );
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
  explode,
  setExplode,
  amount,
  setAmount,
  subdivisionParts,
  setSubdivisionParts,
  envPreset,
  setEnvPreset,
  exposure,
  setExposure,
  lights,
  setLights
}: {
  stats: Stats;
  explode: boolean;
  setExplode: (v: boolean) => void;
  amount: number;
  setAmount: (v: number) => void;
  subdivisionParts: number;
  setSubdivisionParts: (v: number) => void;
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

      {/* Explode toggle + amount */}
      <label style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
        <input 
          type="checkbox" 
          checked={explode} 
          onChange={(e) => setExplode(e.target.checked)}
          style={{ accentColor: "#1b88ff" }}
        />
        <span>Explode</span>
      </label>
      <label style={{ display: "grid", gridTemplateColumns: "90px 1fr", gap: 8, alignItems: "center" }}>
        <span>Amount</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={amount}
          disabled={!explode}
          onChange={(e) => setAmount(parseFloat(e.target.value))}
          style={{ accentColor: "#1b88ff" }}
        />
      </label>
      <label style={{ display: "grid", gridTemplateColumns: "90px 1fr", gap: 8, alignItems: "center" }}>
        <span>Parts</span>
        <input
          type="range"
          min={2}
          max={8}
          step={1}
          value={subdivisionParts}
          disabled={!explode}
          onChange={(e) => setSubdivisionParts(parseInt(e.target.value))}
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
  const [explode, setExplode] = React.useState(false);
  const [amount, setAmount] = React.useState(1.0); // 0..1 normalized
  const [subdivisionParts, setSubdivisionParts] = React.useState(4); // number of parts for subdivision
  const [envPreset, setEnvPreset] = React.useState<EnvPreset>("city");
  const [exposure, setExposure] = React.useState(1.2);
  const [lights, setLights] = React.useState<LightDef[]>([]);
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
        explode={explode}
        setExplode={setExplode}
        amount={amount}
        setAmount={setAmount}
        subdivisionParts={subdivisionParts}
        setSubdivisionParts={setSubdivisionParts}
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
          <ExplodableModel url={model.glb} settings={model.settings} explode={explode} amount={amount} subdivisionParts={subdivisionParts} />
          <Environment preset={envPreset} />
        </React.Suspense>

        <ContactShadows position={[0, -0.001, 0]} opacity={0.55} scale={10} blur={3} far={10} />
        <OrbitControls enableDamping />
        <StatsCollector onStats={setStats} exposure={exposure} />
      </Canvas>
    </div>
  );
}

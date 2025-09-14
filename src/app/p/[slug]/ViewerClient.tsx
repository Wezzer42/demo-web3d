"use client";

import * as React from "react";
import * as THREE from "three";
import { Canvas, useFrame, useLoader, useThree } from "@react-three/fiber";
import { Environment, OrbitControls, Html } from "@react-three/drei";
import { GLTFLoader } from "three-stdlib";
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from "three-mesh-bvh";
import type { ModelItem } from "@/data/models";

// ускоряем raycast
(THREE.Mesh as any).prototype.raycast = acceleratedRaycast;
(THREE.BufferGeometry as any).prototype.computeBoundsTree = computeBoundsTree;
(THREE.BufferGeometry as any).prototype.disposeBoundsTree = disposeBoundsTree;

function ExplodableModel({
  url,
  settings,
  k
}: {
  url: string;
  settings?: ModelItem["settings"];
  k: number;
}) {
  const gltf = useLoader(GLTFLoader, url);
  const root = React.useMemo(() => gltf.scene.clone(true), [gltf.scene]);

  // нормализация осей/масштаба
  React.useEffect(() => {
    if (settings?.yUp === false) root.rotateX(-Math.PI / 2);
    root.scale.setScalar(settings?.scale ?? 1);
  }, [root, settings]);

  // подготовка explode
  React.useEffect(() => {
    const rootBox = new THREE.Box3().setFromObject(root);
    const rootC = rootBox.getCenter(new THREE.Vector3());
    root.traverse((o: any) => {
      if (!o.isMesh) return;
      o.geometry.computeBoundsTree?.();
      const box = new THREE.Box3().setFromObject(o);
      const c = box.getCenter(new THREE.Vector3());
      o.userData.startPos = o.position.clone();
      o.userData.dir = c.sub(rootC).normalize();
      o.userData.__origMat = o.material;
    });
    return () => root.traverse((o: any) => o.isMesh && o.geometry.disposeBoundsTree?.());
  }, [root]);

  // применяем explode
  const prev = React.useRef(k);
  useFrame(() => {
    if (prev.current === k) return;
    root.traverse((o: any) => {
      if (!o.userData?.startPos || !o.userData?.dir) return;
      o.position.copy(o.userData.startPos).addScaledVector(o.userData.dir, 0.6 * k);
      o.updateMatrixWorld();
    });
    prev.current = k;
  });

  return <primitive object={root} />;
}

function Overlay({ k, setK }: { k: number; setK: (v: number) => void }) {
  const { gl } = useThree();
  const [fps, setFps] = React.useState(0);
  const [calls, setCalls] = React.useState(0);

  // простой FPS
  React.useEffect(() => {
    let frames = 0,
      last = performance.now(),
      raf = 0;
    const loop = () => {
      frames++;
      const now = performance.now();
      if (now - last >= 1000) {
        setFps(frames);
        frames = 0;
        last = now;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  useFrame(() => setCalls(gl.info.render.calls));

  return (
    <Html fullscreen>
      <div
        style={{
          position: "absolute",
          bottom: 14,
          left: 14,
          background: "rgba(0,0,0,.55)",
          color: "#fff",
          padding: "10px 12px",
          borderRadius: 10,
          fontFamily: "ui-monospace,monospace"
        }}
      >
        <div>FPS: {fps} | Calls: {calls}</div>
        <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
          Explode
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={k}
            onChange={(e) => setK(parseFloat(e.currentTarget.value))}
          />
        </label>
        <div style={{ marginTop: 6, fontSize: 12 }}>
          {gl.capabilities.isWebGL2 ? "WebGL2" : "WebGL"} · DPR{" "}
          {Math.round(window.devicePixelRatio * 10) / 10}
        </div>
      </div>
    </Html>
  );
}

export default function Viewer({ model }: { model: ModelItem }) {
  const [k, setK] = React.useState(0);
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
      <Canvas dpr={[1, 2]} camera={{ position: cam as any, fov }}>
        <color attach="background" args={["#0e0f12"]} />
        <hemisphereLight intensity={0.5} />
        <directionalLight position={[3, 3, 3]} intensity={1.1} />
        <React.Suspense fallback={null}>
          <ExplodableModel url={model.glb} settings={model.settings} k={k} />
          <Environment preset="city" />
        </React.Suspense>
        <OrbitControls enableDamping />

        {/* ВАЖНО: Overlay внутри Canvas */}
        <Overlay k={k} setK={setK} />
      </Canvas>
    </div>
  );
}

"use client";

import * as React from "react";
import * as THREE from "three";
import { Canvas, useFrame, useLoader } from "@react-three/fiber";
import { Environment } from "@react-three/drei";
import { GLTFLoader } from "three-stdlib";

function Model({ url, scale = 1, yUp = true }: { url: string; scale?: number; yUp?: boolean }) {
  const gltf = useLoader(GLTFLoader, url);
  const group = React.useMemo(() => {
    const g = new THREE.Group();
    const s = gltf.scene.clone(true);
    if (yUp === false) s.rotateX(-Math.PI / 2);
    s.scale.setScalar(scale);
    g.add(s);
    const box = new THREE.Box3().setFromObject(g);
    const c = box.getCenter(new THREE.Vector3());
    g.position.sub(c);
    return g;
  }, [gltf, scale, yUp]);
  useFrame((_, dt) => { group.rotation.y += dt * 0.5; });
  return <primitive object={group} />;
}

export default function Thumbnail3D({
  url,
  scale = 1,
  yUp = true,
  height = 180
}: { url: string; scale?: number; yUp?: boolean; height?: number }) {
  return (
    <div style={{ height, background: "#0c0d10" }}>
      <Canvas
        dpr={[1, 1.5]}
        gl={{ antialias: true, powerPreference: "high-performance" }}
        camera={{ position: [2.2, 1.4, 2.2], fov: 45 }}
      >
        <color attach="background" args={["#0c0d10"]} />
        <hemisphereLight intensity={0.6} />
        <directionalLight position={[3, 3, 3]} intensity={1.1} />
        <React.Suspense fallback={null}>
          <Model url={url} scale={scale} yUp={yUp} />
          <Environment preset="city" />
        </React.Suspense>
      </Canvas>
    </div>
  );
}

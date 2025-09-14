3D Gallery Demo

A simple 3D gallery to preview and showcase models with a focus on performance and basic interaction.

Stack

Next.js (App Router) + TypeScript

three, @react-three/fiber, @react-three/drei

three-mesh-bvh (fast raycast/clipping groundwork)

Features

Gallery page with live 3D thumbnails on cards

Model page with orbit controls and an explode slider

On-screen FPS and draw-call counters for quick diagnostics

Getting Started
# 1) create the app (if you haven’t)
npx create-next-app@latest 3d-gallery --ts
cd 3d-gallery

# 2) install deps
npm i three @react-three/fiber @react-three/drei three-stdlib three-mesh-bvh zustand

# 3) run
npm run dev

Minimal Structure
app/
  layout.tsx
  globals.css
  page.tsx               # gallery
  p/[slug]/
    page.tsx             # model page (Server Component)
    ViewerClient.tsx     # client-side 3D viewer ("use client")
components/
  Thumbnail3D.tsx        # live 3D preview in a card
data/
  models.ts              # model list (replace with DB later)
public/
  models/                # .glb files
  thumbs/                # jpg/png thumbnails

Adding Models

Copy a .glb into public/models/ and a thumbnail into public/thumbs/.

Register it in data/models.ts:

export const MODELS = [
  {
    slug: "helmet",
    name: "Damaged Helmet",
    thumb: "/thumbs/helmet.jpg",
    glb: "/models/helmet.glb",
    settings: { yUp: true, scale: 1, camera: { pos: [2.2, 1.4, 2.2], fov: 45 } }
  }
]


Open /p/helmet or click the card on the home page.

Performance Tips

Ship GLB with meshopt geometry compression and KTX2 (BasisU) textures where possible.

For many cards, limit DPR and lazy-mount previews via IntersectionObserver.

Use three-mesh-bvh for heavy scenes (raycast, future clipping).

Keep draw calls and asset sizes in check; avoid hundreds of unique materials.

Next.js Notes

The 3D viewer is a Client Component ("use client"). Import it directly from the server page; don’t use dynamic(..., { ssr:false }) in Server Components.

R3F hooks (useThree, useFrame) must run inside the <Canvas>. Render HUD via <Html /> from drei within the canvas.

Toward Production

Store assets in S3/CloudFront and serve signed URLs from an API route.

Add a DB (Prisma) with a Product table holding model key and metrics (triangles, materials, file size).

Lock down CSP and CORS; avoid inline scripts.

Asset pipeline: run gltf-transform optimize --meshopt and ... etc1s for KTX2 at upload time.

Model Licenses

Prefer CC0 (Poly Pizza, Kenney) or official glTF sample assets.

Verify licenses for third-party/CAD sources if used commercially.

TODO

Annotations and measurements (edge/vertex snapping)

Clipping planes and saved views

SSE/WS to highlight parts from a scene-aware assistant

Lazy subassembly/LOD loading for large models

It’s intentionally minimal so the 3D takes center stage. Add signed URLs and an admin upload pipeline when you’re ready to look serious.
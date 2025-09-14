export type ModelItem = {
    slug: string;
    name: string;
    thumb: string;
    glb: string;
    settings?: {
      scale?: number;
      yUp?: boolean;
      camera?: { pos: [number, number, number]; fov?: number };
    };
  };
  
  export const MODELS: ModelItem[] = [
    {
      slug: "helmet",
      name: "Damaged Helmet",
      thumb: "/thumbs/helmet.png",
      glb: "/models/helmet.glb",
      settings: { yUp: true, camera: { pos: [2.2, 1.4, 2.2], fov: 45 } }
    },
    {
      slug: "duck",
      name: "Duck",
      thumb: "/thumbs/duck.png",
      glb: "/models/duck.glb",
      settings: { yUp: true, camera: { pos: [3.0, 2.0, 3.2], fov: 45 } }
    }
  ];
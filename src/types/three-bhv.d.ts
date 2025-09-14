import "three";
import type { MeshBVHOptions } from "three-mesh-bvh";

declare module "three" {
  interface BufferGeometry {
    computeBoundsTree?: (options?: MeshBVHOptions) => void;
    disposeBoundsTree?: () => void;
  }
}

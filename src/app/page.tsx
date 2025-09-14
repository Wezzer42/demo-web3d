import Link from "next/link";
import Thumbnail3D from "@/components/Thumbnail3D";
import { MODELS } from "@/data/models";
import "@/app/globals.css";

export default function Page() {
  return (
    <>
      <div className="header">
        <h1 style={{ margin: 0, fontSize: 20 }}>3D Gallery</h1>
      </div>

      <div className="grid">
        {MODELS.map(m => (
          <Link key={m.slug} href={`/p/${m.slug}`} className="card">
            <img src={m.thumb} alt={m.name} width="100%" height="160"
                 style={{ width: "100%", height: 160, objectFit: "cover", display: "block" }} />
            <Thumbnail3D url={m.glb} scale={m.settings?.scale ?? 1} yUp={m.settings?.yUp ?? true} />
            <h3>{m.name}</h3>
          </Link>
        ))}
      </div>
    </>
  );
}

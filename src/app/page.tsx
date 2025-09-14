import Link from "next/link";
import Image from "next/image";
import Thumbnail3D from "@/components/Thumbnail3D";
import { MODELS } from "@/data/models";
import "@/app/globals.css"

export default function Page() {
  return (
    <>
      <div className="header">
        <h1 style={{ margin: 0, fontSize: 20 }}>3D Gallery</h1>
      </div>

      <div className="grid">
        {MODELS.map(m => (
          <Link key={m.slug} href={`/p/${m.slug}`} className="card">
            <Image
              src={m.thumb}
              alt={m.name}
              width={800}
              height={400}
              style={{ 
                width: 160, 
                height: 160, 
                objectFit: "cover", 
                objectPosition: "center",
                display: "block",
                margin: "0 auto" }}
              
              priority
            />
            <Thumbnail3D url={m.glb} scale={m.settings?.scale ?? 1} yUp={m.settings?.yUp ?? true} />
            <h3>{m.name}</h3>
          </Link>
        ))}
      </div>
    </>
  );
}

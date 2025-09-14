import Viewer from "./ViewerClient";
import { MODELS } from "@/data/models";

export default function Page({ params }: { params: { slug: string } }) {
  const model = MODELS.find(m => m.slug === params.slug);
  if (!model) return <div>Not found</div>;
  return (
    <main>
      <a href="/" className="btn" style={{ display:"inline-block", marginBottom:12 }}>← Back</a>
      <h2 style={{ margin:"4px 0 12px" }}>{model.name}</h2>
      <Viewer model={model} />
    </main>
  );
}

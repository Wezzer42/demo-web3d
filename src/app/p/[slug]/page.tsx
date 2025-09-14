import Link from "next/link";
import Viewer from "./ViewerClient";
import { MODELS } from "@/data/models";

export default async function Page({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const model = MODELS.find((m) => m.slug === slug);
  if (!model) return <div>Not found</div>;

  return (
    <main>
      <Link href="/" className="btn" style={{ display: "inline-block", marginBottom: 12 }}>
        ← Back
      </Link>
      <h2 style={{ margin: "4px 0 12px" }}>{model.name}</h2>
      <Viewer model={model} />
    </main>
  );
}

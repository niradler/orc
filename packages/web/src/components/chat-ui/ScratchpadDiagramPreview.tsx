import "@/components/scratchpad/excalidraw-assets";
import { exportToSvg, restore } from "@excalidraw/excalidraw";
import { useEffect, useState } from "react";

export default function ScratchpadDiagramPreview({
  content,
  title,
  expanded,
}: {
  content: string;
  title: string;
  expanded: boolean;
}) {
  const [image, setImage] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    let url: string | undefined;
    async function render() {
      try {
        const scene = restore(JSON.parse(content), null, null);
        const svg = await exportToSvg({
          ...scene,
          appState: { ...scene.appState, exportBackground: true },
        });
        if (!active) return;
        url = URL.createObjectURL(new Blob([svg.outerHTML], { type: "image/svg+xml" }));
        setImage(url);
      } catch {
        if (active) setError("Diagram preview unavailable. Open the scratchpad to inspect it.");
      }
    }
    void render();
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [content]);
  if (error) return <p role="alert">{error}</p>;
  if (!image) return <p role="status">Rendering diagram…</p>;
  // SVG is displayed as an image, never injected into the dashboard document.
  return (
    <img
      data-testid="chat-ui-scratchpad-diagram"
      src={image}
      alt={title}
      className={`w-full object-contain ${expanded ? "max-h-[75vh]" : "max-h-72"}`}
    />
  );
}

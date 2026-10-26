import { type Scratchpad, scratchpadFilename } from "@orc/core/scratchpad";
import { lazy, Suspense, useRef } from "react";
import { api } from "@/api/client";
import { DocumentWorkspace } from "@/components/DocumentWorkspace";
import { useInvalidateScratchpads } from "@/hooks/useScratchpads";
import { ScratchpadHtmlEditor } from "./ScratchpadHtmlEditor";

// Excalidraw is large; only a diagram pad loads it.
const ScratchpadDiagramEditor = lazy(() => import("./ScratchpadDiagramEditor"));

export function ScratchpadEditor({ pad }: { pad: Scratchpad }) {
  if (pad.kind === "doc") return <ScratchpadDocEditor pad={pad} />;
  if (pad.kind === "html") return <ScratchpadHtmlEditor pad={pad} />;
  return (
    <Suspense
      fallback={
        <div role="status" className="p-3 text-sm text-outline">
          Loading diagram editor…
        </div>
      }
    >
      <ScratchpadDiagramEditor pad={pad} />
    </Suspense>
  );
}

function ScratchpadDocEditor({ pad }: { pad: Scratchpad }) {
  const invalidate = useInvalidateScratchpads();
  // The revision the open draft was based on; a stale one makes the API refuse with 409.
  const revision = useRef(pad.revision);
  return (
    <DocumentWorkspace
      documentId={`scratchpad:${pad.id}`}
      path={scratchpadFilename(pad.title, "doc")}
      content={pad.content}
      testId="scratchpad-doc"
      layout="page"
      pageTitle={pad.title}
      onSave={async (content, base) => {
        try {
          const saved = await api.scratchpads.update(pad.id, {
            content,
            if_revision: base === pad.content ? pad.revision : revision.current,
          });
          revision.current = saved.revision;
          return content;
        } finally {
          // On a conflict this loads the other writer's version for Discard.
          await invalidate();
        }
      }}
    />
  );
}

import { lazy, Suspense } from "react";
import type { CodeEditorProps } from "@/components/CodeEditor";

const SourceEditor = lazy(() =>
  import("./SourceEditor").then((module) => ({ default: module.SourceEditor })),
);

export function SourceCodeEditor(props: CodeEditorProps) {
  return (
    <Suspense
      fallback={
        <div style={{ height: props.height ?? 320 }} className="p-3 text-xs text-outline">
          Loading editor...
        </div>
      }
    >
      <SourceEditor {...props} />
    </Suspense>
  );
}

import { lazy, Suspense } from "react";

export type CodeEditorProps = {
  path: string;
  value: string;
  onChange?: (value: string) => void;
  onSave?: () => void;
  readOnly?: boolean;
  height?: number | string;
  testId?: string;
  id?: string;
  label?: string;
  placeholder?: string;
};

const SourceEditor = lazy(() =>
  import("./SourceEditor").then((module) => ({ default: module.SourceEditor })),
);

export function CodeEditor(props: CodeEditorProps) {
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

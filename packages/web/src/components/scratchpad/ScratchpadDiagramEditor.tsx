import "./excalidraw-assets";
import "@excalidraw/excalidraw/index.css";
import {
  CaptureUpdateAction,
  Excalidraw,
  exportToBlob,
  exportToSvg,
  hashElementsVersion,
  restore,
  serializeAsJSON,
} from "@excalidraw/excalidraw";
import type { NonDeletedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { type Scratchpad, scratchpadFilename } from "@orc/core/scratchpad";
import { Check, Copy, ImageDown } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { saveFile } from "@/lib/save-file";
import { useTheme } from "@/lib/theme";
import { PadSaveBar } from "./PadSaveBar";
import { usePadDraft } from "./usePadDraft";

function parseScene(content: string) {
  const data = JSON.parse(content) as {
    elements?: unknown;
    appState?: unknown;
    files?: unknown;
  };
  return restore(data as Parameters<typeof restore>[0], null, null);
}

/** A file as the canvas would save it, so an undo back to it reads as unchanged. */
function loadedFile(text: string) {
  return initialLoaded(parseScene(text), text);
}

function initialLoaded(scene: ReturnType<typeof parseScene>, text: string) {
  return { text, json: serializeAsJSON(scene.elements, scene.appState, scene.files, "local") };
}

type Scene = {
  elements: readonly NonDeletedExcalidrawElement[];
  appState: AppState;
  files: BinaryFiles;
};

function exportName(title: string, extension: string): string {
  return scratchpadFilename(title, "diagram").replace(/\.excalidraw$/, extension);
}

/**
 * The canvas edits a draft of the pad's .excalidraw file. Excalidraw normalizes a scene as it
 * loads (text metrics, versions), so changes before the person first touches the canvas are the
 * loaded file, not edits; only changes after that mark the draft dirty.
 */
export default function ScratchpadDiagramEditor({ pad }: { pad: Scratchpad }) {
  const draft = usePadDraft(pad);
  const { theme } = useTheme();
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the canvas owns the scene after mount
  const initialData = useMemo(() => parseScene(draft.draft), []);
  /** The file text the canvas last loaded or produced. */
  const shown = useRef(draft.draft);
  /** The serialized form of that file as the canvas sees it, to recognise an undo back to it. */
  const [firstLoad] = useState(() => initialLoaded(initialData, draft.draft));
  const loaded = useRef(firstLoad);
  const touched = useRef(false);
  const lastKey = useRef("");

  // A change from elsewhere (an agent's edit while the draft is clean, or Discard) reloads the canvas.
  useEffect(() => {
    if (!api || draft.draft === shown.current) return;
    const scene = parseScene(draft.draft);
    shown.current = draft.draft;
    loaded.current = loadedFile(draft.draft);
    touched.current = false;
    api.updateScene({
      elements: scene.elements,
      appState: { viewBackgroundColor: scene.appState.viewBackgroundColor },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    const files = Object.values(scene.files);
    if (files.length) api.addFiles(files);
    api.history.clear();
  }, [api, draft.draft]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  function onChange(
    elements: readonly NonDeletedExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
  ) {
    // onChange also fires for selection, scrolling and zoom; only the drawing is saved.
    const key = `${hashElementsVersion(elements)}:${appState.viewBackgroundColor}:${Object.keys(files).length}`;
    if (key === lastKey.current) return;
    lastKey.current = key;
    const json = serializeAsJSON(elements, appState, files, "local");
    if (!touched.current) {
      loaded.current.json = json;
      return;
    }
    const next = json === loaded.current.json ? loaded.current.text : json;
    shown.current = next;
    draft.setDraft(next);
  }

  function scene(): Scene | null {
    if (!api) return null;
    return { elements: api.getSceneElements(), appState: api.getAppState(), files: api.getFiles() };
  }

  async function png(current: Scene): Promise<Blob> {
    return exportToBlob({
      ...current,
      appState: { ...current.appState, exportBackground: true },
      mimeType: "image/png",
    });
  }

  async function run(action: (current: Scene) => Promise<void>) {
    const current = scene();
    if (!current) return;
    setExportError(null);
    if (current.elements.length === 0) {
      setExportError("Draw something first; an empty canvas has no image.");
      return;
    }
    try {
      await action(current);
    } catch (cause) {
      setExportError(cause instanceof Error ? cause.message : "Export failed");
    }
  }

  return (
    <div className="space-y-3" data-testid="scratchpad-diagram">
      <PadSaveBar draft={draft}>
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="scratchpad-export-png"
          disabled={!api}
          onClick={() =>
            void run(async (current) => saveFile(await png(current), exportName(pad.title, ".png")))
          }
        >
          <ImageDown size={12} className="mr-1" /> PNG
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="scratchpad-export-svg"
          disabled={!api}
          onClick={() =>
            void run(async (current) => {
              const svg = await exportToSvg({
                ...current,
                appState: { ...current.appState, exportBackground: true },
              });
              saveFile(
                new Blob([svg.outerHTML], { type: "image/svg+xml" }),
                exportName(pad.title, ".svg"),
              );
            })
          }
        >
          <ImageDown size={12} className="mr-1" /> SVG
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="scratchpad-copy-image"
          disabled={!api}
          onClick={() =>
            void run(async (current) => {
              // Safari needs the ClipboardItem built synchronously from a promise.
              await navigator.clipboard.write([new ClipboardItem({ "image/png": png(current) })]);
              setCopied(true);
            })
          }
        >
          {copied ? <Check size={12} className="mr-1" /> : <Copy size={12} className="mr-1" />}
          {copied ? "Copied" : "Copy image"}
        </Button>
      </PadSaveBar>
      {exportError && (
        <p role="alert" className="text-sm text-destructive">
          {exportError}
        </p>
      )}
      <div
        data-testid="scratchpad-canvas"
        className="h-[var(--pad-height,70vh)] min-h-[420px] border border-outline-variant"
        onPointerDownCapture={() => {
          touched.current = true;
        }}
        onKeyDownCapture={() => {
          touched.current = true;
        }}
        onDropCapture={() => {
          touched.current = true;
        }}
        onPasteCapture={() => {
          touched.current = true;
        }}
      >
        <Excalidraw
          initialData={initialData}
          excalidrawAPI={setApi}
          onChange={onChange}
          theme={theme === "dark" ? "dark" : "light"}
          name={pad.title}
          UIOptions={{ canvasActions: { saveToActiveFile: false } }}
        />
      </div>
    </div>
  );
}

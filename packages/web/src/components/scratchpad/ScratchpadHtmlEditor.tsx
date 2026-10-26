import { type Scratchpad, scratchpadFilename } from "@orc/core/scratchpad";
import { Shield, ShieldAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/api/client";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { SourceCodeEditor } from "@/components/SourceCodeEditor";
import { Button } from "@/components/ui/button";
import { useViewParam } from "@/lib/view-params";
import { ModeButton, PadSaveBar } from "./PadSaveBar";
import { usePadDraft } from "./usePadDraft";

const MODES = ["preview", "code", "split"] as const;
type Mode = (typeof MODES)[number];
const MODE_LABEL: Record<Mode, string> = { preview: "Preview", code: "Code", split: "Split" };
const PREVIEW_DELAY_MS = 400;

/** What a page rendered with ORC access calls: `orc.fetch("/tasks")` returns a fetch Response. */
const BRIDGE = "__orcPadFetch";
const BRIDGE_SCRIPT = `<script>window.orc=Object.freeze({fetch:(path,init)=>window.parent.${BRIDGE}(path,init)});</script>`;

/** Puts the bridge first in the page, after any doctype so the page keeps standards mode. */
function withBridge(html: string): string {
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  return doctype
    ? `${doctype[0]}${BRIDGE_SCRIPT}${html.slice(doctype[0].length)}`
    : `${BRIDGE_SCRIPT}${html}`;
}

/**
 * By default the page runs in an opaque-origin sandbox: scripts work, but it cannot read ORC's
 * storage, call the API with the dashboard's credentials, or navigate the dashboard. With
 * `trusted` it runs unsandboxed as the dashboard and gets `window.orc.fetch` for the API.
 */
export function HtmlPreview({
  html,
  title,
  trusted = false,
}: {
  html: string;
  title: string;
  trusted?: boolean;
}) {
  useEffect(() => {
    if (!trusted) return;
    (window as unknown as Record<string, unknown>)[BRIDGE] = apiFetch;
    return () => {
      delete (window as unknown as Record<string, unknown>)[BRIDGE];
    };
  }, [trusted]);
  return (
    <iframe
      // A new frame, so a page never keeps access it was given before.
      key={trusted ? "trusted" : "sandboxed"}
      data-testid="scratchpad-html-preview"
      data-trusted={trusted || undefined}
      title={`${title} preview`}
      sandbox={
        trusted
          ? undefined
          : "allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals"
      }
      referrerPolicy="no-referrer"
      srcDoc={trusted ? withBridge(html) : html}
      className={`h-[var(--pad-height,70vh)] w-full border bg-white ${trusted ? "border-destructive" : "border-outline-variant"}`}
    />
  );
}

export function ScratchpadHtmlEditor({ pad }: { pad: Scratchpad }) {
  const draft = usePadDraft(pad);
  const [mode, setMode] = useViewParam<Mode>("padView", "preview", MODES);
  const [trusted, setTrusted] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // Access is granted to the page you looked at. A new revision keeps it only when it is exactly
  // this tab's draft (your own save); `author` is whatever the writer claims, so it is not checked.
  const seenRevision = useRef(pad.revision);
  useEffect(() => {
    if (pad.revision === seenRevision.current) return;
    seenRevision.current = pad.revision;
    if (pad.content !== draft.draft) setTrusted(false);
  }, [pad.revision, pad.content, draft.draft]);
  // Rebuilding the frame on every keystroke would restart the page's scripts as you type.
  const [preview, setPreview] = useState(draft.draft);
  useEffect(() => {
    const timer = setTimeout(() => setPreview(draft.draft), PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [draft.draft]);

  const editor = (
    <SourceCodeEditor
      path={scratchpadFilename(pad.title, "html")}
      value={draft.draft}
      onChange={draft.setDraft}
      onSave={() => void draft.save()}
      readOnly={draft.saving}
      height="var(--pad-height, 70vh)"
      label="HTML source"
      testId="scratchpad-html-source"
    />
  );
  return (
    <div className="space-y-3" data-testid="scratchpad-html">
      <PadSaveBar draft={draft}>
        {MODES.map((value) => (
          <ModeButton
            key={value}
            active={mode === value}
            onClick={() => setMode(value)}
            testId={`scratchpad-view-${value}`}
          >
            {MODE_LABEL[value]}
          </ModeButton>
        ))}
        {mode !== "code" &&
          (trusted ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="scratchpad-html-sandbox"
              onClick={() => setTrusted(false)}
            >
              <Shield size={12} className="mr-1" /> Back to sandbox
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="scratchpad-html-trust"
              onClick={() => setConfirming(true)}
            >
              <ShieldAlert size={12} className="mr-1" /> Render with ORC access
            </Button>
          ))}
      </PadSaveBar>
      {trusted && mode !== "code" && (
        <p role="status" className="text-sm text-destructive">
          This page runs with ORC access: its scripts act as you and can call the API through{" "}
          <code className="font-mono text-xs">orc.fetch()</code>.
        </p>
      )}
      {mode === "preview" ? (
        <HtmlPreview html={preview} title={pad.title} trusted={trusted} />
      ) : mode === "code" ? (
        editor
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <div className="min-w-0">{editor}</div>
          <HtmlPreview html={preview} title={pad.title} trusted={trusted} />
        </div>
      )}
      <ConfirmDialog
        open={confirming}
        title="Render with ORC access?"
        description="The page's scripts will run as you, without the sandbox. They can read and change anything in ORC through the API, including starting agents and terminals. Only do this for a page you trust. Access ends when you leave the page or someone else edits it."
        confirmLabel="Render with access"
        variant="destructive"
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          setTrusted(true);
        }}
      />
    </div>
  );
}

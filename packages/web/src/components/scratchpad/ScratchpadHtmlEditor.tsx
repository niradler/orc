import { type Scratchpad, scratchpadFilename } from "@orc/core/scratchpad";
import { Shield, ShieldAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { apiFetch, getApiUrl } from "@/api/client";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { SourceCodeEditor } from "@/components/SourceCodeEditor";
import { Button } from "@/components/ui/button";
import { staysInApi } from "@/lib/api-path";
import { useViewParam } from "@/lib/view-params";
import { ModeButton, PadSaveBar } from "./PadSaveBar";
import { usePadDraft } from "./usePadDraft";

const MODES = ["preview", "code", "split"] as const;
type Mode = (typeof MODES)[number];
const MODE_LABEL: Record<Mode, string> = { preview: "Preview", code: "Code", split: "Split" };
const PREVIEW_DELAY_MS = 400;

const SANDBOX =
  "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals";
const FETCH = "orc:fetch";
const RESULT = "orc:fetch:result";

/**
 * What a page rendered with ORC access calls: `orc.fetch("/tasks")` returns a fetch Response.
 * The page stays in the sandbox and asks the dashboard to make each call, so the dashboard never
 * hands it the API secret or its storage. Requests carry this render's nonce: a page the frame
 * navigates to afterwards cannot use the bridge.
 */
const bridgeScript = (nonce: string) => `<script>(()=>{const pending=new Map();let next=0;
addEventListener("message",(e)=>{const d=e.data;if(e.source!==parent||!d||d.type!=="${RESULT}")return;
const p=pending.get(d.id);if(!p)return;pending.delete(d.id);
if(d.error)p.reject(new Error(d.error));
else p.resolve(new Response(d.body,{status:d.status,statusText:d.statusText,headers:d.headers}));});
window.orc=Object.freeze({fetch:(path,init={})=>new Promise((resolve,reject)=>{const id=++next;
pending.set(id,{resolve,reject});
parent.postMessage({type:"${FETCH}",nonce:"${nonce}",id,path:String(path),method:init.method,
headers:[...new Headers(init.headers)],body:init.body},"*");})});})();</script>`;

// getRandomValues, unlike randomUUID, also works when the dashboard is served over plain http.
const newNonce = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

/** Puts the bridge first in the page, after any doctype so the page keeps standards mode. */
function withBridge(html: string, nonce: string): string {
  const bridge = bridgeScript(nonce);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  return doctype ? `${doctype[0]}${bridge}${html.slice(doctype[0].length)}` : `${bridge}${html}`;
}

type FetchRequest = {
  type: typeof FETCH;
  nonce: string;
  id: number;
  path: string;
  method?: string;
  headers: [string, string][];
  body?: BodyInit | null;
};

function isFetchRequest(data: unknown, nonce: string): data is FetchRequest {
  const d = data as Partial<FetchRequest> | null;
  return (
    d?.type === FETCH &&
    d.nonce === nonce &&
    typeof d.id === "number" &&
    typeof d.path === "string" &&
    Array.isArray(d.headers)
  );
}

/** Answers the frame's `orc.fetch` calls with the dashboard's credentials. */
async function answer(frame: Window, request: FetchRequest): Promise<void> {
  try {
    if (!staysInApi(request.path, getApiUrl(), window.location.href))
      throw new Error(`orc.fetch path must be an ORC API path: ${request.path}`);
    const res = await apiFetch(request.path, {
      method: request.method,
      headers: request.headers,
      body: request.body ?? null,
    });
    const body = await res.arrayBuffer();
    frame.postMessage(
      {
        type: RESULT,
        id: request.id,
        status: res.status,
        statusText: res.statusText,
        headers: [...res.headers],
        // Null-body statuses (204, 304) reject any body, even an empty one.
        body: body.byteLength ? body : null,
      },
      "*",
      body.byteLength ? [body] : [],
    );
  } catch (cause) {
    frame.postMessage(
      {
        type: RESULT,
        id: request.id,
        error: cause instanceof Error ? cause.message : "Request failed",
      },
      "*",
    );
  }
}

/**
 * The page always runs in an opaque-origin sandbox: scripts work, but it cannot read ORC's
 * storage or the API secret, or navigate the dashboard. With `trusted` it also gets
 * `window.orc.fetch`, which the dashboard answers as the signed-in user.
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
  const frame = useRef<HTMLIFrameElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each new document gets a new nonce
  const nonce = useMemo(() => (trusted ? newNonce() : ""), [trusted, html]);
  useEffect(() => {
    if (!nonce) return;
    const onMessage = (event: MessageEvent) => {
      const source = frame.current?.contentWindow;
      if (!source || event.source !== source || !isFetchRequest(event.data, nonce)) return;
      void answer(source, event.data);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [nonce]);
  return (
    <iframe
      ref={frame}
      // A new frame, so a page never keeps access it was given before.
      key={trusted ? "trusted" : "sandboxed"}
      data-testid="scratchpad-html-preview"
      data-trusted={trusted || undefined}
      title={`${title} preview`}
      sandbox={SANDBOX}
      referrerPolicy="no-referrer"
      srcDoc={nonce ? withBridge(html, nonce) : html}
      className={`h-(--pad-height,70vh) w-full border bg-white ${trusted ? "border-destructive" : "border-outline-variant"}`}
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
  // Discard swaps in the saved version without a new revision; it was not what was trusted.
  const padDraft = {
    ...draft,
    discard: () => {
      if (pad.content !== draft.draft) setTrusted(false);
      draft.discard();
    },
  };
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
      <PadSaveBar draft={padDraft}>
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
        description="The page's scripts will be able to call the ORC API as you through orc.fetch: read and change anything, including starting agents and terminals. They stay in the sandbox; the dashboard does not hand them your API secret, though API calls such as terminals can reach anything you can. Only do this for a page you trust. Access ends when you go back to the sandbox, leave the page, or someone else edits it."
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

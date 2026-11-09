import {
  type PreviewBrowserState,
  type PreviewFile,
  type PreviewRequest,
  previewLink,
} from "@orc/core/desktop-preview";
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  FolderOpen,
  Globe,
  GripVertical,
  LoaderCircle,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  Save,
  X,
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSearchParams } from "react-router-dom";
import { api, getApiUrl } from "@/api/client";
import { CodeEditor } from "@/components/CodeEditor";
import { useChat } from "@/hooks/useChat";
import { usePanelWidth } from "@/hooks/usePanelWidth";
import { usePreviewDelivery } from "@/hooks/usePreviewDelivery";
import { usePreviewPreferences } from "@/hooks/usePreviewPreferences";
import { desktopBridge } from "@/lib/desktop-bridge";
import {
  DesktopPreviewContext,
  type DesktopPreviewContextValue,
} from "@/lib/desktop-preview-context";
import type { PreviewCompletion } from "@/lib/preview-delivery";
import { SESSION_LIVE_PARAM } from "@/lib/session-home";

type FileTab = {
  id: string;
  file: PreviewFile;
  text: string;
  original: string;
  saving: boolean;
  error: string | null;
  line: number | null;
};
type Model = {
  visible: boolean;
  active: string;
  files: FileTab[];
  browser: PreviewBrowserState | null;
  agentAccess: boolean;
  error: string | null;
  loading: boolean;
};
const initialModel = (): Model => ({
  visible: false,
  active: "browser",
  files: [],
  browser: null,
  agentAccess: true,
  error: null,
  loading: false,
});
const button =
  "inline-flex h-8 min-w-8 shrink-0 items-center justify-center gap-1 rounded px-2 text-xs hover:bg-surface-highest disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-focus";
function error(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Preview could not be opened";
}

export function DesktopPreviewWorkspace({ children }: { children: ReactNode }) {
  const bridge = desktopBridge()?.preview;
  if (!bridge) return children;
  return <PreviewWorkspace>{children}</PreviewWorkspace>;
}

function PreviewWorkspace({ children }: { children: ReactNode }) {
  const bridge = desktopBridge()?.preview;
  const chat = useChat();
  const preferences = usePreviewPreferences();
  const [params] = useSearchParams();
  const rawSession = chat.thread?.id ?? params.get(SESSION_LIVE_PARAM);
  const key = chat.activeKey;
  const [resolved, setResolved] = useState<{ input: string; id: string } | null>(null);
  const session = resolved?.input === rawSession ? resolved.id : rawSession;
  const nativeId = session ?? key;
  const [models, setModels] = useState<Record<string, Model>>({});
  const storedModel = models[key] ?? initialModel();
  const model = {
    ...storedModel,
    agentAccess: storedModel.agentAccess && preferences.settings?.agentBrowserControl === true,
  };
  const current = useRef({ key, session, nativeId, model });
  current.current = { key, session, nativeId, model };
  const modelsRef = useRef(models);
  modelsRef.current = models;
  const edit = useCallback(
    (scope: string, change: (old: Model) => Model) =>
      setModels((all) => ({ ...all, [scope]: change(all[scope] ?? initialModel()) })),
    [],
  );
  const [viewport, setViewport] = useState({
    width: window.innerWidth,
    height: window.innerHeight,
  });
  const width = usePanelWidth({
    storageKey: "orc_preview_width",
    initial: 520,
    min: 320,
    max: Math.max(320, Math.min(1000, viewport.width - 300)),
    edge: "left",
  });
  const [floating, setFloating] = useState<{ x: number; y: number } | null>(null);
  const [moving, setMoving] = useState(false);
  const [address, setAddress] = useState("");
  const panel = useRef<HTMLElement>(null),
    surface = useRef<HTMLDivElement>(null);
  const openSequence = useRef(0);

  useEffect(() => {
    if (!rawSession) {
      setResolved(null);
      return;
    }
    let active = true;
    void api.preview
      .session(rawSession)
      .then((value) => {
        if (active) setResolved({ input: rawSession, id: value.id });
      })
      .catch((cause) => {
        if (active) edit(key, (old) => ({ ...old, error: error(cause) }));
      });
    return () => {
      active = false;
    };
  }, [rawSession, key, edit]);
  useEffect(() => {
    const resize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  useEffect(() => {
    setFloating((old) =>
      old
        ? {
            x: Math.max(0, Math.min(old.x, viewport.width - width.width)),
            y: Math.max(0, Math.min(old.y, viewport.height - 200)),
          }
        : null,
    );
  }, [viewport.width, viewport.height, width.width]);
  useEffect(() => {
    setAddress(model.browser?.url ?? "");
  }, [model.browser?.url]);
  useEffect(
    () =>
      bridge?.onBrowser((state) => {
        const match =
          Object.entries(modelsRef.current).find(
            ([, value]) => value.browser?.session_id === state.session_id,
          )?.[0] ?? (current.current.nativeId === state.session_id ? current.current.key : null);
        if (match) edit(match, (old) => ({ ...old, browser: state }));
      }),
    [bridge, edit],
  );

  const addFile = useCallback(
    (scope: string, file: PreviewFile, line?: number) => {
      const old = modelsRef.current[scope] ?? initialModel();
      const id = file.local_token ?? file.path;
      const existing = old.files.find((tab) => tab.id === id);
      if (!existing && old.files.length >= 8)
        throw new Error("Close a preview tab before opening more files");
      const retained = Object.values(modelsRef.current).reduce(
        (total, model) =>
          total +
          model.files.reduce((sum, tab) => sum + tab.file.content.length + tab.text.length, 0),
        0,
      );
      if (!existing && retained + file.content.length * 2 > 32_000_000)
        throw new Error("Close unused previews before loading more file content");
      edit(scope, (value) => ({
        ...value,
        visible: true,
        active: id,
        loading: false,
        error: null,
        files: existing
          ? value.files.map((tab) => (tab.id === id && line ? { ...tab, line } : tab))
          : [
              ...value.files,
              {
                id,
                file,
                text: file.content,
                original: file.content,
                saving: false,
                error: null,
                line: line ?? null,
              },
            ],
      }));
    },
    [edit],
  );
  const openFile = useCallback(
    async (path: string, line?: number) => {
      const active = current.current;
      if (!active.session)
        throw new Error(
          "Start or select a saved session to preview workspace files, or use Open file",
        );
      const sequence = ++openSequence.current;
      edit(active.key, (old) => ({ ...old, visible: true, loading: true, error: null }));
      try {
        const file = await api.preview.file(active.session, path);
        if (sequence !== openSequence.current)
          throw new DOMException("Preview opening was superseded", "AbortError");
        addFile(active.key, file, line);
      } catch (cause) {
        if (!(cause instanceof DOMException && cause.name === "AbortError"))
          edit(active.key, (old) => ({ ...old, loading: false, error: error(cause) }));
        throw cause;
      }
    },
    [edit, addFile],
  );
  const openUrl = useCallback(
    async (url: string) => {
      const active = current.current;
      edit(active.key, (old) => ({ ...old, visible: true, active: "browser", error: null }));
      if (!bridge) throw new Error("Desktop browser is unavailable");
      const state = await bridge.open(active.nativeId, url);
      edit(active.key, (old) => ({ ...old, browser: state }));
    },
    [bridge, edit],
  );
  const openLink = useCallback(
    async (href: string, baseFile?: string) => {
      if (
        /^\/(?:activity|tasks|sessions|terminals|knowledge|settings|projects|jobs|scratchpad|rules|skills)(?:[/?#]|$)/.test(
          href,
        )
      )
        return false;
      const link = previewLink(href);
      if (!link) return false;
      try {
        if (link.kind === "url") {
          if (preferences.settings?.openLinksIn === "system")
            await bridge?.externalUrl(link.target);
          else await openUrl(link.target);
        } else {
          let target = link.target;
          if (baseFile && !/^(?:[a-z]:[\\/]|[\\/]|file:)/i.test(target))
            target = `${baseFile.replace(/[\\/][^\\/]*$/, "")}/${target}`;
          await openFile(target, link.line);
        }
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === "AbortError") return true;
        edit(current.current.key, (old) => ({ ...old, visible: true, error: error(cause) }));
      }
      return true;
    },
    [openUrl, openFile, edit, bridge, preferences.settings?.openLinksIn],
  );
  const context = useMemo<DesktopPreviewContextValue>(
    () => ({
      openLink,
      openFile,
      toggle: () => edit(current.current.key, (old) => ({ ...old, visible: !old.visible })),
    }),
    [openLink, openFile, edit],
  );
  useEffect(
    () =>
      bridge?.onOpen((request) => {
        if (request.kind === "url" && request.target)
          void openUrl(request.target).catch((cause) =>
            edit(current.current.key, (old) => ({ ...old, visible: true, error: error(cause) })),
          );
        else edit(current.current.key, (old) => ({ ...old, visible: true }));
      }),
    [bridge, openUrl, edit],
  );
  useEffect(() => {
    if (!bridge) return;
    void bridge.allow(nativeId, model.agentAccess);
    return () => {
      void bridge.allow(nativeId, false);
    };
  }, [bridge, nativeId, model.agentAccess]);

  const browserVisible = model.visible && model.active === "browser" && !moving;
  useLayoutEffect(() => {
    if (!bridge) return;
    if (!browserVisible) {
      void bridge.bounds(null, null);
      return;
    }
    let frame = 0;
    let previous = "";
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const element = surface.current;
        const blocked = document.querySelector(
          '[role="dialog"][data-state="open"], [data-radix-popper-content-wrapper]',
        );
        if (!browserVisible || !element || blocked) {
          if (previous !== "hidden") void bridge.bounds(null, null);
          previous = "hidden";
          return;
        }
        const rect = element.getBoundingClientRect();
        const bounds = {
          x: Math.max(0, rect.x),
          y: Math.max(0, rect.y),
          width: rect.width,
          height: rect.height,
        };
        const signature = JSON.stringify([bounds, window.devicePixelRatio]);
        if (signature !== previous) {
          previous = signature;
          void bridge.bounds(nativeId, bounds, current.current.model.browser?.url);
        }
      });
    };
    const observer = new ResizeObserver(update);
    if (panel.current) observer.observe(panel.current);
    if (surface.current) observer.observe(surface.current);
    const mutations = new MutationObserver(update);
    mutations.observe(document.body, {
      attributes: true,
      childList: true,
      subtree: true,
      attributeFilter: ["data-state", "style"],
    });
    window.addEventListener("resize", update);
    update();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", update);
      void bridge.bounds(null, null);
    };
  }, [bridge, browserVisible, nativeId]);

  const executeRequest = useCallback(
    async (request: PreviewRequest): Promise<PreviewCompletion> => {
      const active = current.current;
      const assertSelected = () => {
        if (current.current.key !== active.key || current.current.session !== request.session_id)
          throw new Error("Session changed before preview completed");
      };
      assertSelected();
      let result: unknown;
      if (request.kind === "url") await openUrl(request.target);
      else if (request.kind === "file") await openFile(request.target);
      else if (request.kind === "browser") {
        if (!bridge || !active.model.agentAccess)
          throw new Error("Agent browser control was disabled");
        edit(active.key, (old) => ({ ...old, visible: true, active: "browser" }));
        await new Promise((resolve) => setTimeout(resolve, 100));
        assertSelected();
        if (!current.current.model.agentAccess)
          throw new Error("Agent browser control was disabled");
        result = await bridge.control(request.session_id, request.command);
      }
      assertSelected();
      return { status: request.kind === "browser" ? "completed" : "opened", error: null, result };
    },
    [bridge, edit, openUrl, openFile],
  );
  const deliveryError = usePreviewDelivery(
    resolved?.input === rawSession ? resolved.id : null,
    key,
    model.agentAccess,
    executeRequest,
  );

  const dirty = Object.values(models).some((value) =>
    value.files.some((tab) => tab.text !== tab.original),
  );
  useEffect(() => {
    void bridge?.dirty(dirty);
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, bridge]);
  const selected = model.files.find((tab) => tab.id === model.active);
  const updateFile = (id: string, change: (old: FileTab) => FileTab) =>
    edit(key, (old) => ({
      ...old,
      files: old.files.map((tab) => (tab.id === id ? change(tab) : tab)),
    }));
  async function save(tab: FileTab): Promise<void> {
    if (tab.saving || !tab.file.editable || tab.text === tab.original) return;
    const scope = key,
      text = tab.text;
    edit(scope, (old) => ({
      ...old,
      files: old.files.map((file) =>
        file.id === tab.id ? { ...file, saving: true, error: null } : file,
      ),
    }));
    try {
      if (tab.file.local_token) await bridge?.save(tab.file.local_token, text, tab.original);
      else {
        if (!session) throw new Error("Session is unavailable");
        await api.preview.save(session, tab.file.path, text, tab.original);
      }
      edit(scope, (old) => ({
        ...old,
        files: old.files.map((file) =>
          file.id === tab.id ? { ...file, original: text, saving: false } : file,
        ),
      }));
    } catch (cause) {
      edit(scope, (old) => ({
        ...old,
        files: old.files.map((file) =>
          file.id === tab.id ? { ...file, saving: false, error: error(cause) } : file,
        ),
      }));
    }
  }
  function closeFile(tab: FileTab): void {
    if (tab.saving) return;
    if (
      tab.text !== tab.original &&
      !window.confirm("Discard unsaved changes and close this preview?")
    )
      return;
    if (tab.file.local_token) void bridge?.release(tab.file.local_token);
    edit(key, (old) => ({
      ...old,
      active: old.active === tab.id ? "browser" : old.active,
      files: old.files.filter((file) => file.id !== tab.id),
    }));
  }
  function startMove(event: React.PointerEvent<HTMLButtonElement>): void {
    event.preventDefault();
    const rect = panel.current?.getBoundingClientRect();
    if (!rect) return;
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    setMoving(true);
    const start = { x: event.clientX, y: event.clientY };
    setFloating({ x: rect.x, y: rect.y });
    const move = (pointer: PointerEvent) =>
      setFloating({
        x: Math.max(0, Math.min(rect.x + pointer.clientX - start.x, viewport.width - width.width)),
        y: Math.max(0, Math.min(rect.y + pointer.clientY - start.y, viewport.height - 200)),
      });
    const end = () => {
      setMoving(false);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }
  async function reloadFile(tab: FileTab): Promise<void> {
    if (
      tab.saving ||
      (tab.text !== tab.original &&
        !window.confirm("Discard this draft and reload the file from disk?"))
    )
      return;
    try {
      const file = tab.file.local_token
        ? await bridge?.read(tab.file.local_token)
        : session
          ? await api.preview.file(session, tab.file.path)
          : undefined;
      if (!file) throw new Error("File context is unavailable");
      updateFile(tab.id, (old) => ({
        ...old,
        file,
        text: file.content,
        original: file.content,
        error: null,
      }));
    } catch (cause) {
      updateFile(tab.id, (old) => ({ ...old, error: error(cause) }));
    }
  }
  async function pick(): Promise<void> {
    try {
      const file = await bridge?.pick();
      if (file) {
        try {
          addFile(key, file);
        } catch (cause) {
          if (file.local_token) void bridge?.release(file.local_token);
          throw cause;
        }
      }
    } catch (cause) {
      edit(key, (old) => ({ ...old, error: error(cause) }));
    }
  }
  const canExternal =
    selected &&
    (!!selected.file.local_token ||
      !!selected.file.host ||
      ["127.0.0.1", "localhost", "[::1]"].includes(new URL(getApiUrl(), location.href).hostname));

  return (
    <DesktopPreviewContext.Provider value={context}>
      <div className="flex min-w-0 h-dvh w-full overflow-hidden">
        <div className="flex-1 min-w-0">{children}</div>
        {model.visible && (
          <aside
            ref={panel}
            data-testid="desktop-preview-panel"
            aria-label="Preview"
            style={{
              width: width.width,
              ...(floating
                ? {
                    position: "fixed",
                    left: floating.x,
                    top: floating.y,
                    height: Math.min(740, viewport.height - floating.y - 12),
                    zIndex: 40,
                  }
                : {}),
            }}
            className="relative flex min-w-0 min-h-0 shrink-0 flex-col border-l border-border bg-background shadow-xl"
          >
            {/* biome-ignore lint/a11y/useSemanticElements: pointer-driven adjustable splitter has no native element */}
            <div
              role="separator"
              aria-label="Resize preview"
              aria-orientation="vertical"
              aria-valuenow={width.width}
              aria-valuemin={320}
              aria-valuemax={Math.max(320, Math.min(1000, viewport.width - 300))}
              tabIndex={0}
              data-testid="desktop-preview-resize"
              className="absolute left-0 inset-y-0 z-20 w-2 cursor-col-resize touch-none hover:bg-surface-highest focus-visible:bg-focus"
              {...width.handleProps}
            />
            <header className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2">
              <button
                type="button"
                data-testid="desktop-preview-drag"
                aria-label="Drag preview panel"
                title="Drag to float preview"
                className={`${button} cursor-grab touch-none`}
                onPointerDown={startMove}
              >
                <GripVertical size={15} />
              </button>
              <span className="flex-1 text-sm font-medium">Preview</span>
              <button
                type="button"
                className={button}
                data-testid="desktop-preview-pick"
                onClick={() => void pick()}
              >
                <FolderOpen size={14} />
                Open file
              </button>
              <button
                type="button"
                className={button}
                aria-label={floating ? "Dock preview" : "Float preview"}
                onClick={() =>
                  setFloating(
                    floating ? null : { x: Math.max(0, viewport.width - width.width - 24), y: 64 },
                  )
                }
              >
                {floating ? <PanelRightOpen size={15} /> : <PanelRightClose size={15} />}
              </button>
              <button
                type="button"
                className={button}
                aria-label="Close preview"
                onClick={() => edit(key, (old) => ({ ...old, visible: false }))}
              >
                <X size={16} />
              </button>
            </header>
            <nav
              aria-label="Preview tabs"
              className="flex shrink-0 overflow-x-auto border-b border-border px-2"
            >
              <button
                type="button"
                className={button + (model.active === "browser" ? " bg-surface-highest" : "")}
                aria-pressed={model.active === "browser"}
                onClick={() => edit(key, (old) => ({ ...old, active: "browser" }))}
              >
                <Globe size={14} />
                Browser
              </button>
              {model.files.map((tab) => (
                <div key={tab.id} className="flex shrink-0 items-center">
                  <button
                    type="button"
                    className={button + (model.active === tab.id ? " bg-surface-highest" : "")}
                    title={tab.file.path}
                    aria-pressed={model.active === tab.id}
                    onClick={() => edit(key, (old) => ({ ...old, active: tab.id }))}
                  >
                    {tab.file.path.split(/[\\/]/).pop()}
                    {tab.text !== tab.original ? " ●" : ""}
                  </button>
                  <button
                    type="button"
                    className={button}
                    aria-label={`Close ${tab.file.path}`}
                    disabled={tab.saving}
                    onClick={() => closeFile(tab)}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </nav>
            {(model.error || deliveryError || preferences.error) && (
              <div role="alert" className="shrink-0 break-words px-3 py-2 text-xs text-error">
                {model.error ||
                  preferences.error ||
                  `Agent preview delivery unavailable: ${deliveryError}`}
              </div>
            )}
            {model.loading && (
              <p role="status" className="flex items-center gap-2 px-3 py-2 text-xs">
                <LoaderCircle className="animate-spin" size={13} />
                Opening file…
              </p>
            )}
            {model.active === "browser" ? (
              <>
                <form
                  className="flex shrink-0 items-center gap-1 border-b border-border p-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void openUrl(address.trim()).catch((cause) =>
                      edit(key, (old) => ({ ...old, error: error(cause) })),
                    );
                  }}
                >
                  <button
                    type="button"
                    className={button}
                    aria-label="Back"
                    disabled={!model.browser?.back}
                    onClick={() => void bridge?.navigate(nativeId, "back")}
                  >
                    <ArrowLeft size={14} />
                  </button>
                  <button
                    type="button"
                    className={button}
                    aria-label="Forward"
                    disabled={!model.browser?.forward}
                    onClick={() => void bridge?.navigate(nativeId, "forward")}
                  >
                    <ArrowRight size={14} />
                  </button>
                  <button
                    type="button"
                    className={button}
                    aria-label="Reload page"
                    disabled={!model.browser}
                    onClick={() => void bridge?.navigate(nativeId, "reload")}
                  >
                    <RefreshCw size={14} />
                  </button>
                  <input
                    aria-label="Preview URL"
                    value={address}
                    onChange={(event) => setAddress(event.target.value)}
                    placeholder="https://example.com"
                    className="min-w-0 flex-1 rounded border border-input bg-background px-2 h-8 text-xs"
                  />
                  <button type="submit" className={button}>
                    Go
                  </button>
                  <button
                    type="button"
                    className={button}
                    aria-label="Open in system browser"
                    title="Open in system browser"
                    disabled={!model.browser}
                    onClick={() =>
                      void bridge
                        ?.externalUrl(model.browser?.url ?? "")
                        .catch((cause) => edit(key, (old) => ({ ...old, error: error(cause) })))
                    }
                  >
                    <ExternalLink size={14} />
                  </button>
                </form>
                <label className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2 text-xs text-on-surface-variant">
                  <input
                    type="checkbox"
                    data-testid="preview-agent-access"
                    checked={model.agentAccess}
                    disabled={!preferences.settings?.agentBrowserControl}
                    onChange={(event) =>
                      edit(key, (old) => ({ ...old, agentAccess: event.target.checked }))
                    }
                  />
                  Allow agent browser control
                  <span
                    title="Lets agents in this session read, screenshot and interact with this browser, including pages you sign into. On by default; Settings → Browser controls global access."
                    className="ml-auto cursor-help"
                  >
                    ⓘ
                  </span>
                </label>
                <div role="status" className="shrink-0 px-3 text-xs text-error">
                  {model.browser?.error ?? (model.browser?.loading ? "Loading…" : "")}
                </div>
                <div
                  ref={surface}
                  data-testid="desktop-preview-browser-surface"
                  className="flex min-h-0 flex-1 items-center justify-center text-sm text-on-surface-variant"
                >
                  {!model.browser
                    ? "Open a chat link or enter a URL"
                    : moving
                      ? "Moving preview…"
                      : null}
                </div>
              </>
            ) : selected ? (
              <>
                <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
                  <span
                    title={selected.file.path}
                    className="min-w-0 flex-1 truncate text-xs text-on-surface-variant"
                  >
                    {selected.file.path}
                  </span>
                  <button
                    type="button"
                    className={button}
                    aria-label="Reload file"
                    title="Reload file"
                    disabled={selected.saving}
                    onClick={() => void reloadFile(selected)}
                  >
                    <RefreshCw size={14} />
                  </button>
                  {selected.file.kind === "text" && (
                    <button
                      type="button"
                      data-testid="preview-save"
                      className={button}
                      disabled={
                        !selected.file.editable ||
                        selected.saving ||
                        selected.text === selected.original
                      }
                      onClick={() => void save(selected)}
                    >
                      <Save size={14} />
                      {selected.saving ? "Saving…" : "Save"}
                    </button>
                  )}
                  <button
                    type="button"
                    className={button}
                    aria-label="Open file in VS Code"
                    title={
                      canExternal
                        ? "Open file in VS Code"
                        : "External editor is unavailable for this remote API host"
                    }
                    disabled={!canExternal}
                    onClick={() =>
                      void bridge
                        ?.externalFile(selected.file.path, selected.file.host)
                        .catch((cause) =>
                          updateFile(selected.id, (old) => ({ ...old, error: error(cause) })),
                        )
                    }
                  >
                    <ExternalLink size={14} />
                  </button>
                </div>
                {selected.error && (
                  <div role="alert" className="shrink-0 px-3 py-2 text-xs text-error">
                    {selected.error}
                    {selected.file.kind === "text" ? " Your draft is preserved." : ""}
                  </div>
                )}
                {selected.file.kind === "image" ? (
                  <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-3">
                    <img
                      data-testid="preview-image"
                      src={selected.file.content}
                      alt={selected.file.path.split(/[\\/]/).pop()}
                      className="max-w-full max-h-full object-contain"
                      onError={() =>
                        updateFile(selected.id, (old) => ({
                          ...old,
                          error: "Image cannot be decoded by this desktop",
                        }))
                      }
                    />
                  </div>
                ) : (
                  <DesktopPreviewContext.Provider
                    value={{ ...context, openLink: (href) => openLink(href, selected.file.path) }}
                  >
                    <div
                      className="min-h-0 flex-1 overflow-hidden"
                      data-testid="preview-file-editor"
                    >
                      <CodeEditor
                        key={selected.id}
                        path={selected.file.path}
                        value={selected.text}
                        {...(selected.line ? { line: selected.line } : {})}
                        initialMode={
                          selected.line || selected.text !== selected.original ? "edit" : "read"
                        }
                        readOnly={!selected.file.editable || selected.saving}
                        onChange={(value) =>
                          updateFile(selected.id, (old) => ({ ...old, text: value }))
                        }
                        onSave={() => void save(selected)}
                        height="100%"
                        compact
                        testId="preview-editor-input"
                      />
                    </div>
                  </DesktopPreviewContext.Provider>
                )}
              </>
            ) : null}
          </aside>
        )}
      </div>
    </DesktopPreviewContext.Provider>
  );
}

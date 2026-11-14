import {
  type BrowserAction,
  type PreviewBrowserState,
  type PreviewFile,
  type PreviewProfile,
  type PreviewRequest,
  previewLink,
} from "@orc/core/desktop-preview";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import { api, apiFetch } from "@/api/client";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useChat } from "@/hooks/useChat";
import { usePreviewDelivery } from "@/hooks/usePreviewDelivery";
import { usePreviewPreferences } from "@/hooks/usePreviewPreferences";
import { desktopBridge } from "@/lib/desktop-bridge";
import {
  DesktopPreviewContext,
  type DesktopPreviewContextValue,
  type PreviewFileTab,
} from "@/lib/desktop-preview-context";
import type { PreviewCompletion } from "@/lib/preview-delivery";
import { SESSION_LIVE_PARAM } from "@/lib/session-home";

type FileTab = PreviewFileTab & { file: PreviewFile };
type Model = {
  active: "browser" | string;
  files: FileTab[];
  browser: PreviewBrowserState | null;
  error: string | null;
  loading: boolean;
};
const initialModel = (): Model => ({
  active: "browser",
  files: [],
  browser: null,
  error: null,
  loading: false,
});
function error(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Preview could not be opened";
}

async function saveRecording(
  result: unknown,
  session: string,
  capture: (blob: Blob, name: string) => void,
): Promise<unknown> {
  if (
    !result ||
    typeof result !== "object" ||
    !("type" in result) ||
    !["recording", "download"].includes(String(result.type))
  )
    return result;
  if (!("data" in result) || typeof result.data !== "string" || result.data.length > 21_333_336)
    throw new Error("Invalid browser recording");
  const bytes = Uint8Array.from(atob(result.data), (value) => value.charCodeAt(0));
  const name =
    "name" in result && typeof result.name === "string" ? result.name : "browser-recording.webm";
  const recording = result.type === "recording",
    mime = recording ? "video/webm" : "application/octet-stream";
  const blob = new Blob([bytes], { type: mime });
  capture(blob, name);
  const response = await apiFetch(
    `/desktop-preview/${recording ? "recording" : "artifact"}?session_id=${encodeURIComponent(session)}&name=${encodeURIComponent(name)}`,
    {
      method: "POST",
      headers: { "Content-Type": mime },
      body: blob,
    },
  );
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(
      `Recording could not be saved to this session workspace: ${body?.error ?? `HTTP ${response.status}`}`,
    );
  }
  return response.json();
}

/** Hosts the desktop browser, its file tabs and agent preview delivery, and
 *  publishes them to the session inspector. It renders no panel of its own:
 *  the inspector's Browser tab is the single surface on desktop and web. */
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
  const { pathname } = useLocation();
  // The browser belongs to the full-screen chat page; the side chat stays a
  // plain conversation. `chat=full` is a legacy link to the chat page.
  const chatPage = pathname === "/chat" || params.get("chat") === "full";
  const rawSession =
    params.get(SESSION_LIVE_PARAM) ?? (chatPage ? (chat.thread?.id ?? null) : null);
  const key = chat.activeKey;
  const [resolved, setResolved] = useState<{
    input: string;
    id: string;
    cwd: string;
    host: string | null;
  } | null>(null);
  const session = resolved?.input === rawSession ? resolved.id : rawSession;
  const [models, setModels] = useState<Record<string, Model>>({});
  const [displayBusy, setDisplayBusy] = useState(false);
  const [recorded, setRecorded] = useState<{
    session: string;
    path: string | null;
    saving: boolean;
    url: string;
    blob: Blob;
    name: string;
  } | null>(null);
  const [recordingOpen, setRecordingOpen] = useState(false);
  const recordingUrl = recorded?.url;
  useEffect(
    () => () => {
      if (recordingUrl) URL.revokeObjectURL(recordingUrl);
    },
    [recordingUrl],
  );
  const finishRecording = useCallback(async (result: unknown, id: string) => {
    let blob: Blob | null = null;
    const settle = (path: string | null) =>
      setRecorded((old) => (old && old.blob === blob ? { ...old, path, saving: false } : old));
    try {
      const saved = await saveRecording(result, id, (captured, name) => {
        blob = captured;
        setRecorded({
          session: id,
          path: null,
          saving: true,
          url: URL.createObjectURL(captured),
          blob: captured,
          name,
        });
      });
      settle(
        saved && typeof saved === "object" && "path" in saved && typeof saved.path === "string"
          ? saved.path
          : null,
      );
      return saved;
    } catch (cause) {
      settle(null);
      throw cause;
    }
  }, []);
  const storedModel = models[key] ?? initialModel();
  const nativeId = session ?? storedModel.browser?.session_id ?? key;
  const [chatPermission, setChatPermission] = useState<{
    id: string;
    enabled: boolean;
    saving?: boolean;
  } | null>(null);
  const permissionSequence = useRef(0);
  const agentAccess =
    !!session &&
    chatPermission?.id === nativeId &&
    chatPermission.enabled &&
    !chatPermission.saving &&
    preferences.settings?.agentBrowserControl === true;
  const current = useRef({ key, session, nativeId, model: { ...storedModel, agentAccess } });
  current.current = { key, session, nativeId, model: { ...storedModel, agentAccess } };
  const modelsRef = useRef(models);
  modelsRef.current = models;
  const edit = useCallback(
    (scope: string, change: (old: Model) => Model) =>
      setModels((all) => ({ ...all, [scope]: change(all[scope] ?? initialModel()) })),
    [],
  );
  const [address, setAddress] = useState("");
  const [dialogText, setDialogText] = useState("");
  useEffect(
    () => setDialogText(storedModel.browser?.dialog?.default_prompt ?? ""),
    [storedModel.browser?.dialog?.default_prompt],
  );
  const [surface, setSurface] = useState<HTMLDivElement | null>(null);
  const openListeners = useRef(new Set<() => void>());
  const notifyOpen = useCallback(() => {
    for (const listener of openListeners.current) listener();
  }, []);
  const subscribeOpen = useCallback((listener: () => void) => {
    openListeners.current.add(listener);
    return () => {
      openListeners.current.delete(listener);
    };
  }, []);
  const attachSurface = useCallback((element: HTMLDivElement | null) => setSurface(element), []);
  const openBrowser = useCallback(
    (scope: string, active?: string) => {
      edit(scope, (old) => ({
        ...old,
        active: active ?? "browser",
        loading: false,
        error: null,
      }));
      notifyOpen();
    },
    [edit, notifyOpen],
  );
  const openSequence = useRef(0);
  const [profiles, setProfiles] = useState<PreviewProfile[]>([]);
  const [selectedProfile, setSelectedProfile] = useState<{
    session: string;
    id: string | null;
  } | null>(null);
  useEffect(() => {
    let active = true;
    void Promise.all([bridge?.profiles(), bridge?.selectProfile(nativeId)])
      .then(([list, id]) => {
        if (active) {
          setProfiles(list ?? []);
          setSelectedProfile({ session: nativeId, id: id ?? null });
        }
      })
      .catch((cause) => edit(key, (old) => ({ ...old, error: error(cause) })));
    return () => {
      active = false;
    };
  }, [bridge, nativeId, key, edit]);
  useEffect(
    () =>
      bridge?.onProfiles((list) => {
        setProfiles(list);
        setModels((all) =>
          Object.fromEntries(
            Object.entries(all).map(([key, model]) => [
              key,
              model.browser?.profile_id &&
              !list.some((profile) => profile.id === model.browser?.profile_id)
                ? { ...model, browser: null }
                : model,
            ]),
          ),
        );
        setSelectedProfile((old) =>
          old?.id && !list.some((profile) => profile.id === old.id) ? { ...old, id: null } : old,
        );
      }),
    [bridge],
  );
  useEffect(() => {
    if (!session) return;
    let active = true;
    void bridge
      ?.restore(session)
      .then((browser) => {
        if (active && browser) edit(key, (old) => ({ ...old, browser }));
      })
      .catch((cause) => {
        if (active) edit(key, (old) => ({ ...old, error: error(cause) }));
      });
    return () => {
      active = false;
    };
  }, [bridge, session, key, edit]);

  const selectProfile = useCallback(
    (id: string | null) => {
      if (
        storedModel.browser &&
        !window.confirm(
          "Switch browser profile? This closes this chat's browser tabs. File drafts stay open. Choosing a saved profile shares its logins with other chats using that profile.",
        )
      )
        return;
      void bridge
        ?.selectProfile(nativeId, id)
        .then((selected) => {
          setSelectedProfile({ session: nativeId, id: selected ?? null });
          edit(key, (old) => ({ ...old, browser: null }));
        })
        .catch((cause) => edit(key, (old) => ({ ...old, error: error(cause) })));
    },
    [bridge, edit, key, nativeId, storedModel.browser],
  );

  const changeTab = useCallback(
    (action: "tab_select" | "tab_close", tabId: string) => {
      void bridge
        ?.tab(nativeId, { action, tab_id: tabId })
        .then((browser) => edit(key, (old) => ({ ...old, browser: browser ?? null })))
        .catch((cause) => edit(key, (old) => ({ ...old, error: error(cause) })));
    },
    [bridge, edit, key, nativeId],
  );
  const navigate = useCallback(
    (action: "back" | "forward" | "reload") => {
      void bridge
        ?.navigate(nativeId, action)
        .catch((cause) => edit(key, (old) => ({ ...old, error: error(cause) })));
    },
    [bridge, edit, key, nativeId],
  );
  const newTab = useCallback(() => {
    void bridge
      ?.open(nativeId, storedModel.browser?.url ?? "https://example.com", true)
      .then((browser) => edit(key, (old) => ({ ...old, browser })))
      .catch((cause) => edit(key, (old) => ({ ...old, error: error(cause) })));
  }, [bridge, edit, key, nativeId, storedModel.browser?.url]);

  useEffect(() => {
    const sequence = ++permissionSequence.current;
    setChatPermission(null);
    void bridge
      ?.chatPermission(nativeId)
      .then((enabled) => {
        if (permissionSequence.current === sequence) setChatPermission({ id: nativeId, enabled });
      })
      .catch((cause) => edit(key, (old) => ({ ...old, error: error(cause) })));
    return () => {
      permissionSequence.current++;
    };
  }, [bridge, nativeId, key, edit]);

  const saveChatPermission = useCallback(
    (enabled: boolean) => {
      if (!bridge) return;
      const active = current.current;
      const sequence = ++permissionSequence.current;
      setChatPermission({ id: active.nativeId, enabled, saving: true });
      void bridge
        .chatPermission(active.nativeId, enabled)
        .then((saved) => {
          if (permissionSequence.current === sequence)
            setChatPermission({ id: active.nativeId, enabled: saved });
        })
        .catch((cause) => {
          if (permissionSequence.current === sequence)
            setChatPermission({ id: active.nativeId, enabled: false });
          edit(active.key, (old) => ({ ...old, error: error(cause) }));
        });
    },
    [bridge, edit],
  );

  useEffect(() => {
    if (!rawSession) {
      setResolved(null);
      return;
    }
    let active = true;
    void api.preview
      .session(rawSession)
      .then((value) => {
        if (active)
          setResolved({ input: rawSession, id: value.id, cwd: value.cwd, host: value.host });
      })
      .catch((cause) => {
        if (active) edit(key, (old) => ({ ...old, error: error(cause) }));
      });
    return () => {
      active = false;
    };
  }, [rawSession, key, edit]);
  useEffect(() => {
    setAddress(storedModel.browser?.url ?? "");
  }, [storedModel.browser?.url]);
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
                path: file.path,
                kind: file.kind,
                editable: file.editable,
                ...(file.local_token ? { localToken: file.local_token } : {}),
                host: file.host,
                text: file.content,
                original: file.content,
                saving: false,
                error: null,
                line: line ?? null,
              },
            ],
      }));
      notifyOpen();
    },
    [edit, notifyOpen],
  );
  const openFile = useCallback(
    async (path: string, line?: number) => {
      const active = current.current;
      if (!active.session)
        throw new Error(
          "Start or select a saved session to preview workspace files, or use Open file",
        );
      const sequence = ++openSequence.current;
      edit(active.key, (old) => ({ ...old, loading: true, error: null }));
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
      openBrowser(active.key);
      if (!bridge) throw new Error("Desktop browser is unavailable");
      const state = await bridge.open(active.nativeId, url);
      edit(active.key, (old) => ({ ...old, browser: state }));
    },
    [bridge, edit, openBrowser],
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
        const active = current.current;
        openBrowser(active.key);
        edit(active.key, (old) => ({ ...old, error: error(cause) }));
      }
      return true;
    },
    [openUrl, openFile, edit, bridge, preferences.settings?.openLinksIn, openBrowser],
  );
  useEffect(
    () =>
      bridge?.onOpen((request) => {
        if (request.kind === "url" && request.target)
          void openUrl(request.target).catch((cause) => {
            const active = current.current;
            openBrowser(active.key);
            edit(active.key, (old) => ({ ...old, error: error(cause) }));
          });
        else openBrowser(current.current.key);
      }),
    [bridge, openUrl, edit, openBrowser],
  );
  useEffect(() => {
    if (!bridge) return;
    void bridge
      .allow(nativeId, agentAccess)
      .catch((cause) => edit(key, (old) => ({ ...old, error: error(cause) })));
    return () => {
      bridge.allow(nativeId, false).catch(() => {});
    };
  }, [bridge, nativeId, agentAccess, edit, key]);

  useLayoutEffect(() => {
    if (!bridge) return;
    if (!surface) {
      bridge.bounds(null, null).catch(() => {});
      return;
    }
    let frame = 0;
    let previous = "";
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // A modal or popover above the surface must hide the native view. The
        // narrow inspector is itself a modal Sheet, so ignore overlays that
        // contain the surface instead of treating the panel as a blocker.
        const blocked = [
          ...document.querySelectorAll(
            '[role="dialog"][data-state="open"], [data-radix-popper-content-wrapper]',
          ),
        ].some((overlay) => !overlay.contains(surface));
        if (!surface.isConnected || blocked) {
          if (previous !== "hidden") bridge.bounds(null, null).catch(() => {});
          previous = "hidden";
          return;
        }
        const rect = surface.getBoundingClientRect();
        const bounds = {
          x: Math.max(0, rect.x),
          y: Math.max(0, rect.y),
          width: rect.width,
          height: rect.height,
        };
        const signature = JSON.stringify([bounds, window.devicePixelRatio]);
        if (signature !== previous) {
          previous = signature;
          bridge.bounds(nativeId, bounds, current.current.model.browser?.url).catch(() => {});
        }
      });
    };
    const observer = new ResizeObserver(update);
    observer.observe(surface);
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
      bridge.bounds(null, null).catch(() => {});
    };
  }, [bridge, surface, nativeId]);

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
        openBrowser(active.key);
        await new Promise((resolve) => setTimeout(resolve, 100));
        assertSelected();
        if (!current.current.model.agentAccess)
          throw new Error("Agent browser control was disabled");
        if (request.command?.action === "upload") {
          const files: { name: string; data: string }[] = [];
          let total = 0;
          for (const path of request.command.paths) {
            const response = await apiFetch(
              `/desktop-preview/upload?session_id=${encodeURIComponent(request.session_id)}&target=${encodeURIComponent(path)}`,
            );
            if (!response.ok)
              throw new Error(
                "Upload file is unavailable, too large or outside this session workspace",
              );
            const file = await response.json();
            if (typeof file.name !== "string" || typeof file.data !== "string")
              throw new Error("Browser uploads must total at most 16 MiB");
            total += file.data.length;
            if (total > 22_369_624) throw new Error("Browser uploads must total at most 16 MiB");
            files.push(file);
            assertSelected();
          }
          result = await bridge.upload(
            request.session_id,
            request.command.selector,
            files,
            request.tab_id,
          );
        } else result = await bridge.control(request.session_id, request.command, request.tab_id);
        assertSelected();
        result = await finishRecording(result, request.session_id);
      }
      assertSelected();
      return { status: request.kind === "browser" ? "completed" : "opened", error: null, result };
    },
    [bridge, openUrl, openFile, finishRecording, openBrowser],
  );
  const deliveryError = usePreviewDelivery(
    resolved?.input === rawSession ? resolved.id : null,
    key,
    agentAccess,
    storedModel.browser !== null,
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
  const selected = storedModel.files.find((tab) => tab.id === storedModel.active) ?? null;

  const display = useCallback(
    (command: BrowserAction) => {
      if (!bridge || displayBusy) return;
      const scope = current.current.key,
        id = current.current.nativeId;
      setDisplayBusy(true);
      void finishRecording(
        bridge.display(id, command).finally(() => setDisplayBusy(false)),
        id,
      ).catch((cause) => edit(scope, (old) => ({ ...old, error: error(cause) })));
    },
    [bridge, displayBusy, edit, finishRecording],
  );
  const acceptDialog = useCallback(
    (accept: boolean) => {
      void bridge
        ?.pageDialog(nativeId, accept, dialogText)
        .catch((cause) => edit(key, (old) => ({ ...old, error: error(cause) })));
    },
    [bridge, dialogText, edit, key, nativeId],
  );
  const updateFile = useCallback(
    (id: string, change: (old: FileTab) => FileTab) =>
      edit(current.current.key, (old) => ({
        ...old,
        files: old.files.map((tab) => (tab.id === id ? change(tab) : tab)),
      })),
    [edit],
  );
  const save = useCallback(
    (id: string) => {
      const scope = current.current.key;
      const tab = (modelsRef.current[scope] ?? initialModel()).files.find((item) => item.id === id);
      if (!tab || tab.saving || !tab.editable || tab.text === tab.original) return;
      const text = tab.text;
      edit(scope, (old) => ({
        ...old,
        files: old.files.map((file) =>
          file.id === tab.id ? { ...file, saving: true, error: null } : file,
        ),
      }));
      void (async () => {
        try {
          if (tab.localToken) await bridge?.save(tab.localToken, text, tab.original);
          else {
            const active = current.current;
            if (!active.session) throw new Error("Session is unavailable");
            await api.preview.save(active.session, tab.path, text, tab.original);
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
      })();
    },
    [bridge, edit],
  );
  const closeFile = useCallback(
    (id: string) => {
      const scope = current.current.key;
      const tab = (modelsRef.current[scope] ?? initialModel()).files.find((item) => item.id === id);
      if (!tab || tab.saving) return;
      if (
        tab.text !== tab.original &&
        !window.confirm("Discard unsaved changes and close this preview?")
      )
        return;
      if (tab.localToken) void bridge?.release(tab.localToken);
      edit(scope, (old) => ({
        ...old,
        active: old.active === tab.id ? "browser" : old.active,
        files: old.files.filter((file) => file.id !== tab.id),
      }));
    },
    [bridge, edit],
  );
  const reloadFile = useCallback(
    (id: string) => {
      const scope = current.current.key;
      const tab = (modelsRef.current[scope] ?? initialModel()).files.find((item) => item.id === id);
      if (
        !tab ||
        tab.saving ||
        (tab.text !== tab.original &&
          !window.confirm("Discard this draft and reload the file from disk?"))
      )
        return;
      void (async () => {
        try {
          const active = current.current;
          const file = tab.localToken
            ? await bridge?.read(tab.localToken)
            : active.session
              ? await api.preview.file(active.session, tab.path)
              : undefined;
          if (!file) throw new Error("File context is unavailable");
          edit(scope, (old) => ({
            ...old,
            files: old.files.map((item) =>
              item.id === id
                ? { ...item, file, text: file.content, original: file.content, error: null }
                : item,
            ),
          }));
        } catch (cause) {
          edit(scope, (old) => ({
            ...old,
            files: old.files.map((item) =>
              item.id === id ? { ...item, error: error(cause) } : item,
            ),
          }));
        }
      })();
    },
    [bridge, edit],
  );
  const pick = useCallback(() => {
    void (async () => {
      try {
        const file = await bridge?.pick();
        if (!file) return;
        try {
          addFile(current.current.key, file);
        } catch (cause) {
          if (file.local_token) void bridge?.release(file.local_token);
          throw cause;
        }
      } catch (cause) {
        edit(current.current.key, (old) => ({ ...old, error: error(cause) }));
      }
    })();
  }, [bridge, edit, addFile]);

  const browser = useMemo<DesktopPreviewContextValue["browser"]>(
    () => ({
      state: storedModel.browser,
      address,
      setAddress,
      files: storedModel.files,
      activeFileId: selected?.id ?? null,
      loading: storedModel.loading,
      error: storedModel.error,
      deliveryError,
      profiles,
      profileId: selectedProfile?.session === nativeId ? (selectedProfile.id ?? null) : null,
      profilesPending: selectedProfile?.session !== nativeId,
      displayBusy,
      recording:
        recorded?.session === nativeId
          ? {
              path: recorded.path,
              saving: recorded.saving,
              name: recorded.name,
              url: recorded.url,
            }
          : null,
      dialogText,
      setDialogText,
      dismissError: () => edit(key, (old) => ({ ...old, error: null })),
      open: (url: string) => {
        void openUrl(url).catch((cause) => edit(key, (old) => ({ ...old, error: error(cause) })));
      },
      navigate,
      changeTab,
      newTab,
      display,
      selectProfile,
      showFile: (id: string) => edit(key, (old) => ({ ...old, active: id })),
      closeFile,
      reloadFile,
      saveFile: save,
      editFile: (id: string, text: string) => updateFile(id, (old) => ({ ...old, text })),
      pick,
      external: (url: string) => {
        void bridge
          ?.externalUrl(url)
          .catch((cause) => edit(key, (old) => ({ ...old, error: error(cause) })));
      },
      externalFile: (path: string, host: string | null) => {
        void bridge
          ?.externalFile(path, host)
          .catch((cause) => edit(key, (old) => ({ ...old, error: error(cause) })));
      },
      openRecording: () => setRecordingOpen(true),
      acceptDialog,
      attachSurface,
    }),
    [
      storedModel,
      address,
      selected?.id,
      profiles,
      selectedProfile,
      nativeId,
      displayBusy,
      recorded,
      dialogText,
      deliveryError,
      edit,
      key,
      openUrl,
      navigate,
      changeTab,
      newTab,
      display,
      selectProfile,
      closeFile,
      reloadFile,
      save,
      updateFile,
      pick,
      bridge,
      acceptDialog,
      attachSurface,
    ],
  );

  const context = useMemo<DesktopPreviewContextValue>(
    () => ({
      browserControl: {
        enabled:
          chatPermission?.id === nativeId &&
          chatPermission.enabled &&
          preferences.settings?.agentBrowserControl === true,
        globallyEnabled: preferences.settings?.agentBrowserControl !== false,
        pending:
          chatPermission?.id !== nativeId || !!chatPermission.saving || !preferences.settings,
        error: preferences.error,
        setEnabled: saveChatPermission,
      },
      browser,
      openLink,
      openFile,
      subscribeOpen,
    }),
    [
      browser,
      chatPermission,
      nativeId,
      preferences.settings,
      preferences.error,
      saveChatPermission,
      openLink,
      openFile,
      subscribeOpen,
    ],
  );

  return (
    <DesktopPreviewContext.Provider value={chatPage ? context : null}>
      {children}
      <Dialog
        open={recordingOpen && recorded?.session === nativeId}
        onOpenChange={setRecordingOpen}
      >
        <DialogContent className="max-w-3xl" data-testid="preview-recording-dialog">
          <DialogTitle>
            Browser {recorded?.blob.type === "video/webm" ? "recording" : "download"}
          </DialogTitle>
          <DialogDescription>
            {recorded?.saving
              ? "Saving…"
              : recorded?.path
                ? `Saved to ${recorded.path}`
                : "Workspace save failed. Download this file to preserve it."}
          </DialogDescription>
          {recorded && (
            <>
              {recorded.blob.type === "video/webm" && (
                <video
                  controls
                  src={recorded.url}
                  className="w-full"
                  data-testid="preview-recording-video"
                >
                  <track kind="captions" />
                </video>
              )}
              <a className="text-sm underline" href={recorded.url} download={recorded.name}>
                Download {recorded.name}
              </a>
            </>
          )}
        </DialogContent>
      </Dialog>
    </DesktopPreviewContext.Provider>
  );
}

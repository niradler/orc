import {
  createContext,
  createElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
} from "react";
import { type NavigateOptions, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { CHAT_THREAD_PARAM } from "@/hooks/useChat";
import {
  patchSessionHome,
  readSessionHome,
  type SessionHomeState,
  swapSessionPanes,
} from "@/lib/session-home";

export type SessionHomeNav = ReturnType<typeof useSessionHome>;
const PaneNavigation = createContext("");
const CheckoutNavigation = createContext("");
const WORKSPACE_PARAMS = ["view", "pane", "paneTerminal", "file", "editorMode", "pr"];

export function useWorkspaceSearchParams(): [
  URLSearchParams,
  (
    next: URLSearchParams | ((current: URLSearchParams) => URLSearchParams),
    options?: NavigateOptions,
  ) => void,
] {
  const [params, setParams] = useSearchParams();
  const prefix = useContext(PaneNavigation) + useContext(CheckoutNavigation);
  const scoped = new URLSearchParams(params);
  if (prefix)
    for (const key of WORKSPACE_PARAMS) {
      scoped.delete(key);
      const value = params.get(`${prefix}${key}`);
      if (value !== null) scoped.set(key, value);
    }
  const set = useCallback(
    (
      update: URLSearchParams | ((current: URLSearchParams) => URLSearchParams),
      options?: NavigateOptions,
    ) => {
      setParams((current) => {
        const visible = new URLSearchParams(current);
        if (prefix)
          for (const key of WORKSPACE_PARAMS) {
            visible.delete(key);
            const value = current.get(`${prefix}${key}`);
            if (value !== null) visible.set(key, value);
          }
        const next = typeof update === "function" ? update(visible) : update;
        if (!prefix) return next;
        const merged = new URLSearchParams(next);
        for (const key of WORKSPACE_PARAMS) {
          merged.delete(key);
          const original = current.get(key);
          if (original !== null) merged.set(key, original);
          const value = next.get(key);
          if (value === null) merged.delete(`${prefix}${key}`);
          else merged.set(`${prefix}${key}`, value);
        }
        return merged;
      }, options);
    },
    [prefix, setParams],
  );
  return [scoped, set];
}

export function WorkspaceSearchScope({
  prefix,
  children,
}: {
  prefix: string;
  children: ReactNode;
}) {
  return createElement(CheckoutNavigation.Provider, { value: prefix }, children);
}

export function SessionPaneNavigation({
  prefix,
  children,
}: {
  prefix: string;
  children: ReactNode;
}) {
  return createElement(PaneNavigation.Provider, { value: prefix }, children);
}

export function useSessionHome() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const prefix = useContext(PaneNavigation);
  const go = useCallback(
    (
      patch: Partial<SessionHomeState>,
      options: { chatThread?: string | null; replace?: boolean } = {},
    ) => {
      const raw = new URLSearchParams(window.location.search);
      const otherPrefix = prefix === "parallel" ? "" : "parallel";
      const current =
        patch.terminalId && raw.get(`${otherPrefix}sessionTerminal`) === patch.terminalId
          ? swapSessionPanes(raw)
          : raw;
      const scoped = new URLSearchParams();
      for (const [key, value] of current) {
        if (!prefix || key.startsWith(prefix))
          scoped.set(prefix ? key.slice(prefix.length) : key, value);
      }
      const patched = patchSessionHome(scoped, patch);
      const next = new URLSearchParams(current);
      for (const key of scoped.keys()) if (!patched.has(key)) next.delete(`${prefix}${key}`);
      for (const [key, value] of patched) next.set(`${prefix}${key}`, value);
      if (patch.terminalId) {
        next.set(`${prefix}view`, "terminal");
        next.set(`${prefix}paneTerminal`, patch.terminalId);
        for (const key of ["pane", "file", "pr"]) next.delete(`${prefix}${key}`);
      }
      if (options.chatThread) next.set(`${prefix}${CHAT_THREAD_PARAM}`, options.chatThread);
      else if (options.chatThread === null) next.delete(`${prefix}${CHAT_THREAD_PARAM}`);
      if (next.toString() === raw.toString()) return;
      navigate(
        { search: next.toString(), hash: window.location.hash },
        { replace: options.replace },
      );
    },
    [navigate, prefix],
  );
  const scoped = new URLSearchParams();
  for (const [key, value] of params) {
    if (!prefix || key.startsWith(prefix))
      scoped.set(prefix ? key.slice(prefix.length) : key, value);
  }
  const activate = useCallback(() => {
    const next = new URLSearchParams(window.location.search);
    if (next.get("parallel") !== "1") return;
    if (prefix === "parallel") next.set("sessionPane", "secondary");
    else next.delete("sessionPane");
    navigate({ search: next.toString(), hash: window.location.hash }, { replace: true });
  }, [navigate, prefix]);
  return { ...readSessionHome(scoped), go, activate };
}

const ENTRY_KEY = "orcSessionHomeEntry";

function historyIndex(): number {
  return (window.history.state as { idx?: number } | null)?.idx ?? 0;
}

/** Remembers where full width began so Minimize can return to the page before it. */
export function useSessionHomeEntry(active: boolean) {
  const location = useLocation();
  const entry = useRef<number | null>(null);
  useEffect(() => {
    if (!active) {
      entry.current = null;
      return;
    }
    const state = window.history.state;
    if (state?.key && state.key !== location.key) return;
    const stored: unknown = state?.[ENTRY_KEY];
    if (
      typeof stored === "number" &&
      Number.isInteger(stored) &&
      stored >= 0 &&
      stored <= historyIndex()
    )
      entry.current = stored;
    entry.current ??= historyIndex();
    window.history.replaceState({ ...state, [ENTRY_KEY]: entry.current }, "");
  }, [active, location.key]);
}

export function sessionHomeExitSteps(): number {
  const current = historyIndex();
  const entry: unknown = window.history.state?.[ENTRY_KEY];
  return typeof entry === "number" && Number.isInteger(entry) && entry > 0 && entry <= current
    ? current - entry + 1
    : 0;
}

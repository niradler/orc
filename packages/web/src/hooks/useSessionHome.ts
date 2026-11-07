import { useCallback, useEffect, useRef } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { CHAT_THREAD_PARAM } from "@/hooks/useChat";
import { patchSessionHome, readSessionHome, type SessionHomeState } from "@/lib/session-home";

export type SessionHomeNav = ReturnType<typeof useSessionHome>;

export function useSessionHome() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const go = useCallback(
    (
      patch: Partial<SessionHomeState>,
      options: { chatThread?: string | null; replace?: boolean } = {},
    ) => {
      const current = new URLSearchParams(window.location.search);
      const next = patchSessionHome(current, patch);
      if (options.chatThread) next.set(CHAT_THREAD_PARAM, options.chatThread);
      if (next.toString() === current.toString()) return;
      navigate(
        { search: next.toString(), hash: window.location.hash },
        { replace: options.replace },
      );
    },
    [navigate],
  );
  return { ...readSessionHome(params), go };
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

import { useCallback, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
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

const ENTRY_KEY = "orc_session_home_entry";

function historyIndex(): number {
  return (window.history.state as { idx?: number } | null)?.idx ?? 0;
}

/** Remembers where full width began so Minimize can return to the page before it. */
export function useSessionHomeEntry(active: boolean) {
  useEffect(() => {
    try {
      if (!active) sessionStorage.removeItem(ENTRY_KEY);
      else if (sessionStorage.getItem(ENTRY_KEY) === null)
        sessionStorage.setItem(ENTRY_KEY, String(historyIndex()));
    } catch {}
  }, [active]);
}

export function sessionHomeExitSteps(): number {
  const current = historyIndex();
  let entry = current;
  try {
    const stored = Number(sessionStorage.getItem(ENTRY_KEY) ?? Number.NaN);
    if (Number.isInteger(stored)) entry = stored;
  } catch {}
  return entry > 0 && entry <= current ? current - entry + 1 : 0;
}

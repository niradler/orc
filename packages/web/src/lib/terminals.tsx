import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useMatch, useNavigate } from "react-router-dom";
import {
  api,
  type CreateTerminalInput,
  type LiveSession,
  type Terminal,
  type TerminalsInfo,
} from "@/api/client";
import { terminalFontSize } from "@/lib/terminal-font-size";
import {
  type ConnectionState,
  connectRuntime,
  createRuntime,
  disposeRuntime,
  focusRuntime,
  loadGhostty,
  mountRuntime,
  type RuntimeCallbacks,
  setRuntimeFontSize,
  type TerminalRuntime,
  unmountRuntime,
} from "@/lib/terminal-runtime";

const MAX_EXITED_RETRIES = 2;

interface TerminalsContextValue {
  terminals: Terminal[];
  info: TerminalsInfo | undefined;
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
  activeId: string | null;
  lastActiveId: string | null;
  engineError: string | null;
  connectionOf: (id: string) => ConnectionState | undefined;
  create: (input: CreateTerminalInput) => Promise<Terminal>;
  openLiveSession: (session: LiveSession) => Promise<Terminal>;
  remove: (id: string) => Promise<void>;
  rename: (id: string, name: string) => Promise<Terminal>;
  attach: (id: string, container: HTMLElement) => Promise<void>;
  detach: (id: string) => void;
  sendInput: (id: string, data: string) => void;
  /** Sticky Ctrl from the key bar: the next typed character is sent as its control code. */
  armCtrl: (id: string, onUsed: (() => void) | null) => void;
  focus: (id: string) => void;
  fontSizeOf: (id: string) => number;
  setFontSize: (id: string, size: number) => void;
}

const TerminalsContext = createContext<TerminalsContextValue | null>(null);

const EMPTY_TERMINALS: Terminal[] = [];

export function TerminalsProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const activeId = useMatch("/terminals/:terminalId")?.params.terminalId ?? null;

  const query = useQuery({
    queryKey: ["terminals"],
    queryFn: () => api.terminals.list(null),
    retry: false,
  });
  const info = query.data;
  const terminals = info?.terminals ?? EMPTY_TERMINALS;

  const runtimes = useRef(new Map<string, TerminalRuntime>());
  const pendingContainers = useRef(new Map<string, HTMLElement>());
  const terminalsRef = useRef<Terminal[] | undefined>(undefined);
  terminalsRef.current = info?.terminals;

  const [connections, setConnections] = useState<Record<string, ConnectionState>>({});
  const [engineError, setEngineError] = useState<string | null>(null);
  const [fontSizes, setFontSizes] = useState<Record<string, number>>({});
  const [lastActiveId, setLastActiveId] = useState<string | null>(null);

  useEffect(() => {
    if (activeId) setLastActiveId(activeId);
  }, [activeId]);

  const callbacks = useMemo<RuntimeCallbacks>(
    () => ({
      onState: (id, state) =>
        setConnections((previous) =>
          previous[id] === state ? previous : { ...previous, [id]: state },
        ),
      onExit: () => {
        void queryClient.invalidateQueries({ queryKey: ["terminals"] });
      },
      shouldRetry: (id, attempts) => {
        const known = terminalsRef.current;
        if (!known) return true;
        const terminal = known.find((t) => t.id === id);
        if (!terminal) return false;
        if (terminal.status === "exited") return attempts < MAX_EXITED_RETRIES;
        return true;
      },
    }),
    [queryClient],
  );

  const dropRuntime = useCallback((id: string) => {
    const runtime = runtimes.current.get(id);
    if (runtime) disposeRuntime(runtime);
    runtimes.current.delete(id);
    pendingContainers.current.delete(id);
    setFontSizes((previous) => {
      if (!(id in previous)) return previous;
      const { [id]: _removed, ...rest } = previous;
      return rest;
    });
    setConnections((previous) => {
      if (!(id in previous)) return previous;
      const { [id]: _removed, ...rest } = previous;
      return rest;
    });
  }, []);

  useEffect(() => {
    if (!info) return;
    const known = new Set(info.terminals.map((t) => t.id));
    for (const id of [...runtimes.current.keys()]) {
      if (!known.has(id)) dropRuntime(id);
    }
  }, [info, dropRuntime]);

  useEffect(() => {
    const live = runtimes.current;
    return () => {
      for (const runtime of live.values()) disposeRuntime(runtime);
      live.clear();
    };
  }, []);

  const create = useCallback(
    async (input: CreateTerminalInput): Promise<Terminal> => {
      const terminal = await api.terminals.create(input);
      await queryClient.cancelQueries({ queryKey: ["terminals"] });
      queryClient.setQueryData<TerminalsInfo>(["terminals"], (current) => {
        if (!current || current.terminals.some((t) => t.id === terminal.id)) return current;
        return { ...current, terminals: [...current.terminals, terminal] };
      });
      void queryClient.invalidateQueries({ queryKey: ["terminals"] });
      return terminal;
    },
    [queryClient],
  );

  const openLiveSession = useCallback(
    async (session: LiveSession): Promise<Terminal> => {
      const terminal = await create({
        kind: session.agent === "codex" ? "codex" : "claude",
        live_session_id: session.id,
      });
      const scope =
        new URLSearchParams(window.location.search).get("project") ?? session.project_id;
      navigate(`/terminals/${terminal.id}${scope ? `?project=${encodeURIComponent(scope)}` : ""}`);
      return terminal;
    },
    [create, navigate],
  );

  const rename = useCallback(
    async (id: string, name: string): Promise<Terminal> => {
      const terminal = await api.terminals.rename(id, name);
      await queryClient.cancelQueries({ queryKey: ["terminals"] });
      queryClient.setQueryData<TerminalsInfo>(["terminals"], (current) =>
        current
          ? {
              ...current,
              terminals: current.terminals.map((item) => (item.id === id ? terminal : item)),
            }
          : current,
      );
      void queryClient.invalidateQueries({ queryKey: ["terminals"] });
      return terminal;
    },
    [queryClient],
  );

  const remove = useCallback(
    async (id: string): Promise<void> => {
      await api.terminals.remove(id);
      dropRuntime(id);
      queryClient.setQueryData<TerminalsInfo>(["terminals"], (current) =>
        current
          ? {
              ...current,
              terminals: current.terminals.filter((t) => t.id !== id),
            }
          : current,
      );
      void queryClient.invalidateQueries({ queryKey: ["terminals"] });
    },
    [dropRuntime, queryClient],
  );

  const attach = useCallback(
    async (id: string, container: HTMLElement): Promise<void> => {
      pendingContainers.current.set(id, container);
      const focusedBeforeLoad = document.activeElement;
      try {
        await loadGhostty();
        setEngineError(null);
      } catch (error) {
        setEngineError(error instanceof Error ? error.message : String(error));
        return;
      }
      if (pendingContainers.current.get(id) !== container) return;
      let runtime = runtimes.current.get(id);
      if (!runtime) {
        runtime = createRuntime(id, (size) =>
          setFontSizes((previous) => ({ ...previous, [id]: size })),
        );
        runtimes.current.set(id, runtime);
      }
      mountRuntime(runtime, container, document.activeElement === focusedBeforeLoad);
      void connectRuntime(runtime, callbacks);
    },
    [callbacks],
  );

  const detach = useCallback((id: string) => {
    pendingContainers.current.delete(id);
    const runtime = runtimes.current.get(id);
    if (runtime) unmountRuntime(runtime);
  }, []);

  const connectionOf = useCallback((id: string) => connections[id], [connections]);
  const sendInput = useCallback((id: string, data: string) => {
    const runtime = runtimes.current.get(id);
    if (!runtime || runtime.replaying || runtime.socket?.readyState !== WebSocket.OPEN) return;
    const input =
      data.startsWith("\u001b[") &&
      data.length === 3 &&
      "ABCD".includes(data[2] ?? "") &&
      runtime.term.getMode(1)
        ? data.replace("[", "O")
        : data;
    runtime.socket.send(new TextEncoder().encode(input));
    runtime.textInput?.reset();
  }, []);
  const armCtrl = useCallback((id: string, onUsed: (() => void) | null) => {
    runtimes.current.get(id)?.textInput?.armCtrl(onUsed);
  }, []);
  const focus = useCallback((id: string) => {
    const runtime = runtimes.current.get(id);
    if (runtime) focusRuntime(runtime);
  }, []);
  const fontSizeOf = useCallback((id: string) => fontSizes[id] ?? terminalFontSize(), [fontSizes]);
  const setFontSize = useCallback((id: string, size: number) => {
    const runtime = runtimes.current.get(id);
    if (runtime) setRuntimeFontSize(runtime, size);
  }, []);

  const { refetch: refetchList } = query;
  const refetch = useCallback(() => {
    void refetchList();
  }, [refetchList]);

  const value = useMemo<TerminalsContextValue>(
    () => ({
      terminals,
      info,
      isLoading: query.isLoading,
      error: query.error,
      refetch,
      activeId,
      lastActiveId,
      engineError,
      connectionOf,
      create,
      openLiveSession,
      rename,
      remove,
      attach,
      detach,
      sendInput,
      armCtrl,
      focus,
      fontSizeOf,
      setFontSize,
    }),
    [
      terminals,
      info,
      query.isLoading,
      query.error,
      refetch,
      activeId,
      lastActiveId,
      engineError,
      connectionOf,
      create,
      openLiveSession,
      rename,
      remove,
      attach,
      detach,
      sendInput,
      armCtrl,
      focus,
      fontSizeOf,
      setFontSize,
    ],
  );

  return <TerminalsContext.Provider value={value}>{children}</TerminalsContext.Provider>;
}

export function useTerminals(): TerminalsContextValue {
  const context = useContext(TerminalsContext);
  if (!context) throw new Error("useTerminals must be used inside TerminalsProvider");
  return context;
}

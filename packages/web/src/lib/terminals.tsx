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
import {
  type ConnectionState,
  connectRuntime,
  createRuntime,
  disposeRuntime,
  loadGhostty,
  mountRuntime,
  type RuntimeCallbacks,
  type TerminalRuntime,
  unmountRuntime,
} from "@/lib/terminal-runtime";

const POLL_INTERVAL_MS = 3000;
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
  attach: (id: string, container: HTMLElement) => Promise<void>;
  detach: (id: string) => void;
}

const TerminalsContext = createContext<TerminalsContextValue | null>(null);

const EMPTY_TERMINALS: Terminal[] = [];

export function TerminalsProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const activeId = useMatch("/terminals/:terminalId")?.params.terminalId ?? null;

  const query = useQuery({
    queryKey: ["terminals"],
    queryFn: () => api.terminals.list(),
    // Nothing changes while terminals are unavailable until the API restarts, which a refetch
    // on window focus picks up.
    refetchInterval: (current) => (current.state.data?.ready === false ? false : POLL_INTERVAL_MS),
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
      navigate(`/terminals/${terminal.id}`);
      return terminal;
    },
    [create, navigate],
  );

  const remove = useCallback(
    async (id: string): Promise<void> => {
      await api.terminals.remove(id);
      dropRuntime(id);
      queryClient.setQueryData<TerminalsInfo>(["terminals"], (current) =>
        current ? { ...current, terminals: current.terminals.filter((t) => t.id !== id) } : current,
      );
      void queryClient.invalidateQueries({ queryKey: ["terminals"] });
    },
    [dropRuntime, queryClient],
  );

  const attach = useCallback(
    async (id: string, container: HTMLElement): Promise<void> => {
      pendingContainers.current.set(id, container);
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
        runtime = createRuntime(id);
        runtimes.current.set(id, runtime);
      }
      mountRuntime(runtime, container);
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
      remove,
      attach,
      detach,
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
      remove,
      attach,
      detach,
    ],
  );

  return <TerminalsContext.Provider value={value}>{children}</TerminalsContext.Provider>;
}

export function useTerminals(): TerminalsContextValue {
  const context = useContext(TerminalsContext);
  if (!context) throw new Error("useTerminals must be used inside TerminalsProvider");
  return context;
}

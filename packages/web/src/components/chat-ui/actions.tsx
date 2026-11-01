import { CHAT_UI_CONFIRMED_ACTIONS, type ChatUiActionName, chatUiCatalog } from "@orc/core/chat-ui";
import type { UpdateTaskInput } from "@orc/sdk/types";
import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useTriggerJob, useUpdateJob } from "@/hooks/useJobs";
import { useAddTaskComment, useDeleteTask, useUpdateTask } from "@/hooks/useTasks";

type Params = Record<string, unknown>;
type Outcome = { tone: "success" | "error"; text: string };
type RunAction = (name: string, params: Params | undefined) => Promise<void>;

type ConfirmCopy = { title: string; description: string; label: string; destructive: boolean };
const CONFIRM_COPY: Partial<Record<ChatUiActionName, ConfirmCopy>> = {
  "task.delete": {
    title: "Delete this task?",
    description: "This permanently deletes the task. It cannot be undone.",
    label: "Delete",
    destructive: true,
  },
  "job.run": {
    title: "Run this job now?",
    description: "The job starts immediately with its saved command and settings.",
    label: "Run now",
    destructive: false,
  },
};

const ActionContext = createContext<{ run: RunAction; pending: ReadonlySet<string> } | null>(null);

/** Runs catalog actions as the signed-in user. Never throws: failures render inline. */
export function useChatUiAction() {
  const context = useContext(ActionContext);
  if (!context) throw new Error("useChatUiAction must be used inside ChatUiActionProvider");
  return context;
}

export function ChatUiActionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();
  const addComment = useAddTaskComment();
  const triggerJob = useTriggerJob();
  const updateJob = useUpdateJob();
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [confirming, setConfirming] = useState<{ name: ChatUiActionName; id: string } | null>(null);
  const resolveConfirm = useRef<((ok: boolean) => void) | null>(null);

  const confirm = useCallback(
    (name: ChatUiActionName, id: string) =>
      new Promise<boolean>((resolve) => {
        resolveConfirm.current?.(false);
        resolveConfirm.current = resolve;
        setConfirming({ name, id });
      }),
    [],
  );
  const settleConfirm = (ok: boolean) => {
    resolveConfirm.current?.(ok);
    resolveConfirm.current = null;
    setConfirming(null);
  };

  const execute = useCallback(
    async (name: ChatUiActionName, params: Params): Promise<string> => {
      const id = params.id as string;
      switch (name) {
        case "task.update": {
          const { id: _id, ...data } = params;
          await updateTask.mutateAsync({ id, ...(data as UpdateTaskInput) });
          return "Task updated";
        }
        case "task.comment":
          await addComment.mutateAsync({ id, content: params.content as string });
          return "Comment added";
        case "task.delete":
          await deleteTask.mutateAsync(id);
          await qc.invalidateQueries({ queryKey: ["task", id] });
          return "Task deleted";
        case "job.run":
          await triggerJob.mutateAsync(id);
          await qc.invalidateQueries({ queryKey: ["job", id] });
          return "Job run started";
        case "job.setEnabled":
          await updateJob.mutateAsync({ id, enabled: params.enabled as boolean });
          return params.enabled ? "Job enabled" : "Job disabled";
      }
    },
    [qc, updateTask, addComment, deleteTask, triggerJob, updateJob],
  );

  const run = useCallback<RunAction>(
    async (rawName, rawParams) => {
      const definition = chatUiCatalog.data.actions[rawName as ChatUiActionName];
      if (!definition) {
        setOutcome({ tone: "error", text: `Unknown action: ${rawName}` });
        return;
      }
      const name = rawName as ChatUiActionName;
      // Dynamic params are resolved by json-render before this point; check the final values.
      const parsed = definition.params.safeParse(rawParams ?? {});
      if (!parsed.success) {
        setOutcome({ tone: "error", text: `Invalid ${name} parameters` });
        return;
      }
      const params = parsed.data as Params;
      if (CHAT_UI_CONFIRMED_ACTIONS.has(name) && !(await confirm(name, params.id as string)))
        return;
      const key = `${name}:${params.id as string}`;
      setPending((current) => new Set(current).add(key));
      setOutcome(null);
      try {
        setOutcome({ tone: "success", text: await execute(name, params) });
      } catch (error) {
        setOutcome({ tone: "error", text: error instanceof Error ? error.message : String(error) });
      } finally {
        setPending((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    },
    [confirm, execute],
  );

  const value = useMemo(() => ({ run, pending }), [run, pending]);
  const copy = confirming ? CONFIRM_COPY[confirming.name] : undefined;
  return (
    <ActionContext.Provider value={value}>
      {children}
      {outcome && (
        <p
          role={outcome.tone === "error" ? "alert" : "status"}
          data-testid="chat-ui-action-result"
          className={`mt-1.5 text-xs ${outcome.tone === "error" ? "text-error" : "text-on-surface-variant"}`}
        >
          {outcome.text}
        </p>
      )}
      <ConfirmDialog
        open={Boolean(confirming)}
        title={copy?.title ?? "Confirm action"}
        description={
          confirming && copy
            ? `${copy.description} Target ${confirming.name === "task.delete" ? "task" : "job"}: ${confirming.id}.`
            : "This runs as you through the ORC API."
        }
        confirmLabel={copy?.label ?? "Confirm"}
        variant={copy?.destructive === false ? "warning" : "destructive"}
        onConfirm={() => settleConfirm(true)}
        onCancel={() => settleConfirm(false)}
      />
    </ActionContext.Provider>
  );
}

/** json-render handlers keyed by catalog action name, delegating to the shared runner. */
export function useChatUiHandlers(): Record<string, (params: Params) => Promise<void>> {
  const { run } = useChatUiAction();
  return useMemo(
    () =>
      Object.fromEntries(
        Object.keys(chatUiCatalog.data.actions).map((name) => [
          name,
          (params: Params) => run(name, params),
        ]),
      ),
    [run],
  );
}

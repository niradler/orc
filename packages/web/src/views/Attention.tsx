import type { HumanRequest, HumanResponse } from "@orc/core/human-requests";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MessageSquare, Pencil } from "lucide-react";
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, type LiveSession } from "@/api/client";
import { HelpPopover } from "@/components/HelpPopover";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ViewHeader } from "@/components/ViewHeader";
import { useAttentionChatWaits } from "@/hooks/useAttentionChatWaits";
import { useAttentionSessions } from "@/hooks/useAttentionSessions";
import { useHumanRequests } from "@/hooks/useHumanRequests";
import { scopedSessionPath } from "@/lib/live-sessions";
import { runningTerminalForSession, terminalPath } from "@/lib/terminal-links";
import { useTerminals } from "@/lib/terminals";

function ObservedSessionCard({ session }: { session: LiveSession }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { terminals } = useTerminals();
  const terminal = runningTerminalForSession(terminals, session.id);
  return (
    <article
      data-testid={`attention-session-${session.id}`}
      className="grid min-w-0 gap-2 border-b border-border py-3 @xl/attention:grid-cols-[minmax(0,1fr)_auto] @xl/attention:items-center"
    >
      <div className="min-w-0 space-y-1">
        <h2 className="text-sm font-medium wrap-break-word">{session.name ?? "Coding session"}</h2>
        <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <span className="text-warning">Question</span>
          <span>{session.agent}</span>
          <span>{session.host ?? "Local"}</span>
          <span>Reply in the original session</span>
        </p>
      </div>
      <div className="flex flex-wrap gap-1">
        {terminal && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              navigate(scopedSessionPath(terminalPath(terminal.id), params.get("project")))
            }
          >
            Open terminal
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            const next = new URLSearchParams(params);
            next.set("session", session.id);
            navigate({ pathname: "/sessions", search: next.toString() });
          }}
        >
          View session
        </Button>
      </div>
    </article>
  );
}

function RequestCard({ request }: { request: HumanRequest }) {
  const [answer, setAnswer] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [editingAnswer, setEditingAnswer] = useState(request.input.choices.length === 0);
  const client = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const respond = useMutation({
    mutationFn: (response: HumanResponse) =>
      api.humanRequests.respond(request.id, request.version, response),
    onSettled: () => client.invalidateQueries({ queryKey: ["human-requests"] }),
  });
  const cancel = useMutation({
    mutationFn: () => api.humanRequests.cancel(request.id, request.version),
    onSettled: () => client.invalidateQueries({ queryKey: ["human-requests"] }),
  });
  const pending = request.status === "pending";
  const busy = respond.isPending || cancel.isPending;
  const secondaryActions = (
    <>
      {request.input.origin.chat_thread_id && (
        <Button
          data-testid="attention-open-chat"
          size="sm"
          variant="ghost"
          type="button"
          onClick={() => {
            const next = new URLSearchParams(params);
            next.set("chat", "open");
            next.set("chatThread", request.input.origin.chat_thread_id ?? "");
            navigate({ search: next.toString() });
          }}
        >
          <MessageSquare size={14} /> Open chat
        </Button>
      )}
      {(pending || request.status === "unavailable") && (
        <Button
          data-testid="attention-cancel"
          size="sm"
          variant="ghost"
          type="button"
          disabled={busy}
          onClick={() => cancel.mutate()}
        >
          {cancel.isPending
            ? pending
              ? "Cancelling…"
              : "Dismissing…"
            : pending
              ? "Cancel request"
              : "Dismiss"}
        </Button>
      )}
    </>
  );
  const actionInput = request.input.action?.input;
  const nativeItem =
    actionInput?.item && typeof actionInput.item === "object"
      ? (actionInput.item as Record<string, unknown>)
      : undefined;
  const nativeDetails = typeof actionInput?.threadId === "string";
  const reviewInput = nativeDetails
    ? {
        ...Object.fromEntries(
          Object.entries(actionInput ?? {}).filter(
            ([key]) =>
              ![
                "threadId",
                "turnId",
                "itemId",
                "startedAtMs",
                "item",
                "availableDecisions",
                "proposedExecpolicyAmendment",
                "commandActions",
                "kind",
              ].includes(key),
          ),
        ),
        ...(nativeItem?.changes ? { changes: nativeItem.changes } : {}),
      }
    : actionInput;
  return (
    <article
      data-testid={`attention-request-${request.id}`}
      className="grid min-w-0 gap-3 border-b border-border py-4 @4xl/attention:grid-cols-[minmax(0,1fr)_minmax(16rem,22rem)] @4xl/attention:gap-x-8"
    >
      <div className="min-w-0 space-y-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span className={pending ? "text-warning" : undefined}>
            {request.input.kind === "question" ? "Question" : "Approval"} ·{" "}
            {request.input.origin.backend}
          </span>
          {(request.input.rule_binding || request.input.rule_bindings?.length) && (
            <span>ORC rule</span>
          )}
          {!pending && (
            <span>
              {request.status === "unavailable"
                ? "Agent unavailable"
                : "Answered · waiting for agent delivery"}
            </span>
          )}
        </div>
        <h2 className="max-w-[78ch] text-sm font-medium whitespace-pre-wrap wrap-break-word">
          {request.input.prompt}
        </h2>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span
            className="min-w-0 max-w-full truncate"
            title={request.input.origin.session_title ?? request.input.origin.session_id}
          >
            {request.input.origin.session_title ?? `Session ${request.input.origin.session_id}`}
            {request.input.origin.execution_host !== undefined &&
              ` · ${request.input.origin.execution_host ?? "Local"}`}
          </span>
          <span className="flex flex-wrap gap-x-2" data-testid="attention-date">
            <span>
              Created{" "}
              <time
                dateTime={new Date(request.created_at).toISOString()}
                title={new Date(request.created_at).toLocaleString()}
              >
                {new Date(request.created_at).toLocaleString(undefined, {
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </time>
            </span>
            {request.responded_at !== null && (
              <span>
                Answered{" "}
                <time
                  dateTime={new Date(request.responded_at).toISOString()}
                  title={new Date(request.responded_at).toLocaleString()}
                >
                  {new Date(request.responded_at).toLocaleString(undefined, {
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </time>
              </span>
            )}
          </span>
        </div>
        {request.input.action && (
          <div className="min-w-0 space-y-2 text-sm">
            <dl className="flex min-w-0 flex-wrap gap-x-4 gap-y-1 text-xs">
              <div className="flex min-w-0 gap-1">
                <dt className="text-muted-foreground">Host:</dt>
                <dd className="wrap-anywhere">{request.input.action.host}</dd>
              </div>
              <div className="flex min-w-0 gap-1">
                <dt className="text-muted-foreground">Folder:</dt>
                <dd className="wrap-anywhere">{request.input.action.cwd}</dd>
              </div>
            </dl>
            <section
              aria-label="Requested action"
              // biome-ignore lint/a11y/noNoninteractiveTabindex: approval details must be keyboard-scrollable before a decision.
              tabIndex={0}
              className="max-h-64 overflow-auto whitespace-pre-wrap wrap-anywhere rounded-md border border-border p-2 font-mono text-xs focus-visible:outline-2 focus-visible:outline-focus"
            >
              <pre data-testid="attention-action" className="whitespace-pre-wrap wrap-anywhere">
                {request.input.action.tool}
                {"\n"}
                {JSON.stringify(
                  reviewInput && Object.keys(reviewInput).length ? reviewInput : actionInput,
                  null,
                  2,
                )}
              </pre>
            </section>
            {nativeDetails && (
              <details className="text-xs text-outline">
                <summary className="min-h-11 cursor-pointer py-1 sm:min-h-8 [@media(pointer:coarse)]:min-h-11">
                  Full request details
                </summary>
                <pre className="whitespace-pre-wrap break-all mt-2">
                  {JSON.stringify(actionInput, null, 2)}
                </pre>
              </details>
            )}
          </div>
        )}
      </div>
      <div className="min-w-0 space-y-2">
        {pending && request.input.kind === "question" && (
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              respond.mutate({
                kind: "question",
                answer,
                ...(selected.length ? { selected_choices: selected } : {}),
              });
            }}
          >
            <div className="grid gap-1 @xl/attention:grid-cols-2 @4xl/attention:grid-cols-1">
              {request.input.choices.map((choice) => (
                <label
                  key={choice}
                  className={`flex min-h-11 min-w-0 cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-sm sm:min-h-8 [@media(pointer:coarse)]:min-h-11 hover:bg-surface ${
                    (request.input.multi_select ? selected.includes(choice) : answer === choice)
                      ? "bg-surface-highest"
                      : ""
                  }`}
                  data-testid={`attention-choice-${choice}`}
                >
                  <input
                    type={request.input.multi_select ? "checkbox" : "radio"}
                    name={`choice-${request.id}`}
                    checked={
                      request.input.multi_select ? selected.includes(choice) : answer === choice
                    }
                    disabled={busy}
                    className="mt-1 size-3.5 shrink-0 accent-primary"
                    onChange={() => {
                      if (request.input.multi_select) {
                        const next = selected.includes(choice)
                          ? selected.filter((item) => item !== choice)
                          : [...selected, choice];
                        setSelected(next);
                        setAnswer(next.join(", "));
                      } else setAnswer(choice);
                    }}
                  />
                  <span className="min-w-0 wrap-anywhere">
                    <span>{choice}</span>
                    {Object.keys(request.input.choice_descriptions).includes(choice) &&
                      request.input.choice_descriptions[choice] && (
                        <span className="block text-xs font-normal text-muted-foreground">
                          {request.input.choice_descriptions[choice]}
                        </span>
                      )}
                  </span>
                </label>
              ))}
            </div>
            {request.input.choices.length > 0 && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                data-testid="attention-edit-answer"
                aria-expanded={editingAnswer}
                aria-controls={`answer-editor-${request.id}`}
                disabled={busy}
                onClick={() => setEditingAnswer(!editingAnswer)}
              >
                <Pencil size={14} /> {editingAnswer ? "Hide editor" : "Write an answer"}
              </Button>
            )}
            <label
              id={`answer-editor-${request.id}`}
              htmlFor={`answer-${request.id}`}
              hidden={!editingAnswer}
              className={editingAnswer ? "block text-sm space-y-1" : "hidden"}
            >
              <span>Your answer</span>
              <Textarea
                id={`answer-${request.id}`}
                data-testid="attention-answer"
                value={answer}
                onChange={(event) => {
                  setAnswer(event.target.value);
                  setSelected([]);
                }}
                maxLength={16000}
                disabled={busy}
                rows={2}
                className="min-h-20 max-h-48 resize-y"
              />
            </label>
            <div className="flex flex-wrap items-center gap-1">
              <Button
                size="sm"
                data-testid="attention-send"
                type="submit"
                disabled={!answer.trim() || busy}
              >
                {respond.isPending ? "Sending…" : "Send answer"}
              </Button>
              {secondaryActions}
            </div>
          </form>
        )}
        {pending && request.input.kind === "approval" && (
          <div className="flex flex-wrap items-center gap-1">
            <Button
              size="sm"
              data-testid="attention-approve"
              disabled={busy}
              onClick={() => respond.mutate({ kind: "approval", approved: true })}
            >
              Approve
            </Button>
            <Button
              size="sm"
              data-testid="attention-deny"
              variant="outline"
              disabled={busy}
              onClick={() => respond.mutate({ kind: "approval", approved: false })}
            >
              Deny
            </Button>
            <HelpPopover label="Approval permissions">
              Your approval lets this agent continue with its existing permissions.
            </HelpPopover>
            {secondaryActions}
          </div>
        )}
        {request.response && (
          <p data-testid="attention-response" className="text-sm whitespace-pre-wrap wrap-anywhere">
            {request.response.kind === "question"
              ? request.response.answer
              : request.response.approved
                ? "Approved"
                : "Denied"}
          </p>
        )}
        {request.delivery_error && (
          <p role="status" className="text-sm text-error">
            {request.delivery_error}
          </p>
        )}
        {!pending && <div className="flex flex-wrap items-center gap-1">{secondaryActions}</div>}
        {cancel.error && <p role="alert">{cancel.error.message}</p>}
        {respond.error && (
          <p role="alert" data-testid="attention-error" className="text-sm text-destructive">
            {respond.error.message}
          </p>
        )}
      </div>
    </article>
  );
}

export default function Attention() {
  const state = useHumanRequests();
  const observed = useAttentionSessions();
  const chatWaits = useAttentionChatWaits();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  return (
    <div data-testid="attention-view" className="@container/attention min-w-0">
      <ViewHeader
        title="Attention needed"
        meta={
          state.data ? state.data.length + observed.data.length + chatWaits.data.length : undefined
        }
        help="Questions and approvals from your agents. Live Codex questions can also appear as session notices. Direct responses require an ORC connection or a supported hook; ACPX CLI does not expose pending approvals to ORC."
      />
      {state.isLoading && <p role="status">Loading requests…</p>}
      {state.error && <p role="alert">{state.error.message}</p>}
      {observed.error && (
        <p role="alert">Could not check waiting sessions: {observed.error.message}</p>
      )}
      {chatWaits.error && (
        <p role="alert">Could not check waiting chats: {chatWaits.error.message}</p>
      )}
      {state.data?.length === 0 &&
        !state.error &&
        !observed.isLoading &&
        !observed.error &&
        !chatWaits.isLoading &&
        !chatWaits.error &&
        observed.data.length === 0 &&
        chatWaits.data.length === 0 && (
          <p
            data-testid="attention-empty"
            className="grid min-h-[min(40dvh,20rem)] place-items-center text-sm text-muted-foreground"
          >
            Nothing needs your attention.
          </p>
        )}
      {state.data?.length === 100 && (
        <p className="text-sm text-outline mb-4">
          Showing the first 100 requests, with pending requests first. Resolving or dismissing
          entries reveals more.
        </p>
      )}
      <div>
        {chatWaits.data.map((wait) => (
          <article
            key={`${wait.thread_id}:${wait.request_key}`}
            data-testid={`attention-chat-${wait.thread_id}`}
            className="grid min-w-0 gap-2 border-b border-border py-3 @xl/attention:grid-cols-[minmax(0,1fr)_auto] @xl/attention:items-center"
          >
            <div className="min-w-0 space-y-1">
              <h2 className="text-sm font-medium wrap-break-word">{wait.title}</h2>
              <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                <span className="text-warning">
                  {wait.kind === "question" ? "Question" : "Approval"}
                </span>
                <span>{wait.agent}</span>
                <span>{wait.host ?? "Local"}</span>
                <span>Chat</span>
              </p>
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="justify-self-start @xl/attention:justify-self-end"
              onClick={() => {
                const next = new URLSearchParams(params);
                next.set("chat", "open");
                next.set("chatThread", wait.thread_id);
                navigate({ search: next.toString() });
              }}
            >
              Open chat
            </Button>
          </article>
        ))}
        {observed.data.map((session) => (
          <ObservedSessionCard key={session.id} session={session} />
        ))}
        {state.data?.map((request) => (
          <RequestCard key={request.id} request={request} />
        ))}
      </div>
    </div>
  );
}

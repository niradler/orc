import type { HumanRequest, HumanResponse } from "@orc/core/human-requests";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, type LiveSession } from "@/api/client";
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
      className="rounded-lg border border-border bg-surface p-5 space-y-4"
    >
      <p className="text-xs text-outline">
        Question · {session.agent} · {session.host ?? "Local"} · Observed session
      </p>
      <h2 className="text-base font-medium">{session.name ?? "Coding session"}</h2>
      <p className="text-sm text-outline">
        Waiting for your answer. Answer in the original session.
      </p>
      <div className="flex flex-wrap gap-3">
        {terminal && (
          <Button
            variant="outline"
            onClick={() =>
              navigate(scopedSessionPath(terminalPath(terminal.id), params.get("project")))
            }
          >
            Open terminal
          </Button>
        )}
        <Button
          variant="outline"
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
      className="rounded-lg border border-border bg-surface p-5 space-y-4"
    >
      <div className="flex flex-wrap justify-between gap-2 text-xs text-outline">
        <span>
          {request.input.kind === "question" ? "Question" : "Approval"} ·{" "}
          {request.input.origin.backend} ·{" "}
          {request.input.rule_binding || request.input.rule_bindings?.length
            ? "ORC rule"
            : "Agent request"}
        </span>
        <span>
          {pending
            ? "Waiting for you"
            : request.status === "unavailable"
              ? "Agent unavailable"
              : "Answered · waiting for agent delivery"}
        </span>
      </div>
      <h2 className="text-base font-medium whitespace-pre-wrap">{request.input.prompt}</h2>
      <p className="text-xs text-outline break-all">
        {request.input.origin.session_title ?? `Session ${request.input.origin.session_id}`}
        {request.input.origin.execution_host !== undefined &&
          ` · ${request.input.origin.execution_host ?? "Local"}`}
      </p>
      {request.input.origin.chat_thread_id && (
        <Button
          data-testid="attention-open-chat"
          variant="outline"
          onClick={() => {
            const next = new URLSearchParams(params);
            next.set("chat", "open");
            next.set("chatThread", request.input.origin.chat_thread_id ?? "");
            navigate({ search: next.toString() });
          }}
        >
          Open chat
        </Button>
      )}
      {request.input.action && (
        <div className="space-y-2 text-sm">
          <p>
            Host: <strong>{request.input.action.host}</strong> · Folder: {request.input.action.cwd}
          </p>
          <pre
            data-testid="attention-action"
            className="whitespace-pre-wrap break-all rounded-md bg-background p-3 text-xs"
          >
            {request.input.action.tool}
            {"\n"}
            {JSON.stringify(
              reviewInput && Object.keys(reviewInput).length ? reviewInput : actionInput,
              null,
              2,
            )}
          </pre>
          {nativeDetails && (
            <details className="text-xs text-outline">
              <summary className="cursor-pointer">Full request details</summary>
              <pre className="whitespace-pre-wrap break-all mt-2">
                {JSON.stringify(actionInput, null, 2)}
              </pre>
            </details>
          )}
          <p className="text-outline">
            Your approval lets this agent continue with its existing permissions.
          </p>
        </div>
      )}
      {pending && request.input.kind === "question" && (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            respond.mutate({
              kind: "question",
              answer,
              ...(selected.length ? { selected_choices: selected } : {}),
            });
          }}
        >
          <div className="flex flex-wrap gap-2">
            {request.input.choices.map((choice) => (
              <Button
                key={choice}
                variant={
                  (request.input.multi_select ? selected.includes(choice) : answer === choice)
                    ? "default"
                    : "outline"
                }
                type="button"
                className="h-auto min-h-9 flex-col items-start whitespace-normal text-left"
                disabled={respond.isPending}
                data-testid={`attention-choice-${choice}`}
                onClick={() => {
                  if (request.input.multi_select) {
                    const next = selected.includes(choice)
                      ? selected.filter((item) => item !== choice)
                      : [...selected, choice];
                    setSelected(next);
                    setAnswer(next.join(", "));
                  } else setAnswer(choice);
                }}
              >
                <span>{choice}</span>
                {Object.keys(request.input.choice_descriptions).includes(choice) &&
                  request.input.choice_descriptions[choice] && (
                    <span className="text-xs font-normal opacity-75 max-w-sm">
                      {request.input.choice_descriptions[choice]}
                    </span>
                  )}
              </Button>
            ))}
          </div>
          <label htmlFor={`answer-${request.id}`} className="block text-sm space-y-2">
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
              disabled={respond.isPending}
            />
          </label>
          <Button
            data-testid="attention-send"
            type="submit"
            disabled={!answer.trim() || respond.isPending}
          >
            {respond.isPending ? "Sending…" : "Send answer"}
          </Button>
        </form>
      )}
      {pending && request.input.kind === "approval" && (
        <div className="flex gap-3">
          <Button
            data-testid="attention-approve"
            disabled={respond.isPending}
            onClick={() => respond.mutate({ kind: "approval", approved: true })}
          >
            Approve
          </Button>
          <Button
            data-testid="attention-deny"
            variant="outline"
            disabled={respond.isPending}
            onClick={() => respond.mutate({ kind: "approval", approved: false })}
          >
            Deny
          </Button>
        </div>
      )}
      {request.response && (
        <p data-testid="attention-response" className="text-sm whitespace-pre-wrap">
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
      {(pending || request.status === "unavailable") && (
        <Button
          data-testid="attention-cancel"
          variant="ghost"
          disabled={respond.isPending || cancel.isPending}
          onClick={() => cancel.mutate()}
        >
          {pending ? "Cancel request" : "Dismiss"}
        </Button>
      )}
      {cancel.error && <p role="alert">{cancel.error.message}</p>}
      {respond.error && (
        <p role="alert" data-testid="attention-error" className="text-sm text-destructive">
          {respond.error.message}
        </p>
      )}
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
    <div data-testid="attention-view" className="max-w-4xl">
      <ViewHeader title="Attention needed" meta="Questions and approvals from your agents" />
      <p className="mb-4 text-sm text-outline">
        Live Codex questions can also appear as session notices. Direct responses require an ORC
        connection or a supported hook; ACPX CLI does not expose pending approvals to ORC.
      </p>
      {state.isLoading && <p role="status">Loading requests…</p>}
      {state.error && <p role="alert">{state.error.message}</p>}
      {observed.error && (
        <p role="alert">Could not check waiting sessions: {observed.error.message}</p>
      )}
      {chatWaits.error && (
        <p role="alert">Could not check waiting chats: {chatWaits.error.message}</p>
      )}
      {state.data?.length === 0 &&
        !observed.isLoading &&
        !observed.error &&
        !chatWaits.isLoading &&
        !chatWaits.error &&
        observed.data.length === 0 &&
        chatWaits.data.length === 0 && (
          <p data-testid="attention-empty" className="text-outline">
            Nothing needs your attention.
          </p>
        )}
      {state.data?.length === 100 && (
        <p className="text-sm text-outline mb-4">
          Showing the first 100 requests, with pending requests first. Resolving or dismissing
          entries reveals more.
        </p>
      )}
      <div className="space-y-4">
        {chatWaits.data.map((wait) => (
          <article
            key={`${wait.thread_id}:${wait.request_key}`}
            data-testid={`attention-chat-${wait.thread_id}`}
            className="rounded-lg border border-border bg-surface p-5 space-y-4"
          >
            <p className="text-xs text-outline">
              {wait.kind === "question" ? "Question" : "Approval"} · {wait.agent} ·{" "}
              {wait.host ?? "Local"} · Chat
            </p>
            <h2 className="text-base font-medium">{wait.title}</h2>
            <p className="text-sm text-outline">Waiting for your response in chat.</p>
            <Button
              variant="outline"
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

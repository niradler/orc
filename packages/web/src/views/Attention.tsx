import type { HumanRequest, HumanResponse } from "@orc/core/human-requests";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ViewHeader } from "@/components/ViewHeader";
import { useHumanRequests } from "@/hooks/useHumanRequests";

function RequestCard({ request }: { request: HumanRequest }) {
  const [answer, setAnswer] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const client = useQueryClient();
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
          {request.input.origin.backend}
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
      <p className="text-xs text-outline break-all">Session {request.input.origin.session_id}</p>
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
  return (
    <div data-testid="attention-view" className="max-w-4xl">
      <ViewHeader title="Attention needed" meta="Questions and approvals from your agents" />
      {state.isLoading && <p role="status">Loading requests…</p>}
      {state.error && <p role="alert">{state.error.message}</p>}
      {state.data?.length === 0 && (
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
        {state.data?.map((request) => (
          <RequestCard key={request.id} request={request} />
        ))}
      </div>
    </div>
  );
}

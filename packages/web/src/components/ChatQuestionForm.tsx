import { CHAT_QUESTION_DISMISS_ANSWER, type ChatQuestion } from "@orc/core/chat";
import { MessageCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { HelpPopover } from "@/components/HelpPopover";

const QUESTION_FORM_ID = "chat-question-form";

/**
 * The slim bar a collapsed question becomes. It stays in the flow above the
 * composer so the transcript stays readable, and it never cancels the request.
 */
export function ChatQuestionBar({
  request,
  onExpand,
}: {
  request: ChatQuestion;
  onExpand: () => void;
}) {
  const first = request.questions[0];
  const heading = first?.header || first?.question || "A question";
  const count = request.questions.length;
  const expand = useRef<HTMLButtonElement>(null);
  useEffect(() => expand.current?.focus(), []);
  return (
    <div
      data-testid="chat-question-collapsed"
      className="shrink-0 border-t border-outline-variant px-4 py-1"
    >
      <button
        ref={expand}
        type="button"
        data-testid="chat-question-expand"
        aria-expanded={false}
        aria-controls={QUESTION_FORM_ID}
        onClick={onExpand}
        className="flex min-h-11 w-full items-center gap-2 rounded-md text-left text-sm hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        <MessageCircle aria-hidden="true" size={15} className="shrink-0 text-on-surface-variant" />
        <span className="shrink-0 text-xs text-on-surface-variant">Agent is asking</span>
        <span className="min-w-0 flex-1 truncate" title={heading}>
          {heading}
        </span>
        {count > 1 && (
          <span className="shrink-0 text-xs text-on-surface-variant">{count} questions</span>
        )}
        <span className="shrink-0 text-xs font-medium text-primary">Expand</span>
      </button>
    </div>
  );
}

export function ChatQuestionForm({
  request,
  busy,
  expanded = true,
  onAnswer,
  onCollapse,
}: {
  request: ChatQuestion;
  busy: boolean;
  /** Collapsed keeps the form mounted so typed answers survive the toggle. */
  expanded?: boolean;
  onAnswer: (answers: Record<string, string[]>) => Promise<void>;
  onCollapse?: () => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const form = useRef<HTMLFormElement>(null);
  const wasCollapsed = useRef(!expanded);
  useEffect(() => {
    if (expanded && wasCollapsed.current) form.current?.focus();
    wasCollapsed.current = !expanded;
  }, [expanded]);
  return (
    <form
      ref={form}
      id={QUESTION_FORM_ID}
      tabIndex={-1}
      data-testid="chat-question"
      className="shrink-0 max-h-[min(45vh,28rem)] overflow-auto border-t border-outline-variant px-4 py-3 text-sm space-y-3 focus-visible:outline-none"
      onSubmit={(event) => {
        event.preventDefault();
        void onAnswer(answers);
      }}
    >
      {request.questions.map((question) => {
        const selected = answers[question.id] ?? [];
        const optionLabels = new Set(question.options?.map((option) => option.label) ?? []);
        const custom = selected.find((answer) => !optionLabels.has(answer)) ?? "";
        return (
          <fieldset key={question.id} className="space-y-2" disabled={busy}>
            <legend className="font-medium">{question.question}</legend>
            {question.options?.map((option) => (
              <label key={option.label} className="flex min-h-11 items-start gap-2 py-2">
                <input
                  type={question.multiSelect ? "checkbox" : "radio"}
                  name={question.id}
                  value={option.label}
                  className="mt-1"
                  checked={selected.includes(option.label)}
                  onChange={() =>
                    setAnswers((current) => {
                      const values = current[question.id] ?? [];
                      if (!question.multiSelect)
                        return { ...current, [question.id]: [option.label] };
                      return {
                        ...current,
                        [question.id]: values.includes(option.label)
                          ? values.filter((value) => value !== option.label)
                          : [...values, option.label],
                      };
                    })
                  }
                />
                <span>
                  {option.label}
                  <span className="block text-xs text-muted-foreground">{option.description}</span>
                </span>
              </label>
            ))}
            <input
              data-testid="chat-question-answer"
              aria-label={`${question.header || "Your answer"}: ${question.question}`}
              type={question.isSecret ? "password" : "text"}
              autoComplete="off"
              placeholder={question.options?.length ? "Or enter your answer" : "Your answer"}
              value={
                question.multiSelect
                  ? custom
                  : optionLabels.has(selected[0] ?? "")
                    ? ""
                    : (selected[0] ?? "")
              }
              onChange={(event) =>
                setAnswers((current) => {
                  const values = current[question.id] ?? [];
                  if (!question.multiSelect)
                    return { ...current, [question.id]: [event.target.value] };
                  const choices = values.filter((value) => optionLabels.has(value));
                  return {
                    ...current,
                    [question.id]: event.target.value.trim()
                      ? [...choices, event.target.value]
                      : choices,
                  };
                })
              }
              className="min-h-11 w-full rounded-md border border-control-border bg-background px-3 text-base sm:text-sm"
            />
          </fieldset>
        );
      })}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          data-testid="chat-question-submit"
          disabled={
            busy ||
            request.questions.some(
              (question) => !answers[question.id]?.some((answer) => answer.trim()),
            )
          }
          className="min-h-8 rounded-md bg-primary px-3 text-primary-foreground disabled:opacity-50 max-md:min-h-11 pointer-coarse:min-h-11"
        >
          {busy ? "Sending…" : "Send answer"}
        </button>
        <button
          type="button"
          data-testid="chat-question-dismiss"
          disabled={busy}
          onClick={() =>
            void onAnswer(
              Object.fromEntries(
                request.questions.map((question) => [question.id, [CHAT_QUESTION_DISMISS_ANSWER]]),
              ),
            )
          }
          className="min-h-8 rounded-md border border-control-border px-3 max-md:min-h-11 pointer-coarse:min-h-11"
        >
          Dismiss
        </button>
        {onCollapse && (
          <button
            type="button"
            data-testid="chat-question-collapse"
            aria-expanded={true}
            aria-controls={QUESTION_FORM_ID}
            onClick={onCollapse}
            className="min-h-8 rounded-md px-3 text-on-surface-variant hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus max-md:min-h-11 pointer-coarse:min-h-11"
          >
            Collapse
          </button>
        )}
        <HelpPopover label="Answering questions" testId="chat-question-help">
          Pick a suggestion, or type your own answer in the field under the options. Dismiss sends a
          &ldquo;no answer&rdquo; note and lets the agent continue with its best judgment; the
          conversation stays open.
        </HelpPopover>
      </div>
    </form>
  );
}

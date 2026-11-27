import { CHAT_QUESTION_DISMISS_ANSWER, type ChatQuestion } from "@orc/core/chat";
import { Check, MessageCircle } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { HelpPopover } from "@/components/HelpPopover";

/**
 * The slim bar a collapsed question becomes. It stays in the flow above the
 * composer so the transcript stays readable, and it never cancels the request.
 */
export function ChatQuestionBar({
  request,
  formId,
  onExpand,
}: {
  request: ChatQuestion;
  formId: string;
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
        aria-controls={formId}
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

type Question = ChatQuestion["questions"][number];

function QuestionField({
  question,
  answers,
  disabled,
  onChange,
}: {
  question: Question;
  answers: string[];
  disabled: boolean;
  onChange: (next: string[]) => void;
}) {
  const optionLabels = new Set(question.options?.map((option) => option.label) ?? []);
  const selectedOptions = answers.filter((answer) => optionLabels.has(answer));
  const custom = answers.find((answer) => !optionLabels.has(answer)) ?? "";
  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend className="font-medium">{question.question}</legend>
      {question.options?.map((option) => (
        <label key={option.label} className="flex min-h-11 items-start gap-2 py-2">
          <input
            type={question.multiSelect ? "checkbox" : "radio"}
            name={question.id}
            value={option.label}
            className="mt-1"
            checked={answers.includes(option.label)}
            onChange={() => {
              if (!question.multiSelect) return onChange([option.label]);
              onChange(
                answers.includes(option.label)
                  ? answers.filter((value) => value !== option.label)
                  : [...answers, option.label],
              );
            }}
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
            : optionLabels.has(answers[0] ?? "")
              ? ""
              : (answers[0] ?? "")
        }
        onChange={(event) => {
          if (!question.multiSelect) return onChange([event.target.value]);
          onChange(
            event.target.value.trim() ? [...selectedOptions, event.target.value] : selectedOptions,
          );
        }}
        className="min-h-11 w-full rounded-md border border-control-border bg-background px-3 text-base sm:text-sm"
      />
    </fieldset>
  );
}

export function ChatQuestionForm({
  request,
  formId,
  busy,
  expanded = true,
  onAnswer,
  onCollapse,
}: {
  request: ChatQuestion;
  formId: string;
  busy: boolean;
  /** Collapsed keeps the form mounted so typed answers survive the toggle. */
  expanded?: boolean;
  onAnswer: (answers: Record<string, string[]>) => Promise<void>;
  onCollapse?: () => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [step, setStep] = useState(0);
  const tabBase = useId();
  const tabId = (index: number) => `${tabBase}-tab-${index}`;
  const panelId = (index: number) => `${tabBase}-panel-${index}`;
  const form = useRef<HTMLFormElement>(null);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const panel = useRef<HTMLDivElement>(null);
  const focusPanel = useRef(false);
  const wasCollapsed = useRef(!expanded);
  useEffect(() => {
    if (expanded && wasCollapsed.current) form.current?.focus();
    wasCollapsed.current = !expanded;
  }, [expanded]);
  const total = request.questions.length;
  const active = Math.min(step, Math.max(0, total - 1));
  const current = request.questions[active];
  const answered = (question: (typeof request.questions)[number]) =>
    Boolean(answers[question.id]?.some((answer) => answer.trim()));
  const allAnswered = request.questions.every(answered);
  // Back/Next move focus into the step they reveal; tab presses keep their own focus.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the effect reads refs only, but `active` is what moves focus.
  useEffect(() => {
    if (!focusPanel.current) return;
    focusPanel.current = false;
    panel.current?.focus();
  }, [active]);
  const go = (next: number) => {
    focusPanel.current = true;
    setStep(Math.max(0, Math.min(total - 1, next)));
  };
  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const next =
      event.key === "ArrowRight"
        ? (index + 1) % total
        : event.key === "ArrowLeft"
          ? (index - 1 + total) % total
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? total - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    setStep(next);
    tabs.current[next]?.focus();
  };
  return (
    <form
      ref={form}
      id={formId}
      tabIndex={-1}
      data-testid="chat-question"
      className="shrink-0 max-h-[min(45vh,28rem)] overflow-auto border-t border-outline-variant px-4 py-3 text-sm space-y-3 focus-visible:outline-none"
      onSubmit={(event) => {
        event.preventDefault();
        void onAnswer(answers);
      }}
    >
      {total > 1 && (
        <div
          role="tablist"
          aria-label="Questions"
          className="flex flex-wrap gap-1 border-b border-outline-variant pb-2"
        >
          {request.questions.map((question, index) => (
            <button
              key={question.id}
              type="button"
              role="tab"
              id={tabId(index)}
              ref={(node) => {
                tabs.current[index] = node;
              }}
              data-testid={`chat-question-tab-${index}`}
              aria-selected={index === active}
              aria-controls={panelId(index)}
              tabIndex={index === active ? 0 : -1}
              onClick={() => setStep(index)}
              onKeyDown={(event) => onTabKeyDown(event, index)}
              className={`flex min-h-8 max-w-48 items-center gap-1.5 rounded-md px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
                index === active
                  ? "bg-surface font-medium text-foreground"
                  : "text-on-surface-variant hover:bg-surface"
              }`}
            >
              <span className="shrink-0 tabular-nums opacity-70">{index + 1}</span>
              <span className="truncate">{question.header || `Question ${index + 1}`}</span>
              {answered(question) && (
                <Check aria-label="Answered" size={12} className="shrink-0 text-primary" />
              )}
            </button>
          ))}
        </div>
      )}
      {request.questions.map((question, index) => {
        const activePanel = index === active;
        return (
          <div
            key={question.id}
            ref={activePanel ? panel : undefined}
            hidden={total > 1 && !activePanel}
            {...(total > 1
              ? {
                  role: "tabpanel" as const,
                  id: panelId(index),
                  "aria-labelledby": tabId(index),
                  tabIndex: -1,
                  "data-testid": `chat-question-panel-${index}`,
                }
              : {})}
            className="focus-visible:outline-none"
          >
            <QuestionField
              question={question}
              answers={answers[question.id] ?? []}
              disabled={busy}
              onChange={(next) => setAnswers((all) => ({ ...all, [question.id]: next }))}
            />
          </div>
        );
      })}
      <div className="flex flex-wrap items-center gap-2">
        {total > 1 && (
          <span className="text-xs text-on-surface-variant" data-testid="chat-question-step">
            Question {active + 1} of {total}
          </span>
        )}
        {total > 1 && active > 0 && (
          <button
            type="button"
            data-testid="chat-question-back"
            disabled={busy}
            onClick={() => go(active - 1)}
            className="min-h-8 rounded-md border border-control-border px-3 max-md:min-h-11 pointer-coarse:min-h-11"
          >
            Back
          </button>
        )}
        {total > 1 && current && active < total - 1 && (
          <button
            type="button"
            data-testid="chat-question-next"
            disabled={busy || !answered(current)}
            onClick={() => go(active + 1)}
            className="min-h-8 rounded-md border border-control-border px-3 disabled:opacity-50 max-md:min-h-11 pointer-coarse:min-h-11"
          >
            Next
          </button>
        )}
        <button
          type="submit"
          data-testid="chat-question-submit"
          disabled={busy || !allAnswered}
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
            aria-controls={formId}
            onClick={onCollapse}
            className="min-h-8 rounded-md px-3 text-on-surface-variant hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus max-md:min-h-11 pointer-coarse:min-h-11"
          >
            Collapse
          </button>
        )}
        <HelpPopover label="Answering questions" testId="chat-question-help">
          Pick a suggestion, or type your own answer in the field under the options. With several
          questions, use the tabs or Next to move between them; the answer sends once every question
          has a value. Dismiss sends a &ldquo;no answer&rdquo; note and lets the agent continue with
          its best judgment; the conversation stays open.
        </HelpPopover>
      </div>
    </form>
  );
}

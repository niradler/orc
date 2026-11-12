import type { ChatQuestion } from "@orc/core/chat";
import { useState } from "react";

export function ChatQuestionForm({
  request,
  busy,
  onAnswer,
}: {
  request: ChatQuestion;
  busy: boolean;
  onAnswer: (answers: Record<string, string[]>) => Promise<void>;
}) {
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  return (
    <form
      data-testid="chat-question"
      className="shrink-0 max-h-[45vh] overflow-auto border-t border-outline-variant px-4 py-3 text-sm space-y-3"
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
    </form>
  );
}

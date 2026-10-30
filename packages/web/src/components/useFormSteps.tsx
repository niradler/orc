import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type Step = { id: string; label: string };

export function useFormSteps(items: Step[], open = true) {
  const [step, setStep] = useState(items[0].id);
  const [error, setError] = useState("");
  const form = useRef<HTMLFormElement>(null);
  const index = items.findIndex((item) => item.id === step);
  const first = items[0].id;
  useEffect(() => {
    if (open) {
      setStep(first);
      setError("");
    }
  }, [open, first]);
  useEffect(() => {
    const body = form.current
      ?.querySelector(`[data-form-step="${step}"]`)
      ?.closest(".work-form-body");
    if (body) body.scrollTop = 0;
  }, [step]);
  function validate(all = true) {
    const fields = form.current?.querySelectorAll<
      HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
    >("input, select, textarea");
    for (const field of fields ?? []) {
      if (!all && field.closest("[data-form-step]")?.getAttribute("data-form-step") !== step)
        continue;
      if (!field.willValidate) continue;
      field.setCustomValidity(field.required && !field.value.trim() ? "Enter a value." : "");
      if (field.validity.valid) continue;
      const invalidStep = field.closest("[data-form-step]")?.getAttribute("data-form-step");
      if (invalidStep) flushSync(() => setStep(invalidStep));
      field.reportValidity();
      field.focus();
      return false;
    }
    return true;
  }
  function change(next: string) {
    setStep(next);
    setError("");
  }
  function next() {
    if (!validate(false)) return;
    flushSync(() => change(items[index + 1].id));
    form.current?.querySelector<HTMLButtonElement>('[role="tab"][data-state="active"]')?.focus();
  }
  function submit(event: FormEvent, save: () => void) {
    event.preventDefault();
    if (index < items.length - 1) return next();
    if (validate()) save();
  }
  function invalid(id: string, message: string) {
    flushSync(() => {
      setStep(id);
      setError(message);
    });
    form.current?.querySelector<HTMLButtonElement>('[role="tab"][data-state="active"]')?.focus();
  }
  function reset() {
    setStep(items[0].id);
    setError("");
  }
  return {
    items,
    step,
    index,
    form,
    error,
    change,
    next,
    submit,
    validate,
    invalid,
    reset,
    last: index === items.length - 1,
  };
}

type Controller = ReturnType<typeof useFormSteps>;

export function FormSteps({ steps, children }: { steps: Controller; children: ReactNode }) {
  return (
    <Tabs
      value={steps.step}
      onValueChange={steps.change}
      className="contents"
      onInputCapture={(event) => {
        const field = event.target;
        if (
          field instanceof HTMLInputElement ||
          field instanceof HTMLTextAreaElement ||
          field instanceof HTMLSelectElement
        )
          field.setCustomValidity("");
      }}
    >
      <TabsList
        aria-label="Form steps"
        className="mx-4 mt-2 flex shrink-0 justify-start gap-1 p-0 sm:mx-6"
      >
        {steps.items.map((item) => (
          <TabsTrigger
            key={item.id}
            value={item.id}
            data-testid={`form-step-${item.id}`}
            className="min-w-0 flex-1 px-2 text-[13px] sm:flex-none sm:px-3"
          >
            {item.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {children}
    </Tabs>
  );
}

export function FormStepPanel({
  steps,
  id,
  children,
  className = "grid grid-cols-1 gap-4 md:grid-cols-2",
}: {
  steps: Controller;
  id: string;
  children: ReactNode;
  className?: string;
}) {
  // Keep fields mounted for native validation and child drafts; only the active panel occupies space.
  return (
    <TabsContent
      value={id}
      forceMount
      hidden={steps.step !== id}
      data-form-step={id}
      className={`mt-0 data-[state=inactive]:hidden ${className}`}
    >
      {children}
    </TabsContent>
  );
}

export function FormStepActions({
  steps,
  busy,
  children,
}: {
  steps: Controller;
  busy: boolean;
  children: ReactNode;
}) {
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        data-testid="form-step-back"
        disabled={steps.index === 0 || busy}
        onClick={() => steps.change(steps.items[steps.index - 1].id)}
      >
        Back
      </Button>
      {steps.last ? (
        children
      ) : (
        <Button
          key="next-step"
          type="button"
          size="sm"
          data-testid="form-step-next"
          disabled={busy}
          onClick={(event) => {
            // Advancing can replace this control with Submit during the same click.
            event.preventDefault();
            steps.next();
          }}
        >
          Next
        </Button>
      )}
    </>
  );
}

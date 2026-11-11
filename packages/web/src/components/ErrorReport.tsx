import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { errorDisplayText, formatErrorReport } from "@/lib/app-errors";

interface Props {
  error: unknown;
  /** What happened, in the app's voice. */
  title: string;
  hint?: ReactNode;
  onReload: () => void;
  testId: string;
}

/**
 * Full-screen failure state that keeps the real error visible: a generic page
 * cannot be debugged from a screenshot, and the message plus stack is what a bug
 * report needs.
 */
export function ErrorReport({ error, title, hint, onReload, testId }: Props) {
  const copy = () => {
    navigator.clipboard?.writeText(formatErrorReport(error)).catch(() => {});
  };

  return (
    <main
      data-testid={testId}
      className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-6 text-center"
    >
      <p className="text-error font-label text-sm uppercase tracking-widest">{title}</p>
      {hint && <p className="max-w-md text-sm text-muted-foreground">{hint}</p>}
      <pre
        data-testid={`${testId}-message`}
        className="max-h-80 w-full max-w-2xl overflow-auto rounded bg-muted p-4 text-left text-xs whitespace-pre-wrap break-words text-muted-foreground"
      >
        {errorDisplayText(error)}
      </pre>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button data-testid={`${testId}-reload`} variant="outline" onClick={onReload}>
          Reload
        </Button>
        <Button data-testid={`${testId}-copy`} variant="ghost" onClick={copy}>
          Copy details
        </Button>
      </div>
    </main>
  );
}

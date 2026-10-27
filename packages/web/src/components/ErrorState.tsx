import { Button } from "@/components/ui/button";

interface ErrorStateProps {
  message: string;
  onRetry?: () => void;
}

export function ErrorState({ message, onRetry }: ErrorStateProps) {
  return (
    <div
      data-testid="error-state"
      className="flex flex-col items-center justify-center gap-3 px-4 py-16"
    >
      <p role="alert" className="max-w-prose wrap-break-word text-center text-sm text-error">
        {message}
      </p>
      {onRetry && (
        <Button data-testid="error-retry" variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

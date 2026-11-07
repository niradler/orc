import { useEffect, useRef } from "react";
import { TerminalTouchControls } from "@/components/terminals/TerminalTouchControls";
import { useTerminals } from "@/lib/terminals";

export function TerminalViewport({ terminalId }: { terminalId: string }) {
  const { attach, detach, engineError } = useTerminals();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = ref.current;
    if (!container) return;
    void attach(terminalId, container);
    return () => detach(terminalId);
  }, [terminalId, attach, detach]);

  return (
    <div className="flex flex-1 min-h-0 min-w-0 flex-col">
      <div
        ref={ref}
        data-testid="terminal-viewport"
        className="relative flex-1 min-h-0 min-w-0 bg-black"
      >
        {engineError && (
          <p
            role="alert"
            className="absolute inset-0 flex items-center justify-center p-4 bg-surface text-error font-label text-xs text-center"
          >
            Terminal renderer failed to load: {engineError}
          </p>
        )}
      </div>
      <TerminalTouchControls terminalId={terminalId} />
    </div>
  );
}

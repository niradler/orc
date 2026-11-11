import { useEffect, useRef, useState } from "react";
import { TerminalTouchControls } from "@/components/terminals/TerminalTouchControls";
import { useTerminalWorkspaceGroup } from "@/components/terminals/TerminalWorkspaceGroup";
import { useTerminals } from "@/lib/terminals";

export function TerminalViewport({ terminalId }: { terminalId: string }) {
  const { attach, detach, engineError, focus } = useTerminals();
  const group = useTerminalWorkspaceGroup();
  const [elsewhere, setElsewhere] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = ref.current;
    if (!container) return;
    let cancelled = false;
    setElsewhere(false);
    void attach(terminalId, container).then((attached) => {
      if (!cancelled) setElsewhere(!attached);
    });
    return () => {
      cancelled = true;
      detach(terminalId, container);
    };
  }, [terminalId, attach, detach]);

  return (
    <div className="flex flex-1 min-h-0 min-w-0 flex-col">
      <div
        ref={ref}
        data-testid="terminal-viewport"
        data-terminal-id={terminalId}
        className="relative flex-1 min-h-0 min-w-0 bg-black"
      >
        {elsewhere && !engineError && (
          <div
            role="status"
            data-testid="terminal-already-open"
            className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-4 text-sm text-muted-foreground"
          >
            <p>This terminal is already open in another pane.</p>
            <button
              type="button"
              className="min-h-11 rounded-md px-3 text-primary hover:bg-surface"
              onClick={() => {
                if (group?.focus(terminalId)) return;
                const container = ref.current;
                if (container)
                  void attach(terminalId, container).then((attached) => {
                    setElsewhere(!attached);
                    if (attached) focus(terminalId);
                  });
              }}
            >
              Show existing terminal
            </button>
          </div>
        )}
        {engineError && (
          <p
            role="alert"
            className="absolute inset-0 flex items-center justify-center p-4 bg-surface text-error font-label text-xs text-center"
          >
            Terminal renderer failed to load: {engineError}
          </p>
        )}
      </div>
      {!elsewhere && <TerminalTouchControls terminalId={terminalId} />}
    </div>
  );
}

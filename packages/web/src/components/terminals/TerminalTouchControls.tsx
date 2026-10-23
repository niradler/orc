import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Keyboard } from "lucide-react";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useTerminals } from "@/lib/terminals";

const keys = [
  { name: "Escape", label: "Esc", data: "\u001b" },
  { name: "Tab", label: "Tab", data: "\t" },
  { name: "Interrupt command", label: "Ctrl C", data: "\u0003" },
  { name: "Arrow up", label: <ArrowUp size={16} />, data: "\u001b[A" },
  { name: "Arrow down", label: <ArrowDown size={16} />, data: "\u001b[B" },
  { name: "Arrow left", label: <ArrowLeft size={16} />, data: "\u001b[D" },
  { name: "Arrow right", label: <ArrowRight size={16} />, data: "\u001b[C" },
];

export function TerminalTouchControls({ terminalId }: { terminalId: string }) {
  const touch = useMediaQuery("(any-pointer: coarse)");
  const { sendInput, focus, connectionOf, terminals } = useTerminals();
  if (!touch) return null;
  const enabled =
    connectionOf(terminalId) === "connected" &&
    terminals.some((terminal) => terminal.id === terminalId && terminal.status === "running");
  return (
    <fieldset
      data-testid="terminal-touch-controls"
      aria-label="Terminal keyboard shortcuts"
      className="flex min-w-0 w-full shrink-0 gap-1 overflow-x-auto overscroll-x-contain border-t border-outline-variant bg-background px-2 py-1"
    >
      <button
        type="button"
        aria-label="Show terminal keyboard"
        disabled={!enabled}
        onClick={() => focus(terminalId)}
        className="inline-flex size-11 shrink-0 items-center justify-center rounded-md text-on-surface-variant hover:bg-surface disabled:opacity-40"
      >
        <Keyboard size={18} />
      </button>
      {keys.map((key) => (
        <button
          key={key.name}
          type="button"
          aria-label={key.name}
          disabled={!enabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => sendInput(terminalId, key.data)}
          className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md px-2 text-xs text-on-surface-variant hover:bg-surface disabled:opacity-40"
        >
          {key.label}
        </button>
      ))}
    </fieldset>
  );
}

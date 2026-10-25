import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Keyboard } from "lucide-react";
import { type ComponentProps, useEffect, useRef, useState } from "react";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import {
  DEFAULT_TERMINAL_FONT_SIZE,
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
} from "@/lib/terminal-font-size";
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

const pages = [
  { name: "Page up", label: "PgUp", direction: -1 },
  { name: "Page down", label: "PgDn", direction: 1 },
] as const;

function TouchControlButton({
  onPress,
  disabled,
  ...props
}: Omit<ComponentProps<"button">, "onClick"> & { onPress: () => void }) {
  const gesture = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const touchActivated = useRef(false);
  return (
    <button
      {...props}
      disabled={disabled}
      onPointerDown={(event) => {
        if (event.pointerType === "mouse") touchActivated.current = false;
      }}
      onMouseDown={(event) => event.preventDefault()}
      onTouchStart={(event) => {
        const touch = event.touches.length === 1 ? event.touches[0] : undefined;
        gesture.current = touch ? { x: touch.clientX, y: touch.clientY, moved: false } : null;
        touchActivated.current = false;
      }}
      onTouchMove={(event) => {
        const start = gesture.current;
        const touch = event.touches[0];
        if (start && touch && Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > 6)
          start.moved = true;
      }}
      onTouchCancel={() => {
        gesture.current = null;
      }}
      onTouchEnd={(event) => {
        const start = gesture.current;
        gesture.current = null;
        if (disabled || !start || start.moved) return;
        event.preventDefault();
        touchActivated.current = true;
        onPress();
      }}
      onClick={(event) => {
        if (touchActivated.current && event.detail > 0) {
          touchActivated.current = false;
          return;
        }
        touchActivated.current = false;
        if (!disabled) onPress();
      }}
    />
  );
}

export function TerminalTouchControls({ terminalId }: { terminalId: string }) {
  const touch = useMediaQuery("(any-pointer: coarse)");
  const { sendInput, armCtrl, focus, page, connectionOf, terminals, fontSizeOf, setFontSize } =
    useTerminals();
  const [ctrl, setCtrl] = useState(false);
  useEffect(() => {
    setCtrl(false);
    return () => armCtrl(terminalId, null);
  }, [terminalId, armCtrl]);
  if (!touch) return null;
  const toggleCtrl = () => {
    armCtrl(terminalId, ctrl ? null : () => setCtrl(false));
    setCtrl(!ctrl);
  };
  const enabled =
    connectionOf(terminalId) === "connected" &&
    terminals.some((terminal) => terminal.id === terminalId && terminal.status === "running");
  return (
    <fieldset
      data-testid="terminal-touch-controls"
      aria-label="Terminal keyboard shortcuts"
      className="flex min-w-0 w-full shrink-0 gap-1 border-t border-outline-variant bg-background px-2 py-1"
    >
      <TouchControlButton
        type="button"
        data-testid="terminal-keyboard-show"
        aria-label="Show terminal keyboard"
        disabled={!enabled}
        onPress={() => focus(terminalId)}
        className="inline-flex size-11 shrink-0 items-center justify-center rounded-md text-on-surface-variant hover:bg-surface disabled:opacity-40"
      >
        <Keyboard size={18} />
      </TouchControlButton>
      <fieldset
        data-testid="terminal-special-keys"
        className="flex min-w-0 flex-1 gap-1 overflow-x-auto overscroll-x-contain"
        aria-label="Swipe for more terminal keys"
      >
        {keys.slice(0, 2).map((key) => (
          <TouchControlButton
            key={key.name}
            type="button"
            aria-label={key.name}
            disabled={!enabled}
            onPress={() => sendInput(terminalId, key.data)}
            className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md px-2 text-xs text-on-surface-variant hover:bg-surface disabled:opacity-40"
          >
            {key.label}
          </TouchControlButton>
        ))}
        <TouchControlButton
          type="button"
          data-testid="terminal-ctrl"
          aria-label="Control modifier for the next key"
          aria-pressed={ctrl}
          disabled={!enabled}
          onPress={toggleCtrl}
          className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md px-2 text-xs text-on-surface-variant hover:bg-surface aria-pressed:bg-primary aria-pressed:text-primary-foreground disabled:opacity-40"
        >
          Ctrl
        </TouchControlButton>
        {keys.slice(2).map((key) => (
          <TouchControlButton
            key={key.name}
            type="button"
            aria-label={key.name}
            disabled={!enabled}
            onPress={() => sendInput(terminalId, key.data)}
            className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md px-2 text-xs text-on-surface-variant hover:bg-surface disabled:opacity-40"
          >
            {key.label}
          </TouchControlButton>
        ))}
        {pages.map((key) => (
          <TouchControlButton
            key={key.name}
            type="button"
            aria-label={key.name}
            disabled={!enabled}
            onPress={() => page(terminalId, key.direction)}
            className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md px-2 text-xs text-on-surface-variant hover:bg-surface disabled:opacity-40"
          >
            {key.label}
          </TouchControlButton>
        ))}
      </fieldset>
      <fieldset
        className="flex shrink-0 border-l border-outline-variant"
        aria-label="Terminal text size"
      >
        <TouchControlButton
          type="button"
          data-testid="terminal-font-smaller"
          aria-label="Smaller terminal text"
          disabled={fontSizeOf(terminalId) <= MIN_TERMINAL_FONT_SIZE}
          onPress={() => setFontSize(terminalId, fontSizeOf(terminalId) - 1)}
          className="min-h-11 min-w-11 rounded-md text-sm hover:bg-surface disabled:opacity-40"
        >
          A−
        </TouchControlButton>
        <TouchControlButton
          type="button"
          data-testid="terminal-font-reset"
          aria-label="Reset terminal text size"
          title="Pinch terminal to zoom; tap to reset"
          onPress={() => setFontSize(terminalId, DEFAULT_TERMINAL_FONT_SIZE)}
          className="min-h-11 min-w-11 rounded-md text-xs hover:bg-surface"
        >
          {fontSizeOf(terminalId)}px
        </TouchControlButton>
        <TouchControlButton
          type="button"
          data-testid="terminal-font-larger"
          aria-label="Larger terminal text"
          disabled={fontSizeOf(terminalId) >= MAX_TERMINAL_FONT_SIZE}
          onPress={() => setFontSize(terminalId, fontSizeOf(terminalId) + 1)}
          className="min-h-11 min-w-11 rounded-md text-sm hover:bg-surface disabled:opacity-40"
        >
          A+
        </TouchControlButton>
      </fieldset>
    </fieldset>
  );
}

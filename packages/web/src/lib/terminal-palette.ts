export type TerminalPaletteRequest = {
  currentId: string | null;
  select: (id: string) => void;
};

export const TERMINAL_PALETTE_EVENT = "orc:terminal-palette";

export function openTerminalPalette(request: TerminalPaletteRequest): void {
  window.dispatchEvent(
    new CustomEvent<TerminalPaletteRequest>(TERMINAL_PALETTE_EVENT, { detail: request }),
  );
}

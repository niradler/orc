export const TERMINAL_FONT_SIZE_KEY = "orc_terminal_font_size";
export const DEFAULT_TERMINAL_FONT_SIZE = 13;
export const MIN_TERMINAL_FONT_SIZE = 10;
export const MAX_TERMINAL_FONT_SIZE = 32;

export function clampTerminalFontSize(size: number): number {
  return Number.isFinite(size)
    ? Math.min(MAX_TERMINAL_FONT_SIZE, Math.max(MIN_TERMINAL_FONT_SIZE, Math.round(size)))
    : DEFAULT_TERMINAL_FONT_SIZE;
}

export function terminalFontSize(): number {
  try {
    const saved = localStorage.getItem(TERMINAL_FONT_SIZE_KEY);
    return saved ? clampTerminalFontSize(Number(saved)) : DEFAULT_TERMINAL_FONT_SIZE;
  } catch {
    return DEFAULT_TERMINAL_FONT_SIZE;
  }
}

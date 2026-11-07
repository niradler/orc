import type { KeyboardEvent } from "react";

export const composerChip =
  "composer-chip inline-flex h-8 min-w-0 max-w-full items-center gap-1.5 rounded-md border border-border px-2 text-xs text-on-surface-variant hover:bg-surface-highest hover:text-on-surface focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-40 data-[state=open]:bg-surface-highest data-[state=open]:text-on-surface max-sm:h-11 pointer-coarse:h-11";

export const chipOption =
  "flex min-h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-surface-highest focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-40 aria-checked:bg-surface-highest max-sm:min-h-11 pointer-coarse:min-h-11";

export const chipHeading = "px-2 pt-1 pb-0.5 text-xs text-muted-foreground";

function options(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>("[data-chip-option]:not(:disabled)"),
  ).filter((element) => element.offsetParent !== null);
}

export function focusChipOption(container: HTMLElement | null, preferChecked = true): void {
  if (!container) return;
  const all = options(container);
  const checked = preferChecked
    ? all.find((element) => element.getAttribute("aria-checked") === "true")
    : undefined;
  (checked ?? all[0])?.focus();
}

export function onChipListKeyDown(event: KeyboardEvent<HTMLElement>): void {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  if (event.target instanceof HTMLInputElement) return;
  const list = options(event.currentTarget);
  if (!list.length) return;
  event.preventDefault();
  const index = list.indexOf(document.activeElement as HTMLElement);
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? list.length - 1
        : event.key === "ArrowDown"
          ? (index + 1) % list.length
          : (index - 1 + list.length) % list.length;
  list[next]?.focus();
}

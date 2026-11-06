import { type KeyboardEvent, type PointerEvent, useCallback, useState } from "react";

interface PanelWidthOptions {
  storageKey: string;
  initial: number;
  min: number;
  max: number;
  edge?: "left" | "right" | "top";
}

const KEY_STEP = 16;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function readStored(key: string, fallback: number): number {
  try {
    const stored = Number(localStorage.getItem(key));
    return Number.isFinite(stored) && stored > 0 ? stored : fallback;
  } catch {
    return fallback;
  }
}

function writeStored(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {}
}

export function usePanelWidth({
  storageKey,
  initial,
  min,
  max,
  edge = "right",
}: PanelWidthOptions) {
  const direction = edge === "right" ? 1 : -1;
  const vertical = edge === "top";
  const [back, forward] = vertical ? ["ArrowUp", "ArrowDown"] : ["ArrowLeft", "ArrowRight"];
  const [width, setWidth] = useState(() => clamp(readStored(storageKey, initial), min, max));
  const currentWidth = clamp(width, min, max);

  const commit = useCallback(
    (next: number) => {
      const value = clamp(Math.round(next), min, max);
      setWidth(value);
      writeStored(storageKey, value);
    },
    [storageKey, min, max],
  );

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      event.preventDefault();
      const handle = event.currentTarget;
      const point = (e: { clientX: number; clientY: number }) => (vertical ? e.clientY : e.clientX);
      const startX = point(event);
      const startWidth = currentWidth;
      handle.setPointerCapture(event.pointerId);
      const onMove = (e: globalThis.PointerEvent) =>
        setWidth(clamp(startWidth + direction * (point(e) - startX), min, max));
      const onUp = (e: globalThis.PointerEvent) => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        handle.removeEventListener("pointercancel", onUp);
        commit(startWidth + direction * (point(e) - startX));
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
      handle.addEventListener("pointercancel", onUp);
    },
    [currentWidth, min, max, commit, direction, vertical],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.key === back) commit(currentWidth - direction * KEY_STEP);
      else if (event.key === forward) commit(currentWidth + direction * KEY_STEP);
      else return;
      event.preventDefault();
    },
    [currentWidth, commit, direction, back, forward],
  );

  const reset = useCallback(() => commit(initial), [commit, initial]);

  return {
    width: currentWidth,
    handleProps: { onPointerDown, onKeyDown, onDoubleClick: reset },
  };
}

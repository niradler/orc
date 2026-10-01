import { type KeyboardEvent, type PointerEvent, useCallback, useState } from "react";

interface PanelWidthOptions {
  storageKey: string;
  initial: number;
  min: number;
  max: number;
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

export function usePanelWidth({ storageKey, initial, min, max }: PanelWidthOptions) {
  const [width, setWidth] = useState(() => clamp(readStored(storageKey, initial), min, max));

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
      const startX = event.clientX;
      const startWidth = width;
      handle.setPointerCapture(event.pointerId);
      const onMove = (e: globalThis.PointerEvent) =>
        setWidth(clamp(startWidth + e.clientX - startX, min, max));
      const onUp = (e: globalThis.PointerEvent) => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        handle.removeEventListener("pointercancel", onUp);
        commit(startWidth + e.clientX - startX);
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
      handle.addEventListener("pointercancel", onUp);
    },
    [width, min, max, commit],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.key === "ArrowLeft") commit(width - KEY_STEP);
      else if (event.key === "ArrowRight") commit(width + KEY_STEP);
      else return;
      event.preventDefault();
    },
    [width, commit],
  );

  const reset = useCallback(() => commit(initial), [commit, initial]);

  return { width, handleProps: { onPointerDown, onKeyDown, onDoubleClick: reset } };
}

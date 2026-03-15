import { useKeyboard } from "@opentui/react";
import { useCallback, useRef, useState } from "react";

type VimListResult = {
  cursor: number;
  setCursor: (n: number) => void;
};

export function useVimList(length: number, enabled = true): VimListResult {
  const [cursor, setCursorRaw] = useState(0);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const lengthRef = useRef(length);
  lengthRef.current = length;

  const clamp = useCallback((n: number) => {
    const len = lengthRef.current;
    return Math.max(0, Math.min(len - 1, n));
  }, []);

  useKeyboard((key) => {
    if (!enabledRef.current || lengthRef.current === 0) return;
    if (key.name === "j" || key.name === "down") setCursorRaw((c) => clamp(c + 1));
    if (key.name === "k" || key.name === "up") setCursorRaw((c) => clamp(c - 1));
    if (key.name === "g" && !key.shift) setCursorRaw(0);
    if (key.shift && key.name === "g") setCursorRaw(clamp(lengthRef.current - 1));
    if (key.name === "home") setCursorRaw(0);
    if (key.name === "end") setCursorRaw(clamp(lengthRef.current - 1));
  });

  const setCursor = useCallback((n: number) => setCursorRaw(clamp(n)), [clamp]);

  return { cursor, setCursor };
}

import { useCallback, useRef, useState } from "react";
import type { KeyEvent } from "../types.js";

type VimListResult = {
  cursor: number;
  setCursor: (n: number) => void;
  handleKey: (key: KeyEvent) => boolean;
};

export function useVimList(length: number, enabled = true): VimListResult {
  const [cursor, setCursorRaw] = useState(0);
  const lengthRef = useRef(length);
  lengthRef.current = length;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const clamp = useCallback((n: number) => {
    const len = lengthRef.current;
    return Math.max(0, Math.min(len - 1, n));
  }, []);

  const handleKey = useCallback(
    (key: KeyEvent): boolean => {
      if (!enabledRef.current || lengthRef.current === 0) return false;
      if (key.name === "j" || key.name === "down") {
        setCursorRaw((c) => clamp(c + 1));
        return true;
      }
      if (key.name === "k" || key.name === "up") {
        setCursorRaw((c) => clamp(c - 1));
        return true;
      }
      if (key.name === "g" && !key.shift) {
        setCursorRaw(0);
        return true;
      }
      if (key.shift && key.name === "g") {
        setCursorRaw(clamp(lengthRef.current - 1));
        return true;
      }
      if (key.name === "home") {
        setCursorRaw(0);
        return true;
      }
      if (key.name === "end") {
        setCursorRaw(clamp(lengthRef.current - 1));
        return true;
      }
      return false;
    },
    [clamp],
  );

  const setCursor = useCallback((n: number) => setCursorRaw(clamp(n)), [clamp]);

  return { cursor, setCursor, handleKey };
}

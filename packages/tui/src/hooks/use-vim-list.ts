import { useKeyboard } from "@opentui/react";
import { useCallback, useState } from "react";

type VimListResult = {
  cursor: number;
  setCursor: (n: number) => void;
};

export function useVimList(length: number, enabled = true): VimListResult {
  const [cursor, setCursorRaw] = useState(0);

  const setCursor = useCallback(
    (n: number) => {
      setCursorRaw(Math.max(0, Math.min(length - 1, n)));
    },
    [length],
  );

  useKeyboard((key) => {
    if (!enabled || length === 0) return;
    if (key.name === "j" || key.name === "down") setCursor(cursor + 1);
    if (key.name === "k" || key.name === "up") setCursor(cursor - 1);
    if (key.name === "g") setCursor(0);
    if (key.shift && key.name === "g") setCursor(length - 1);
    if (key.name === "home") setCursor(0);
    if (key.name === "end") setCursor(length - 1);
  });

  return { cursor, setCursor };
}

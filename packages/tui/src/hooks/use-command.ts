import { useKeyboard } from "@opentui/react";
import { useCallback, useState } from "react";
import type { Command } from "../types.js";

type CommandState = {
  active: boolean;
  input: string;
  open: () => void;
  close: () => void;
};

export function useCommand(commands: Command[], enabled = true): CommandState {
  const [active, setActive] = useState(false);
  const [input, setInput] = useState("");

  const open = useCallback(() => {
    setActive(true);
    setInput("");
  }, []);

  const close = useCallback(() => {
    setActive(false);
    setInput("");
  }, []);

  useKeyboard((key) => {
    if (!enabled) return;

    if (!active) {
      if (key.shift && key.name === ";") {
        open();
      }
      return;
    }

    if (key.name === "escape") {
      close();
      return;
    }

    if (key.name === "return") {
      const trimmed = input.trim().toLowerCase();
      const cmd = commands.find((c) => c.name === trimmed || c.aliases.includes(trimmed));
      if (cmd) cmd.action();
      close();
      return;
    }

    if (key.name === "backspace") {
      setInput((s) => s.slice(0, -1));
      return;
    }

    if (key.name.length === 1 && !key.ctrl && !key.meta) {
      setInput((s) => s + key.name);
    }
  });

  return { active, input, open, close };
}

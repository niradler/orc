import { useKeyboard } from "@opentui/react";
import { useCallback, useRef, useState } from "react";
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
  const activeRef = useRef(false);
  const inputRef = useRef("");
  const enabledRef = useRef(enabled);
  const commandsRef = useRef(commands);
  enabledRef.current = enabled;
  commandsRef.current = commands;

  const open = useCallback(() => {
    setActive(true);
    activeRef.current = true;
    setInput("");
    inputRef.current = "";
  }, []);

  const close = useCallback(() => {
    setActive(false);
    activeRef.current = false;
    setInput("");
    inputRef.current = "";
  }, []);

  useKeyboard((key) => {
    if (!enabledRef.current) return;

    if (!activeRef.current) {
      if (key.name === ":" || (key.shift && key.name === ";")) {
        open();
      }
      return;
    }

    if (key.name === "escape") {
      close();
      return;
    }

    if (key.name === "return") {
      const trimmed = inputRef.current.trim().toLowerCase();
      const cmd = commandsRef.current.find(
        (c) => c.name === trimmed || c.aliases.includes(trimmed),
      );
      if (cmd) cmd.action();
      close();
      return;
    }

    if (key.name === "backspace") {
      inputRef.current = inputRef.current.slice(0, -1);
      setInput(inputRef.current);
      return;
    }

    if (key.name.length === 1 && !key.ctrl && !key.meta && key.name !== ":") {
      inputRef.current += key.name;
      setInput(inputRef.current);
    }
  });

  return { active, input, open, close };
}

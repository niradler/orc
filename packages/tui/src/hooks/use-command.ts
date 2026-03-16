import { useCallback, useRef, useState } from "react";
import type { Command, KeyEvent } from "../types.js";

type CommandState = {
  active: boolean;
  input: string;
  handleKey: (key: KeyEvent) => boolean;
};

export function useCommand(commands: Command[]): CommandState {
  const [active, setActive] = useState(false);
  const [input, setInput] = useState("");
  const activeRef = useRef(false);
  const inputRef = useRef("");
  const commandsRef = useRef(commands);
  commandsRef.current = commands;

  const handleKey = useCallback((key: KeyEvent): boolean => {
    if (!activeRef.current) {
      if (key.name === ":" || key.sequence === ":" || (key.shift && key.name === ";")) {
        setActive(true);
        activeRef.current = true;
        setInput("");
        inputRef.current = "";
        return true;
      }
      return false;
    }

    if (key.name === "escape") {
      setActive(false);
      activeRef.current = false;
      setInput("");
      inputRef.current = "";
      return true;
    }

    if (key.name === "return") {
      const trimmed = inputRef.current.trim().toLowerCase();
      const cmd = commandsRef.current.find(
        (c) => c.name === trimmed || c.aliases.includes(trimmed),
      );
      if (cmd) cmd.action();
      setActive(false);
      activeRef.current = false;
      setInput("");
      inputRef.current = "";
      return true;
    }

    if (key.name === "backspace") {
      inputRef.current = inputRef.current.slice(0, -1);
      setInput(inputRef.current);
      return true;
    }

    if (
      key.name.length === 1 &&
      !key.ctrl &&
      !key.meta &&
      key.name !== ":" &&
      key.name !== ";" &&
      key.sequence !== ":"
    ) {
      inputRef.current += key.name;
      setInput(inputRef.current);
      return true;
    }

    return true;
  }, []);

  return { active, input, handleKey };
}

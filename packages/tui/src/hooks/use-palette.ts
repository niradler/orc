import { useCallback, useRef, useState } from "react";
import type { KeyEvent, PaletteCategory, PaletteCommand } from "../types.js";

export type PaletteState = {
  open: boolean;
  input: string;
  cursor: number;
  results: PaletteCommand[];
  mode: "commands" | "search";
};

const CATEGORY_ORDER: Record<PaletteCategory, number> = {
  navigation: 0,
  sort: 1,
  filter: 2,
  search: 3,
  action: 4,
  system: 5,
};

function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (t === q) return 100;
  if (t.startsWith(q)) return 80;
  const words = t.split(/\s+/);
  if (words.some((w) => w.startsWith(q))) return 60;
  if (t.includes(q)) return 40;
  const initials = words.map((w) => w[0]).join("");
  if (initials.includes(q)) return 30;
  return 0;
}

function scoreCommand(query: string, cmd: PaletteCommand, recentIds: string[]): number {
  const targets = [cmd.name, cmd.id, ...cmd.aliases];
  let best = 0;
  for (const t of targets) {
    best = Math.max(best, fuzzyScore(query, t));
  }
  if (recentIds.includes(cmd.id)) {
    best += 10;
  }
  return best;
}

export function usePalette(commands: PaletteCommand[], onSearchActivate?: () => void) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [cursor, setCursor] = useState(0);
  const [mode, setMode] = useState<"commands" | "search">("commands");

  const openRef = useRef(false);
  const inputRef = useRef("");
  const cursorRef = useRef(0);
  const commandsRef = useRef(commands);
  commandsRef.current = commands;
  const recentIdsRef = useRef<string[]>([]);

  const getResults = useCallback((): PaletteCommand[] => {
    const cmds = commandsRef.current.filter((c) => c.available());
    const q = inputRef.current.trim();

    // Empty input: show all commands grouped by category
    if (!q) {
      return cmds.sort(
        (a, b) => (CATEGORY_ORDER[a.category] ?? 9) - (CATEGORY_ORDER[b.category] ?? 9),
      );
    }

    // Special: "sort" prefix filters to sort category
    if (q.toLowerCase().startsWith("sort")) {
      const sortQuery = q.slice(4).trim();
      const sortCmds = cmds.filter((c) => c.category === "sort");
      if (!sortQuery) return sortCmds;
      return sortCmds
        .map((c) => ({ cmd: c, score: scoreCommand(sortQuery, c, recentIdsRef.current) }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((r) => r.cmd);
    }

    // Special: "filter" prefix filters to filter category
    if (q.toLowerCase().startsWith("filter")) {
      const filterQuery = q.slice(6).trim();
      const filterCmds = cmds.filter((c) => c.category === "filter");
      if (!filterQuery) return filterCmds;
      return filterCmds
        .map((c) => ({ cmd: c, score: scoreCommand(filterQuery, c, recentIdsRef.current) }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((r) => r.cmd);
    }

    // General fuzzy search across all commands
    const scored = cmds
      .map((c) => ({ cmd: c, score: scoreCommand(q, c, recentIdsRef.current) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => {
        // First by score desc, then by category order
        if (b.score !== a.score) return b.score - a.score;
        return (CATEGORY_ORDER[a.cmd.category] ?? 9) - (CATEGORY_ORDER[b.cmd.category] ?? 9);
      });

    return scored.map((r) => r.cmd);
  }, []);

  const updateState = useCallback(() => {
    const results = getResults();
    setCursor((prev) => Math.min(prev, Math.max(0, results.length - 1)));
    cursorRef.current = Math.min(cursorRef.current, Math.max(0, results.length - 1));
  }, [getResults]);

  const openPalette = useCallback(() => {
    setOpen(true);
    openRef.current = true;
    setInput("");
    inputRef.current = "";
    setCursor(0);
    cursorRef.current = 0;
    setMode("commands");
  }, []);

  const closePalette = useCallback(() => {
    setOpen(false);
    openRef.current = false;
    setInput("");
    inputRef.current = "";
    setCursor(0);
    cursorRef.current = 0;
  }, []);

  const executeAtCursor = useCallback(() => {
    const results = getResults();
    const cmd = results[cursorRef.current];
    if (cmd) {
      // Track recency
      const recent = recentIdsRef.current.filter((id) => id !== cmd.id);
      recent.unshift(cmd.id);
      recentIdsRef.current = recent.slice(0, 10);

      // For filter commands, extract value from input (e.g. "filter status=todo" -> "todo")
      const q = inputRef.current.trim();
      let value: string | undefined;
      if (cmd.category === "filter") {
        const eqIdx = q.indexOf("=");
        if (eqIdx >= 0) {
          value = q.slice(eqIdx + 1).trim();
        }
      }

      closePalette();
      cmd.execute(value);
    } else {
      closePalette();
    }
  }, [getResults, closePalette]);

  const handleKey = useCallback(
    (key: KeyEvent): boolean => {
      if (!openRef.current) {
        if (key.name === ":" || key.sequence === ":" || (key.shift && key.name === ";")) {
          openPalette();
          return true;
        }
        return false;
      }

      if (key.name === "escape") {
        closePalette();
        return true;
      }

      // "/" as first character: activate view search and close
      if (inputRef.current === "" && (key.name === "/" || key.sequence === "/")) {
        closePalette();
        // Find and execute the search command, or call the activator
        const searchCmd = commandsRef.current.find((c) => c.id === "search-view");
        if (searchCmd) searchCmd.execute();
        return true;
      }

      if (key.name === "return") {
        const results = getResults();
        if (results.length > 0) {
          executeAtCursor();
        } else {
          closePalette();
        }
        return true;
      }

      if (key.name === "up") {
        cursorRef.current = Math.max(0, cursorRef.current - 1);
        setCursor(cursorRef.current);
        return true;
      }

      if (key.name === "down") {
        const results = getResults();
        cursorRef.current = Math.min(results.length - 1, cursorRef.current + 1);
        setCursor(cursorRef.current);
        return true;
      }

      if (key.name === "backspace") {
        inputRef.current = inputRef.current.slice(0, -1);
        setInput(inputRef.current);
        cursorRef.current = 0;
        setCursor(0);
        updateState();
        return true;
      }

      // Accept printable characters
      const ch = key.sequence ?? key.name;
      if (
        ch &&
        ch.length === 1 &&
        !key.ctrl &&
        !key.meta &&
        ch !== ":" &&
        key.name !== ";" &&
        key.sequence !== ":"
      ) {
        inputRef.current += ch;
        setInput(inputRef.current);
        cursorRef.current = 0;
        setCursor(0);
        updateState();
        return true;
      }

      // Also accept space
      if (key.name === "space") {
        inputRef.current += " ";
        setInput(inputRef.current);
        cursorRef.current = 0;
        setCursor(0);
        updateState();
        return true;
      }

      return true; // Consume all keys while open
    },
    [openPalette, closePalette, getResults, executeAtCursor, updateState],
  );

  const results = open ? getResults() : [];

  return {
    open,
    input,
    cursor,
    results,
    mode,
    handleKey,
    openPalette,
    closePalette,
  };
}

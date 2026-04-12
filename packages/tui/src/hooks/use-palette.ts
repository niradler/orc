import { useCallback, useRef, useState } from "react";
import type { KeyEvent, PaletteCategory, PaletteCommand } from "../types.js";

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

type PaletteMode = "commands" | "search";

const GATEWAY_SORT: PaletteCommand = {
  id: "gateway-sort",
  name: "Sort →",
  category: "sort",
  aliases: ["sort"],
  icon: "↕",
  available: () => true,
  execute: () => {},
};
const GATEWAY_FILTER: PaletteCommand = {
  id: "gateway-filter",
  name: "Filter →",
  category: "filter",
  aliases: ["filter"],
  icon: "⏳",
  available: () => true,
  execute: () => {},
};

export function usePalette(
  commands: PaletteCommand[],
  callbacks: {
    onSearchQuery?: (query: string) => void;
    onSearchClear?: () => void;
  } = {},
) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [cursor, setCursor] = useState(0);
  const [mode, setMode] = useState<PaletteMode>("commands");

  const openRef = useRef(false);
  const inputRef = useRef("");
  const cursorRef = useRef(0);
  const modeRef = useRef<PaletteMode>("commands");
  const commandsRef = useRef(commands);
  commandsRef.current = commands;
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;
  const recentIdsRef = useRef<string[]>([]);

  const getResults = useCallback((): PaletteCommand[] => {
    // In search mode, no command results — the palette shows search UI
    if (modeRef.current === "search") return [];

    const cmds = commandsRef.current.filter((c) => c.available());
    const q = inputRef.current.trim();

    // Empty input: show static commands + gateway entries for sort/filter
    if (!q) {
      const staticCmds = cmds.filter((c) => c.category !== "sort" && c.category !== "filter");
      const hasSortCmds = cmds.some((c) => c.category === "sort");
      const hasFilterCmds = cmds.some((c) => c.category === "filter");
      const gateways: PaletteCommand[] = [];
      if (hasSortCmds) gateways.push(GATEWAY_SORT);
      if (hasFilterCmds) gateways.push(GATEWAY_FILTER);
      return [...staticCmds, ...gateways].sort(
        (a, b) => (CATEGORY_ORDER[a.category] ?? 9) - (CATEGORY_ORDER[b.category] ?? 9),
      );
    }

    // "sort" prefix: filter to sort category
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

    // "filter" prefix: filter to filter category
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

    // General fuzzy search
    const scored = cmds
      .map((c) => ({ cmd: c, score: scoreCommand(q, c, recentIdsRef.current) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return (CATEGORY_ORDER[a.cmd.category] ?? 9) - (CATEGORY_ORDER[b.cmd.category] ?? 9);
      });

    return scored.map((r) => r.cmd);
  }, []);

  const openPalette = useCallback(() => {
    setOpen(true);
    openRef.current = true;
    setInput("");
    inputRef.current = "";
    setCursor(0);
    cursorRef.current = 0;
    setMode("commands");
    modeRef.current = "commands";
  }, []);

  const closePalette = useCallback(() => {
    // If in search mode, clear the view's search on close
    if (modeRef.current === "search") {
      callbacksRef.current.onSearchClear?.();
    }
    setOpen(false);
    openRef.current = false;
    setInput("");
    inputRef.current = "";
    setCursor(0);
    cursorRef.current = 0;
    setMode("commands");
    modeRef.current = "commands";
  }, []);

  const enterSearchMode = useCallback(() => {
    setMode("search");
    modeRef.current = "search";
    setInput("/ ");
    inputRef.current = "/ ";
    setCursor(0);
    cursorRef.current = 0;
    callbacksRef.current.onSearchQuery?.("");
  }, []);

  const drillInto = useCallback((prefix: string) => {
    inputRef.current = prefix;
    setInput(prefix);
    cursorRef.current = 0;
    setCursor(0);
  }, []);

  const executeAtCursor = useCallback(() => {
    const results = getResults();
    const cmd = results[cursorRef.current];
    if (cmd) {
      // Gateway commands drill into their category
      if (cmd.id === "gateway-sort") {
        drillInto("sort ");
        return;
      }
      if (cmd.id === "gateway-filter") {
        drillInto("filter ");
        return;
      }

      const recent = recentIdsRef.current.filter((id) => id !== cmd.id);
      recent.unshift(cmd.id);
      recentIdsRef.current = recent.slice(0, 10);

      // For filter commands, extract value from input
      const q = inputRef.current.trim();
      let value: string | undefined;
      if (cmd.category === "filter") {
        const eqIdx = q.indexOf("=");
        if (eqIdx >= 0) {
          value = q.slice(eqIdx + 1).trim();
        }
      }

      // Don't clear search on close when executing a command
      modeRef.current = "commands";
      setOpen(false);
      openRef.current = false;
      setInput("");
      inputRef.current = "";
      setCursor(0);
      cursorRef.current = 0;
      setMode("commands");

      cmd.execute(value);
    } else {
      closePalette();
    }
  }, [getResults, closePalette, drillInto]);

  const handleKey = useCallback(
    (key: KeyEvent): boolean => {
      if (!openRef.current) {
        if (key.name === ":" || key.sequence === ":" || (key.shift && key.name === ";")) {
          openPalette();
          return true;
        }
        return false;
      }

      // Escape: close (and clear search if in search mode)
      if (key.name === "escape") {
        closePalette();
        return true;
      }

      // Search mode: all typing goes to search query
      if (modeRef.current === "search") {
        if (key.name === "return") {
          // Confirm search, close palette but keep filter active
          modeRef.current = "commands";
          setOpen(false);
          openRef.current = false;
          setInput("");
          inputRef.current = "";
          setMode("commands");
          return true;
        }

        if (key.name === "backspace") {
          const current = inputRef.current;
          if (current === "/ " || current === "/") {
            // Backspace past prefix exits search mode, clears search
            closePalette();
            return true;
          }
          inputRef.current = current.slice(0, -1);
          setInput(inputRef.current);
          const searchText = inputRef.current.slice(2); // after "/ "
          callbacksRef.current.onSearchQuery?.(searchText);
          return true;
        }

        const ch = key.name === "space" ? " " : (key.sequence ?? key.name);
        if (ch && ch.length === 1 && !key.ctrl && !key.meta) {
          inputRef.current += ch;
          setInput(inputRef.current);
          const searchText = inputRef.current.slice(2); // after "/ "
          callbacksRef.current.onSearchQuery?.(searchText);
          return true;
        }

        return true; // consume all other keys in search mode
      }

      // Command mode: "/" as first char enters search mode
      if (inputRef.current === "" && (key.name === "/" || key.sequence === "/")) {
        enterSearchMode();
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
        return true;
      }

      if (key.name === "space") {
        inputRef.current += " ";
        setInput(inputRef.current);
        cursorRef.current = 0;
        setCursor(0);
        return true;
      }

      return true; // Consume all keys while open
    },
    [openPalette, closePalette, enterSearchMode, getResults, executeAtCursor],
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

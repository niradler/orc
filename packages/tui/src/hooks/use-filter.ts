import { useKeyboard } from "@opentui/react";
import { useCallback, useMemo, useState } from "react";

type FilterResult<T> = {
  filtered: T[];
  query: string;
  active: boolean;
  open: () => void;
  close: () => void;
  clear: () => void;
};

export function useFilter<T>(
  items: T[],
  getSearchText: (item: T) => string,
  enabled = true,
): FilterResult<T> {
  const [active, setActive] = useState(false);
  const [query, setQuery] = useState("");

  const open = useCallback(() => {
    setActive(true);
    setQuery("");
  }, []);

  const close = useCallback(() => {
    setActive(false);
  }, []);

  const clear = useCallback(() => {
    setQuery("");
    setActive(false);
  }, []);

  useKeyboard((key) => {
    if (!enabled) return;

    if (!active) {
      if (key.name === "/" && !key.ctrl && !key.meta) {
        open();
      }
      return;
    }

    if (key.name === "escape") {
      close();
      return;
    }

    if (key.name === "return") {
      setActive(false);
      return;
    }

    if (key.name === "backspace") {
      setQuery((s) => {
        if (s.length === 0) {
          setActive(false);
          return s;
        }
        return s.slice(0, -1);
      });
      return;
    }

    if (key.name.length === 1 && !key.ctrl && !key.meta) {
      setQuery((s) => s + key.name);
    }
  });

  const filtered = useMemo(() => {
    if (!query) return items;
    const lower = query.toLowerCase();
    return items.filter((item) => getSearchText(item).toLowerCase().includes(lower));
  }, [items, query, getSearchText]);

  return { filtered, query, active, open, close, clear };
}

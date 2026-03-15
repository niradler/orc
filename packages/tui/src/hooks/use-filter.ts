import { useKeyboard } from "@opentui/react";
import { useCallback, useMemo, useRef, useState } from "react";

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
  const activeRef = useRef(false);
  const queryRef = useRef("");
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const open = useCallback(() => {
    setActive(true);
    activeRef.current = true;
    setQuery("");
    queryRef.current = "";
  }, []);

  const close = useCallback(() => {
    setActive(false);
    activeRef.current = false;
  }, []);

  const clear = useCallback(() => {
    setQuery("");
    queryRef.current = "";
    setActive(false);
    activeRef.current = false;
  }, []);

  useKeyboard((key) => {
    if (!enabledRef.current) return;

    if (!activeRef.current) {
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
      activeRef.current = false;
      return;
    }

    if (key.name === "backspace") {
      if (queryRef.current.length === 0) {
        setActive(false);
        activeRef.current = false;
        return;
      }
      queryRef.current = queryRef.current.slice(0, -1);
      setQuery(queryRef.current);
      return;
    }

    if (key.name.length === 1 && !key.ctrl && !key.meta) {
      queryRef.current += key.name;
      setQuery(queryRef.current);
    }
  });

  const filtered = useMemo(() => {
    if (!query) return items;
    const lower = query.toLowerCase();
    return items.filter((item) => getSearchText(item).toLowerCase().includes(lower));
  }, [items, query, getSearchText]);

  return { filtered, query, active, open, close, clear };
}

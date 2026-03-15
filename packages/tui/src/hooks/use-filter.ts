import { useCallback, useMemo, useRef, useState } from "react";
import type { KeyEvent } from "../types.js";

type FilterResult<T> = {
  filtered: T[];
  query: string;
  active: boolean;
  handleKey: (key: KeyEvent) => boolean;
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

  const handleKey = useCallback((key: KeyEvent): boolean => {
    if (!enabledRef.current) return false;

    if (!activeRef.current) {
      if (key.name === "/" && !key.ctrl && !key.meta) {
        setActive(true);
        activeRef.current = true;
        setQuery("");
        queryRef.current = "";
        return true;
      }
      return false;
    }

    if (key.name === "escape") {
      setActive(false);
      activeRef.current = false;
      return true;
    }

    if (key.name === "return") {
      setActive(false);
      activeRef.current = false;
      return true;
    }

    if (key.name === "backspace") {
      if (queryRef.current.length === 0) {
        setActive(false);
        activeRef.current = false;
        return true;
      }
      queryRef.current = queryRef.current.slice(0, -1);
      setQuery(queryRef.current);
      return true;
    }

    if (key.name.length === 1 && !key.ctrl && !key.meta) {
      queryRef.current += key.name;
      setQuery(queryRef.current);
      return true;
    }

    return true;
  }, []);

  const filtered = useMemo(() => {
    if (!query) return items;
    const lower = query.toLowerCase();
    return items.filter((item) => getSearchText(item).toLowerCase().includes(lower));
  }, [items, query, getSearchText]);

  return { filtered, query, active, handleKey };
}

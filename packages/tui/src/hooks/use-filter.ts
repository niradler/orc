import { useCallback, useMemo, useState } from "react";

type FilterResult<T> = {
  filtered: T[];
  query: string;
  active: boolean;
  setQuery: (query: string) => void;
  setActive: (active: boolean) => void;
  clear: () => void;
};

export function useFilter<T>(
  items: T[],
  getSearchText: (item: T) => string,
  enabled = true,
): FilterResult<T> {
  const [active, setActive] = useState(false);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    if (!query) return items;
    const lower = query.toLowerCase();
    return items.filter((item) => getSearchText(item).toLowerCase().includes(lower));
  }, [items, query, getSearchText]);

  const clear = useCallback(() => {
    setQuery("");
    setActive(false);
  }, []);

  return {
    filtered: enabled ? filtered : items,
    query,
    active,
    setQuery,
    setActive,
    clear,
  };
}

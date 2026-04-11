import { useCallback, useState } from "react";
import type { Column, SortState } from "../types.js";

const DEFAULT_SORT: SortState = { key: "updated_at", direction: "desc" };

export function useSort<T>(columns: Column<T>[], initialSort: SortState = DEFAULT_SORT) {
  const hasInitialCol = columns.some((c) => c.key === initialSort.key && c.sortValue);
  const [sort, setSort] = useState<SortState>(
    hasInitialCol ? initialSort : { key: null, direction: "asc" },
  );

  const sortData = useCallback(
    (data: T[]): T[] => {
      if (!sort.key) return data;
      const col = columns.find((c) => c.key === sort.key);
      if (!col?.sortValue) return data;
      const sv = col.sortValue;
      return [...data].sort((a, b) => {
        const va = sv(a);
        const vb = sv(b);
        const cmp = va < vb ? -1 : va > vb ? 1 : 0;
        return sort.direction === "asc" ? cmp : -cmp;
      });
    },
    [sort, columns],
  );

  const setSortByKey = useCallback((key: string, direction?: "asc" | "desc") => {
    setSort((current) => {
      if (direction) return { key, direction };
      if (current.key === key) {
        if (current.direction === "asc") return { key, direction: "desc" };
        return { key: null, direction: "asc" }; // clear
      }
      return { key, direction: "asc" };
    });
  }, []);

  const toggleDirection = useCallback(() => {
    setSort((current) => {
      if (!current.key) return current;
      return { key: current.key, direction: current.direction === "asc" ? "desc" : "asc" };
    });
  }, []);

  return { sort, setSortByKey, toggleDirection, sortData };
}

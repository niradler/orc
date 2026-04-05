import { useCallback, useState } from "react";
import type { Column, SortState } from "../types.js";

export function useSort<T>(columns: Column<T>[]) {
  const [sort, setSort] = useState<SortState>({ key: null, direction: "asc" });

  const sortableKeys = columns.filter((c) => c.sortValue).map((c) => c.key);

  const cycleSort = useCallback(() => {
    setSort((current) => {
      if (!current.key) {
        return { key: sortableKeys[0] ?? null, direction: "asc" };
      }
      if (current.direction === "asc") {
        return { key: current.key, direction: "desc" };
      }
      const idx = sortableKeys.indexOf(current.key);
      const nextKey = sortableKeys[idx + 1] ?? null;
      if (!nextKey) return { key: null, direction: "asc" };
      return { key: nextKey, direction: "asc" };
    });
  }, [sortableKeys]);

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

  return { sort, cycleSort, sortData };
}

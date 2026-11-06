import { type FocusEvent, useCallback, useEffect, useRef, useState } from "react";
import { stableOrder, type Versioned } from "@/lib/stable-order";

/** Freezes row order while the list is hovered or keyboard-focused; states still update live. */
export function useStableOrder<T>({
  items,
  id,
  version,
  lookup,
  resetKey,
  loading = false,
}: {
  items: readonly T[];
  id: (item: T) => string;
  version: (item: T) => string;
  lookup: (id: string) => T | undefined;
  resetKey: string;
  loading?: boolean;
}) {
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [snapshot, setSnapshot] = useState<{ key: string; rows: Versioned[] } | null>(null);
  const frozen = hover || focus;
  const live = items.map((item) => ({ id: id(item), version: version(item) }));
  const latest = useRef(live);
  latest.current = live;
  const filled = live.length > 0 && !loading;
  const rows =
    frozen && filled && snapshot?.key === resetKey && snapshot.rows.length ? snapshot.rows : null;
  useEffect(() => {
    if (!frozen) setSnapshot(null);
    else if (!rows && filled) setSnapshot({ key: resetKey, rows: latest.current });
  }, [frozen, rows, resetKey, filled]);
  const apply = useCallback(() => setSnapshot({ key: resetKey, rows: latest.current }), [resetKey]);
  const ref = useCallback((node: HTMLElement | null) => {
    if (node) return;
    setHover(false);
    setFocus(false);
  }, []);
  const props = { ref, ...listProps(setHover, setFocus) };
  if (!rows) return { items, pending: 0, apply, listProps: props };
  const { order, pending } = stableOrder(rows, live, (key) => lookup(key) !== undefined);
  return {
    items: order.flatMap((key) => {
      const item = lookup(key);
      return item === undefined ? [] : [item];
    }),
    pending,
    apply,
    listProps: props,
  };
}

function listProps(setHover: (value: boolean) => void, setFocus: (value: boolean) => void) {
  return {
    onPointerEnter: () => setHover(true),
    onPointerLeave: () => setHover(false),
    onFocus: (event: FocusEvent<HTMLElement>) => {
      if (event.target.matches(":focus-visible")) setFocus(true);
    },
    onBlur: (event: FocusEvent<HTMLElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setFocus(false);
    },
  };
}

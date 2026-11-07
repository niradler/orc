import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

const BOTTOM_SLACK = 4;
const UP_KEYS = new Set(["ArrowUp", "PageUp", "Home"]);

function atBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= BOTTOM_SLACK;
}

/**
 * Follows new output only while the reader is at the bottom; any upward gesture or
 * opening a disclosure releases it, and reaching the bottom again re-pins.
 */
export function usePinnedScroll({
  resetKey,
  count,
  restoring,
}: {
  resetKey: string;
  count: number;
  restoring: boolean;
}) {
  const viewport = useRef<HTMLElement | null>(null);
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [inner, setInner] = useState<HTMLElement | null>(null);
  const viewportRef = useCallback((node: HTMLElement | null) => {
    viewport.current = node;
    setElement(node);
  }, []);
  const [pinned, setPinnedState] = useState(true);
  const pinnedRef = useRef(true);
  const [releasedAt, setReleasedAt] = useState(count);
  const countRef = useRef(count);
  countRef.current = count;
  const lastTop = useRef(0);
  const held = useRef<{ height: number; top: number; key: string } | null>(null);

  const setPinned = useCallback((value: boolean) => {
    if (pinnedRef.current === value) return;
    pinnedRef.current = value;
    setPinnedState(value);
    if (!value) setReleasedAt(countRef.current);
  }, []);

  const toBottom = useCallback(() => {
    const element = viewport.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    lastTop.current = element.scrollTop;
  }, []);

  const pinToBottom = useCallback(() => {
    setPinned(true);
    toBottom();
  }, [setPinned, toBottom]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: resetKey marks a thread switch
  useLayoutEffect(() => {
    pinnedRef.current = true;
    setPinnedState(true);
    toBottom();
  }, [resetKey, toBottom]);

  useEffect(() => {
    if (!element) return;
    const onScroll = () => {
      const top = element.scrollTop;
      if (atBottom(element)) setPinned(true);
      else if (top < lastTop.current - 1) setPinned(false);
      lastTop.current = top;
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) setPinned(false);
    };
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (UP_KEYS.has(event.key) && !target?.closest("input, textarea, [contenteditable]"))
        setPinned(false);
    };
    const onPointer = (event: PointerEvent) => {
      if (event.target === element) setPinned(false);
    };
    const onClick = (event: MouseEvent) => {
      if ((event.target as HTMLElement | null)?.closest("summary")) setPinned(false);
    };
    const follow = () => {
      if (pinnedRef.current) toBottom();
    };
    const observer = new ResizeObserver(follow);
    observer.observe(element);
    if (inner) observer.observe(inner);
    element.addEventListener("scroll", onScroll, { passive: true });
    element.addEventListener("wheel", onWheel, { passive: true });
    element.addEventListener("keydown", onKey);
    element.addEventListener("pointerdown", onPointer, { passive: true });
    element.addEventListener("click", onClick, { capture: true });
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", onScroll);
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("keydown", onKey);
      element.removeEventListener("pointerdown", onPointer);
      element.removeEventListener("click", onClick, { capture: true });
    };
  }, [element, inner, setPinned, toBottom]);

  const keepPosition = useCallback(() => {
    const element = viewport.current;
    if (element)
      held.current = { height: element.scrollHeight, top: element.scrollTop, key: resetKey };
  }, [resetKey]);

  useLayoutEffect(() => {
    const anchor = held.current;
    const element = viewport.current;
    if (restoring || !anchor || !element) return;
    if (anchor.key === resetKey) {
      element.scrollTop = anchor.top + element.scrollHeight - anchor.height;
      lastTop.current = element.scrollTop;
    }
    held.current = null;
  }, [restoring, resetKey]);

  return {
    pinned,
    newCount: pinned ? 0 : Math.max(0, count - releasedAt),
    pinToBottom,
    keepPosition,
    viewportRef,
    contentRef: setInner,
  };
}

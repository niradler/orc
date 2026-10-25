interface TerminalTouchZoom {
  getFontSize: () => number;
  setFontSize: (size: number) => void;
}

export function attachTerminalTouchScroll(element: HTMLElement, zoom?: TerminalTouchZoom): void {
  let gesture: { id: number; startY: number; y: number; moved: boolean } | null = null;
  let pinch: { distance: number; size: number } | null = null;
  let consumed = false;
  // A pinch reports many moves per frame and each font change refits the terminal and
  // resizes the PTY, so only the latest size in a frame is applied.
  let pendingSize: number | null = null;
  let sizeFrame = 0;
  const zoomTo = (size: number) => {
    pendingSize = size;
    if (sizeFrame) return;
    sizeFrame = requestAnimationFrame(() => {
      sizeFrame = 0;
      if (pendingSize !== null) zoom?.setFontSize(pendingSize);
      pendingSize = null;
    });
  };
  const distance = (touches: TouchList) => {
    const first = touches[0];
    const second = touches[1];
    return first && second
      ? Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY)
      : 0;
  };
  element.addEventListener(
    "touchstart",
    (event) => {
      if (event.touches.length >= 2) {
        gesture = null;
        consumed = true;
        const span = distance(event.touches);
        pinch =
          event.touches.length === 2 && zoom && span > 0
            ? { distance: span, size: zoom.getFontSize() }
            : null;
        event.preventDefault();
        return;
      }
      const touch = !consumed && event.touches.length === 1 ? event.touches[0] : undefined;
      gesture = touch
        ? { id: touch.identifier, startY: touch.clientY, y: touch.clientY, moved: false }
        : null;
    },
    { passive: false },
  );
  element.addEventListener(
    "touchmove",
    (event) => {
      if (pinch && zoom && event.touches.length === 2) {
        event.preventDefault();
        zoomTo((pinch.size * distance(event.touches)) / pinch.distance);
        return;
      }
      if (!gesture || event.touches.length !== 1) {
        if (consumed) event.preventDefault();
        return;
      }
      const touch = Array.from(event.touches).find((touch) => touch.identifier === gesture?.id);
      if (!touch || (!gesture.moved && Math.abs(touch.clientY - gesture.startY) < 6)) return;
      const canvas = element.querySelector("canvas");
      if (!canvas) return;
      const deltaY = gesture.y - touch.clientY;
      gesture.y = touch.clientY;
      gesture.moved = true;
      consumed = true;
      event.preventDefault();
      canvas.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          deltaY,
          clientX: touch.clientX,
          clientY: touch.clientY,
        }),
      );
    },
    { passive: false },
  );
  element.addEventListener(
    "touchend",
    (event) => {
      if (consumed) {
        event.preventDefault();
        event.stopPropagation();
      }
      gesture = null;
      pinch = null;
      // Keep suppressing taps until every finger in a pinch/pan has been lifted.
      if (event.touches.length === 0) consumed = false;
    },
    { capture: true, passive: false },
  );
  element.addEventListener(
    "touchcancel",
    () => {
      gesture = null;
      pinch = null;
      consumed = false;
    },
    { passive: true },
  );
}

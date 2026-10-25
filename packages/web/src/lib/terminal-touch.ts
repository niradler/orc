interface TerminalTouchZoom {
  getFontSize: () => number;
  setFontSize: (size: number) => void;
}

/** The selectable text over the terminal; a long press on it is the browser's own. */
export interface TerminalTouchText {
  element: HTMLElement;
  selected: () => boolean;
  clear: () => void;
}

/** A press held this long is a long press, never a tap. */
export const LONG_PRESS_MS = 450;

export function attachTerminalTouchScroll(
  element: HTMLElement,
  zoom?: TerminalTouchZoom,
  text?: TerminalTouchText,
  tap?: (x: number, y: number) => void,
): void {
  let gesture: {
    id: number;
    startX: number;
    startY: number;
    y: number;
    at: number;
    moved: boolean;
    /** Text was already selected, so this touch dismisses or scrolls instead of selecting. */
    hadSelection: boolean;
  } | null = null;
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
      // A long press on the text layer is left to the browser, which selects natively. Anywhere
      // else it would land on ghostty's editable root, select there and raise the keyboard, so
      // the touch is taken over; that also stops emulated mouse events, so taps are replayed.
      const target = event.target instanceof Node ? event.target : null;
      if (tap && !text?.element.contains(target)) event.preventDefault();
      const touch = !consumed && event.touches.length === 1 ? event.touches[0] : undefined;
      gesture = touch
        ? {
            id: touch.identifier,
            startX: touch.clientX,
            startY: touch.clientY,
            y: touch.clientY,
            at: performance.now(),
            moved: false,
            hadSelection: text?.selected() ?? false,
          }
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
      if (!touch) return;
      // A long press that selected now drags the selection natively.
      if (!gesture.hadSelection && text?.selected()) return;
      if (!gesture.moved && Math.abs(touch.clientY - gesture.startY) < 6) return;
      // The selected rows are about to scroll away from the text under them.
      if (!gesture.moved) text?.clear();
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
      const pressed = gesture;
      if (consumed) {
        event.preventDefault();
        event.stopPropagation();
      } else if (pressed && !pressed.moved && event.touches.length === 0) {
        if (pressed.hadSelection) {
          // A tap away from a selection only dismisses it.
          event.preventDefault();
          text?.clear();
        } else if (!text?.selected() && performance.now() - pressed.at < LONG_PRESS_MS && tap) {
          event.preventDefault();
          tap(pressed.startX, pressed.startY);
        }
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

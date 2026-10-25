interface TerminalTouchZoom {
  getFontSize: () => number;
  setFontSize: (size: number) => void;
}

/** Text selection driven by a long press: begin where it fired, extend with the finger. */
export interface TerminalTouchSelect {
  begin: (x: number, y: number) => void;
  extend: (x: number, y: number) => void;
  end: () => void;
}

export const LONG_PRESS_MS = 450;

export function attachTerminalTouchScroll(
  element: HTMLElement,
  zoom?: TerminalTouchZoom,
  select?: TerminalTouchSelect,
  tap?: (x: number, y: number) => void,
): void {
  let gesture: {
    id: number;
    startX: number;
    startY: number;
    y: number;
    moved: boolean;
    selecting: boolean;
  } | null = null;
  let pressTimer = 0;
  const cancelPress = () => {
    clearTimeout(pressTimer);
    pressTimer = 0;
  };
  const endSelection = () => {
    if (gesture?.selecting) select?.end();
  };
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
      cancelPress();
      if (event.touches.length >= 2) {
        endSelection();
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
      // The terminal root is editable, so the browser's own long press would select natively,
      // raise the keyboard and cancel the touch. Taking the touch over stops that, and the
      // emulated mouse events with it, so a tap is replayed on touchend instead.
      if (tap) event.preventDefault();
      const touch = !consumed && event.touches.length === 1 ? event.touches[0] : undefined;
      const pressed = touch
        ? {
            id: touch.identifier,
            startX: touch.clientX,
            startY: touch.clientY,
            y: touch.clientY,
            moved: false,
            selecting: false,
          }
        : null;
      gesture = pressed;
      if (!pressed || !touch || !select) return;
      const { clientX, clientY } = touch;
      pressTimer = window.setTimeout(() => {
        pressTimer = 0;
        if (gesture !== pressed || pressed.moved) return;
        pressed.selecting = true;
        consumed = true;
        select.begin(clientX, clientY);
      }, LONG_PRESS_MS);
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
      if (gesture.selecting) {
        event.preventDefault();
        select?.extend(touch.clientX, touch.clientY);
        return;
      }
      if (!gesture.moved && Math.abs(touch.clientY - gesture.startY) < 6) return;
      cancelPress();
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
      } else if (gesture && !gesture.moved && !gesture.selecting && event.touches.length === 0) {
        tap?.(gesture.startX, gesture.startY);
      }
      cancelPress();
      endSelection();
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
      cancelPress();
      endSelection();
      gesture = null;
      pinch = null;
      consumed = false;
    },
    { passive: true },
  );
  // A long press raises the context menu on Android, and ghostty answers it by focusing its
  // input under the finger, which opens the keyboard over the selection.
  element.addEventListener(
    "contextmenu",
    (event) => {
      if (!gesture && !consumed) return;
      event.preventDefault();
      event.stopPropagation();
    },
    true,
  );
}

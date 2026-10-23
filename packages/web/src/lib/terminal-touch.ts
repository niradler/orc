export function attachTerminalTouchScroll(element: HTMLElement): void {
  let gesture: { id: number; startY: number; y: number; moved: boolean } | null = null;
  element.addEventListener(
    "touchstart",
    (event) => {
      const touch = event.touches.length === 1 ? event.touches[0] : undefined;
      gesture = touch
        ? { id: touch.identifier, startY: touch.clientY, y: touch.clientY, moved: false }
        : null;
    },
    { passive: true },
  );
  element.addEventListener(
    "touchmove",
    (event) => {
      if (!gesture || event.touches.length !== 1) {
        gesture = null;
        return;
      }
      const touch = Array.from(event.touches).find((touch) => touch.identifier === gesture?.id);
      if (!touch) return;
      if (!gesture.moved && Math.abs(touch.clientY - gesture.startY) < 6) return;
      const canvas = element.querySelector("canvas");
      if (!canvas) return;
      const deltaY = gesture.y - touch.clientY;
      gesture.y = touch.clientY;
      gesture.moved = true;
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
      if (gesture?.moved) {
        event.preventDefault();
        event.stopPropagation();
      }
      gesture = null;
    },
    { capture: true, passive: false },
  );
  element.addEventListener(
    "touchcancel",
    () => {
      gesture = null;
    },
    { passive: true },
  );
}

import { useCallback, useEffect, useRef, useState } from "react";

export type MobilePanelTarget = "sessions" | "inspector" | "terminal";

/** How far from the frame edge an opening swipe may start. Interior horizontal
 *  scrollers (code blocks, diffs, terminal key strips) keep their swipes. */
export const PANEL_OPEN_EDGE_WIDTH = 44;
const ACTIVATE_DISTANCE = 14;
const COMMIT_PROGRESS = 0.32;
const COMMIT_VELOCITY = 0.45;
const SETTLE_MS = 170;

export type GestureIntent = "activate" | "fail" | "wait";

/** Direction-locked intent: the gesture must move along its axis, far enough,
 *  and not fight a perpendicular scroll. Mirrors the paseo panel arbitration. */
export function resolveGestureIntent(input: {
  deltaX: number;
  deltaY: number;
  axis: "horizontal" | "vertical";
  direction: 1 | -1;
}): GestureIntent {
  const along = input.axis === "horizontal" ? input.deltaX : input.deltaY;
  const across = input.axis === "horizontal" ? input.deltaY : input.deltaX;
  const directed = along * input.direction;
  if (directed <= -10 || (Math.abs(across) > 10 && Math.abs(across) > Math.abs(along)))
    return "fail";
  if (directed >= ACTIVATE_DISTANCE && Math.abs(along) > Math.abs(across) * 1.2) return "activate";
  return "wait";
}

function isSwipeBlockedTarget(target: EventTarget | null, frame: HTMLElement): boolean {
  if (!(target instanceof Element)) return true;
  if (
    target.closest(
      "[data-swipe-ignore], pre, code, textarea, input, select, [role='separator'], [data-testid='terminal-viewport']",
    )
  )
    return true;
  // Any ancestor that actually scrolls horizontally owns the swipe.
  let node: Element | null = target;
  while (node && node !== frame) {
    if (node.scrollWidth > node.clientWidth + 4) {
      const overflowX = getComputedStyle(node).overflowX;
      if (overflowX === "auto" || overflowX === "scroll") return true;
    }
    node = node.parentElement;
  }
  return false;
}

interface GestureConfig {
  enabled: boolean;
  /** The settled panel from the URL, if any. */
  openPanel: MobilePanelTarget | null;
  onOpen: (target: MobilePanelTarget) => void;
  onClose: () => void;
}

interface ActiveGesture {
  target: MobilePanelTarget;
  mode: "open" | "close";
  axis: "horizontal" | "vertical";
  direction: 1 | -1;
  startX: number;
  startY: number;
  startTime: number;
  lastX: number;
  lastY: number;
  lastTime: number;
  velocity: number;
  activated: boolean;
  pointerId: number;
}

/**
 * Phone chat navigation: swipe left opens Sessions, swipe right opens the
 * Inspector, pulling down on the chat header opens the Terminal. Open panels
 * close with the reverse swipe. Panels follow the finger; only the settled
 * target is published to the URL.
 */
export function useMobilePanelGestures({ enabled, openPanel, onOpen, onClose }: GestureConfig) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const panelsRef = useRef(new Map<MobilePanelTarget, HTMLDivElement>());
  const gestureRef = useRef<ActiveGesture | null>(null);
  const settlingRef = useRef(false);
  const settleTimer = useRef<number | null>(null);
  const [dragTarget, setDragTarget] = useState<MobilePanelTarget | null>(null);
  const configRef = useRef({ openPanel, onOpen, onClose });
  configRef.current = { openPanel, onOpen, onClose };
  const reducedMotion =
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const registerPanel = useCallback((target: MobilePanelTarget, node: HTMLDivElement | null) => {
    if (node) panelsRef.current.set(target, node);
    else panelsRef.current.delete(target);
  }, []);

  const panelSize = (target: MobilePanelTarget) => {
    const frame = frameRef.current;
    if (!frame) return 1;
    return target === "terminal" ? frame.clientHeight || 1 : frame.clientWidth || 1;
  };

  const writeTransform = (target: MobilePanelTarget, progress: number, mode: "open" | "close") => {
    const panel = panelsRef.current.get(target);
    if (!panel) return;
    // progress 0 = the gesture's resting start (offscreen when opening, covering
    // when closing); progress 1 = the opposite end.
    const offset = (1 - Math.min(1, Math.max(0, progress))) * 100;
    const shift = mode === "open" ? offset : 100 - offset;
    const transform =
      target === "sessions"
        ? `translateX(${shift}%)`
        : target === "inspector"
          ? `translateX(${-shift}%)`
          : `translateY(${-shift}%)`;
    panel.style.transform = shift === 0 ? "" : transform;
  };

  const clearGesture = useCallback(() => {
    gestureRef.current = null;
  }, []);

  const cancelSettle = useCallback(() => {
    if (settleTimer.current !== null) {
      window.clearTimeout(settleTimer.current);
      settleTimer.current = null;
    }
    settlingRef.current = false;
    const settled = configRef.current.openPanel;
    for (const [target, panel] of panelsRef.current) {
      panel.style.transition = "";
      // Snap a committed-open panel to rest so the next drag starts clean.
      if (target === settled) panel.style.transform = "";
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: panel helpers only read refs
  const finishDrag = useCallback(
    (commit: boolean) => {
      const gesture = gestureRef.current;
      if (!gesture) return;
      gestureRef.current = null;
      const panel = panelsRef.current.get(gesture.target);
      const { onOpen: open, onClose: close } = configRef.current;
      const settle = () => {
        settlingRef.current = false;
        settleTimer.current = null;
        // Keep the transform: a committed-open panel rests at 0, a closing one
        // unmounts offscreen. Clearing it here would flash the panel back.
        if (panel) panel.style.transition = "";
        setDragTarget((current) => (current === gesture.target ? null : current));
      };
      if (commit) {
        if (gesture.mode === "open") open(gesture.target);
        else close();
      }
      if (!panel || reducedMotion) {
        settle();
        return;
      }
      settlingRef.current = true;
      panel.style.transition = `transform ${SETTLE_MS}ms ease-out`;
      if (commit) {
        if (gesture.mode === "open") panel.style.transform = "";
        // Slide fully out before the URL-driven unmount.
        else writeTransform(gesture.target, 0, "open");
      } else {
        // Cancel returns to the gesture's start: offscreen when opening,
        // covering when closing.
        writeTransform(gesture.target, 0, gesture.mode);
      }
      settleTimer.current = window.setTimeout(settle, SETTLE_MS + 30);
    },
    [reducedMotion],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: listeners read the latest state through refs
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || !enabled) return;

    const onTouchStart = (event: TouchEvent) => {
      if (gestureRef.current || event.touches.length !== 1) return;
      // A quick follow-up swipe takes over from the settle animation.
      if (settlingRef.current) cancelSettle();
      const touch = event.touches[0];
      if (!touch) return;
      const rect = frame.getBoundingClientRect();
      const x = touch.clientX - rect.left;
      const y = touch.clientY - rect.top;
      const { openPanel: settled } = configRef.current;
      const headerZone = !!(event.target as Element | null)?.closest?.(
        "[data-chat-gesture-header]",
      );
      let candidate: Omit<
        ActiveGesture,
        "activated" | "pointerId" | "lastX" | "lastY" | "lastTime" | "velocity"
      > | null = null;
      if (settled) {
        // Closing swipes start anywhere on the panel except its own scrollers;
        // the terminal closes from its header so the canvas keeps its touches.
        if (settled === "terminal" && !headerZone) return;
        if (isSwipeBlockedTarget(event.target, frame)) return;
        candidate =
          settled === "sessions"
            ? {
                target: settled,
                mode: "close",
                axis: "horizontal",
                direction: 1,
                startX: x,
                startY: y,
                startTime: event.timeStamp,
              }
            : settled === "inspector"
              ? {
                  target: settled,
                  mode: "close",
                  axis: "horizontal",
                  direction: -1,
                  startX: x,
                  startY: y,
                  startTime: event.timeStamp,
                }
              : {
                  target: settled,
                  mode: "close",
                  axis: "vertical",
                  direction: -1,
                  startX: x,
                  startY: y,
                  startTime: event.timeStamp,
                };
      } else {
        if (isSwipeBlockedTarget(event.target, frame)) return;
        if (headerZone && y <= 120) {
          candidate = {
            target: "terminal",
            mode: "open",
            axis: "vertical",
            direction: 1,
            startX: x,
            startY: y,
            startTime: event.timeStamp,
          };
        } else if (x >= rect.width - PANEL_OPEN_EDGE_WIDTH) {
          candidate = {
            target: "sessions",
            mode: "open",
            axis: "horizontal",
            direction: -1,
            startX: x,
            startY: y,
            startTime: event.timeStamp,
          };
        } else if (x <= PANEL_OPEN_EDGE_WIDTH) {
          candidate = {
            target: "inspector",
            mode: "open",
            axis: "horizontal",
            direction: 1,
            startX: x,
            startY: y,
            startTime: event.timeStamp,
          };
        }
      }
      if (!candidate) return;
      gestureRef.current = {
        ...candidate,
        lastX: x,
        lastY: y,
        lastTime: event.timeStamp,
        velocity: 0,
        activated: false,
        pointerId: touch.identifier,
      };
    };

    const onTouchMove = (event: TouchEvent) => {
      const gesture = gestureRef.current;
      if (!gesture || event.touches.length !== 1) return;
      const touch = Array.from(event.touches).find((item) => item.identifier === gesture.pointerId);
      if (!touch) return;
      const rect = frame.getBoundingClientRect();
      const x = touch.clientX - rect.left;
      const y = touch.clientY - rect.top;
      const deltaX = x - gesture.startX;
      const deltaY = y - gesture.startY;
      if (!gesture.activated) {
        const intent = resolveGestureIntent({
          deltaX,
          deltaY,
          axis: gesture.axis,
          direction: gesture.direction,
        });
        if (intent === "fail") {
          clearGesture();
          return;
        }
        if (intent === "wait") return;
        gesture.activated = true;
        setDragTarget(gesture.target);
      }
      event.preventDefault();
      const dt = event.timeStamp - gesture.lastTime;
      if (dt > 0) {
        const along = gesture.axis === "horizontal" ? x - gesture.lastX : y - gesture.lastY;
        const instant = (along * gesture.direction) / dt;
        gesture.velocity = gesture.velocity * 0.6 + instant * 0.4;
      }
      gesture.lastX = x;
      gesture.lastY = y;
      gesture.lastTime = event.timeStamp;
      const size = panelSize(gesture.target);
      const along = gesture.axis === "horizontal" ? deltaX : deltaY;
      const progress = Math.min(1, Math.max(0, (along * gesture.direction) / size));
      writeTransform(gesture.target, progress, gesture.mode);
    };

    const onTouchEnd = (event: TouchEvent) => {
      const gesture = gestureRef.current;
      if (!gesture) return;
      if (Array.from(event.changedTouches).every((item) => item.identifier !== gesture.pointerId))
        return;
      if (!gesture.activated) {
        clearGesture();
        return;
      }
      const rect = frame.getBoundingClientRect();
      const touch = Array.from(event.changedTouches).find(
        (item) => item.identifier === gesture.pointerId,
      );
      const x = (touch?.clientX ?? gesture.lastX + rect.left) - rect.left;
      const y = (touch?.clientY ?? gesture.lastY + rect.top) - rect.top;
      const along = gesture.axis === "horizontal" ? x - gesture.startX : y - gesture.startY;
      const size = panelSize(gesture.target);
      const progress = Math.min(1, Math.max(0, (along * gesture.direction) / size));
      const commit = progress >= COMMIT_PROGRESS || gesture.velocity >= COMMIT_VELOCITY;
      finishDrag(commit);
    };

    const onTouchCancel = () => {
      if (gestureRef.current?.activated) finishDrag(false);
      else clearGesture();
    };

    frame.addEventListener("touchstart", onTouchStart, { passive: true });
    frame.addEventListener("touchmove", onTouchMove, { passive: false });
    frame.addEventListener("touchend", onTouchEnd, { passive: true });
    frame.addEventListener("touchcancel", onTouchCancel, { passive: true });
    return () => {
      frame.removeEventListener("touchstart", onTouchStart);
      frame.removeEventListener("touchmove", onTouchMove);
      frame.removeEventListener("touchend", onTouchEnd);
      frame.removeEventListener("touchcancel", onTouchCancel);
    };
  }, [enabled, cancelSettle, clearGesture, finishDrag]);

  // A URL change (Back, a tap, another device) owns the panel: drop any live drag.
  // biome-ignore lint/correctness/useExhaustiveDependencies: openPanel changes must cancel a pending gesture
  useEffect(() => {
    if (gestureRef.current && !gestureRef.current.activated) clearGesture();
  }, [openPanel, clearGesture]);

  useEffect(
    () => () => {
      if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
    },
    [],
  );

  return { frameRef, registerPanel, dragTarget };
}

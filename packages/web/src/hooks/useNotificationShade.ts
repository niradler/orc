import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { notificationsPath } from "@/components/AgentNotifications";

/** Distance from the top of the viewport where the shade gesture may start. */
const TOP_ZONE = 64;
const ACTIVATE_DISTANCE = 12;
const COMMIT_DISTANCE = 90;

/**
 * Phone notification shade: pulling down with two fingers from the top of the
 * screen opens the notifications page, like the system shade. Single-finger
 * scrolls and terminal/chat pinch zoom are untouched — the gesture needs two
 * touches that both start in the top zone and a clear downward intent.
 */
export function useNotificationShade(enabled: boolean) {
  const navigate = useNavigate();
  useEffect(() => {
    if (!enabled) return;
    let startX = 0;
    let startY: number | null = null;
    let active = false;
    let done = false;

    const centroid = (event: TouchEvent) => {
      const a = event.touches[0];
      const b = event.touches[1];
      if (!a || !b) return null;
      return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
    };

    const onTouchStart = (event: TouchEvent) => {
      startY = null;
      active = false;
      done = false;
      if (event.touches.length !== 2) return;
      const a = event.touches[0];
      const b = event.touches[1];
      if (!a || !b || a.clientY > TOP_ZONE || b.clientY > TOP_ZONE) return;
      const target = event.target as Element | null;
      if (
        target?.closest("[data-swipe-ignore], [data-testid='terminal-viewport'], [role='dialog']")
      )
        return;
      startX = (a.clientX + b.clientX) / 2;
      startY = (a.clientY + b.clientY) / 2;
    };

    const onTouchMove = (event: TouchEvent) => {
      if (startY === null || done || event.touches.length !== 2) return;
      const point = centroid(event);
      if (!point) return;
      const dy = point.y - startY;
      const dx = point.x - startX;
      if (!active) {
        if (dy < ACTIVATE_DISTANCE) return;
        // A sideways or upward two-finger move belongs to whatever owns it.
        if (Math.abs(dx) > dy) {
          startY = null;
          return;
        }
        active = true;
      }
      event.preventDefault();
      if (dy >= COMMIT_DISTANCE) {
        done = true;
        navigate(notificationsPath(window.location.search));
      }
    };

    const onTouchEnd = () => {
      startY = null;
      active = false;
    };

    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchmove", onTouchMove, { passive: false });
    document.addEventListener("touchend", onTouchEnd, { passive: true });
    document.addEventListener("touchcancel", onTouchEnd, { passive: true });
    return () => {
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("touchend", onTouchEnd);
      document.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [enabled, navigate]);
}

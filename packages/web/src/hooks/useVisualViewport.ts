import { useEffect, useState } from "react";

/** Mirrors useVisualViewport's compact threshold as reactive state, so callers can
 *  swap collapsed header controls into the actions menu. */
export function useCompactViewport(): boolean {
  const [compact, setCompact] = useState(
    () => (window.visualViewport?.height ?? window.innerHeight) < 320,
  );
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => setCompact(viewport.height < 320);
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, []);
  return compact;
}

export function useVisualViewport(): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement;
    const update = () => {
      const height = viewport.scale === 1 ? viewport.height : window.innerHeight;
      root.style.setProperty("--app-height", `${height}px`);
      root.style.setProperty("--app-top", `${viewport.scale === 1 ? viewport.offsetTop : 0}px`);
      root.dataset.compactViewport = String(height < 320);
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      root.style.removeProperty("--app-height");
      root.style.removeProperty("--app-top");
      delete root.dataset.compactViewport;
    };
  }, []);
}

import { useEffect, useState } from "react";

/**
 * Tailwind-aligned breakpoints (min-width, px).
 */
export const BREAKPOINTS = {
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
} as const;

export type Breakpoint = keyof typeof BREAKPOINTS;

/**
 * SSR-safe matchMedia hook. Returns whether the given query currently matches.
 * During SSR or before hydration it returns `false`.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return false;
    }
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    // Sync on mount in case SSR default drifted from the true value.
    setMatches(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

/**
 * True when viewport is at least as wide as the given Tailwind breakpoint.
 */
export function useBreakpoint(min: Breakpoint): boolean {
  return useMediaQuery(`(min-width: ${BREAKPOINTS[min]}px)`);
}

import { useSyncExternalStore } from "react";

export type Theme = "dark" | "light";
export const THEME_KEY = "orc_theme";
const THEME_EVENT = "orc-theme-change";

export function getTheme(): Theme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  window.dispatchEvent(new Event(THEME_EVENT));
}

export function persistTheme(theme: Theme) {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Appearance still works when browser storage is unavailable.
  }
}

export function setTheme(theme: Theme) {
  persistTheme(theme);
  applyTheme(theme);
}

function subscribe(listener: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === THEME_KEY || event.key === null) {
      applyTheme(event.newValue === "light" ? "light" : "dark");
    }
  };
  window.addEventListener(THEME_EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(THEME_EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, getTheme, () => "dark" as const);
  return { theme, setTheme };
}

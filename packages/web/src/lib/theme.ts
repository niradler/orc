import { useSyncExternalStore } from "react";
import { api } from "../api/client";

export type Theme = "dark" | "light";
export const THEME_KEY = "orc_theme";
const THEME_EVENT = "orc-theme-change";
let saveError = "";

function saveTheme(theme: Theme): void {
  setTheme(theme);
  saveError = "";
  void api.settings
    .save({ theme })
    .then((preferences) => {
      if (preferences.theme) setTheme(preferences.theme);
    })
    .catch(() => {
      saveError = "The theme changed here but could not be saved on the server. Try again.";
      window.dispatchEvent(new Event(THEME_EVENT));
    });
}

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
  const error = useSyncExternalStore(
    subscribe,
    () => saveError,
    () => "",
  );
  return { theme, setTheme: saveTheme, error };
}

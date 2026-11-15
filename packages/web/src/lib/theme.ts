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

export type FontSize = "small" | "default" | "large" | "x-large";
export type UiFont = "system" | "inter" | "geist";
export type ChatFont = "interface" | "system" | "inter" | "geist" | "serif";
export type ChatWidth = "comfortable" | "wide" | "full";
export type DarkBackground = "charcoal" | "black";
export type Appearance = {
  desktop: FontSize;
  phone: FontSize;
  font: UiFont;
  chatFont: ChatFont;
  chatDesktop: FontSize;
  chatPhone: FontSize;
  chatWidth: ChatWidth;
  darkBackground: DarkBackground;
};

export const FONT_SIZE_KEY = "orc_font_size";
const APPEARANCE_KEYS: Record<keyof Appearance, string> = {
  desktop: FONT_SIZE_KEY,
  phone: "orc_font_size_phone",
  font: "orc_font",
  chatFont: "orc_chat_font",
  chatDesktop: "orc_chat_text",
  chatPhone: "orc_chat_text_phone",
  chatWidth: "orc_chat_width",
  darkBackground: "orc_dark_background",
};
const APPEARANCE_EVENT = "orc-appearance-change";
const PHONE_QUERY = "(max-width: 767px)";

export const FONT_SIZES: { value: FontSize; label: string; hint: string }[] = [
  { value: "small", label: "Small", hint: "About 6% smaller." },
  { value: "default", label: "Default", hint: "The standard size." },
  { value: "large", label: "Large", hint: "About 12% larger." },
  { value: "x-large", label: "Extra large", hint: "About 25% larger." },
];
export const UI_FONTS: { value: UiFont; label: string; hint: string }[] = [
  { value: "system", label: "System", hint: "This device's interface font, e.g. SF Pro on macOS." },
  { value: "inter", label: "Inter", hint: "An open sans-serif drawn for screens." },
  { value: "geist", label: "Geist", hint: "An open, geometric sans-serif drawn for screens." },
];
export const CHAT_FONTS: { value: ChatFont; label: string; hint: string }[] = [
  { value: "interface", label: "Same as interface", hint: "Messages use the interface font." },
  { value: "system", label: "System", hint: "This device's interface font, e.g. SF Pro on macOS." },
  { value: "inter", label: "Inter", hint: "An open sans-serif drawn for screens." },
  { value: "geist", label: "Geist", hint: "An open, geometric sans-serif drawn for screens." },
  { value: "serif", label: "Serif", hint: "A book serif, like Claude's chat default." },
];
export const DARK_BACKGROUNDS: { value: DarkBackground; label: string; hint: string }[] = [
  {
    value: "charcoal",
    label: "Charcoal",
    hint: "Soft dark gray; easier on the eyes for long reading.",
  },
  { value: "black", label: "Black", hint: "Pure black, for OLED screens." },
];
export const CHAT_WIDTHS: { value: ChatWidth; label: string; hint: string }[] = [
  { value: "comfortable", label: "Comfortable", hint: "About 75 characters per line." },
  { value: "wide", label: "Wide", hint: "About 100 characters per line." },
  { value: "full", label: "Full", hint: "Uses the whole conversation pane." },
];

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function pick<T extends string>(value: string | null, options: { value: T }[], fallback: T): T {
  return options.find((option) => option.value === value)?.value ?? fallback;
}

function readAppearance(): Appearance {
  return {
    desktop: pick(stored(APPEARANCE_KEYS.desktop), FONT_SIZES, "default"),
    phone: pick(stored(APPEARANCE_KEYS.phone), FONT_SIZES, "default"),
    font: pick(stored(APPEARANCE_KEYS.font), UI_FONTS, "system"),
    chatFont: pick(stored(APPEARANCE_KEYS.chatFont), CHAT_FONTS, "interface"),
    chatDesktop: pick(stored(APPEARANCE_KEYS.chatDesktop), FONT_SIZES, "large"),
    chatPhone: pick(stored(APPEARANCE_KEYS.chatPhone), FONT_SIZES, "default"),
    chatWidth: pick(stored(APPEARANCE_KEYS.chatWidth), CHAT_WIDTHS, "wide"),
    darkBackground: pick(stored(APPEARANCE_KEYS.darkBackground), DARK_BACKGROUNDS, "charcoal"),
  };
}

let snapshot = readAppearance();
window.matchMedia(PHONE_QUERY).addEventListener("change", applyAppearance);

function applyAppearance() {
  snapshot = readAppearance();
  const phone = window.matchMedia(PHONE_QUERY).matches;
  const data = document.documentElement.dataset;
  const size = phone ? snapshot.phone : snapshot.desktop;
  if (size === "default") delete data.fontSize;
  else data.fontSize = size;
  data.font = snapshot.font;
  data.chatFont = snapshot.chatFont;
  data.chatText = phone ? snapshot.chatPhone : snapshot.chatDesktop;
  data.chatWidth = snapshot.chatWidth;
  data.darkBackground = snapshot.darkBackground;
  window.dispatchEvent(new Event(APPEARANCE_EVENT));
}

/** Appearance is a per-device reading preference, saved in this browser only. */
export function setAppearance(patch: Partial<Appearance>) {
  for (const [key, value] of Object.entries(patch)) {
    try {
      localStorage.setItem(APPEARANCE_KEYS[key as keyof Appearance], value);
    } catch {}
  }
  applyAppearance();
}

function subscribeAppearance(listener: () => void) {
  const keys = new Set(Object.values(APPEARANCE_KEYS));
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || keys.has(event.key)) applyAppearance();
  };
  window.addEventListener(APPEARANCE_EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(APPEARANCE_EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useAppearance(): Appearance {
  return useSyncExternalStore(subscribeAppearance, () => snapshot, readAppearance);
}

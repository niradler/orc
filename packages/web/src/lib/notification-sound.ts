import { useSyncExternalStore } from "react";
import {
  DEFAULT_NOTIFICATION_PREFS,
  type NotificationPrefs,
  parseNotificationPrefs,
} from "./agent-notifications";

export const NOTIFICATION_PREFS_KEY = "orc_notification_prefs";
const PREFS_EVENT = "orc-notification-prefs-change";
let cachedRaw: string | null | undefined;
let cached = DEFAULT_NOTIFICATION_PREFS;

export function getNotificationPrefs(): NotificationPrefs {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(NOTIFICATION_PREFS_KEY);
  } catch {}
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cached = parseNotificationPrefs(raw);
  }
  return cached;
}

export function setNotificationPrefs(update: Partial<NotificationPrefs>): void {
  const next = { ...getNotificationPrefs(), ...update };
  try {
    localStorage.setItem(NOTIFICATION_PREFS_KEY, JSON.stringify(next));
  } catch {
    cachedRaw = undefined;
    cached = next;
  }
  window.dispatchEvent(new Event(PREFS_EVENT));
}

function subscribe(listener: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === NOTIFICATION_PREFS_KEY || event.key === null) listener();
  };
  window.addEventListener(PREFS_EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(PREFS_EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useNotificationPrefs(): NotificationPrefs {
  return useSyncExternalStore(subscribe, getNotificationPrefs, () => DEFAULT_NOTIFICATION_PREFS);
}

let context: AudioContext | undefined;
let playingUntil = 0;

/** Browsers only start audio after a gesture, so the context is created on the first one. */
export function unlockNotificationSound(): void {
  if (typeof AudioContext === "undefined") return;
  context ??= new AudioContext();
  void context.resume().catch(() => undefined);
}

/** A short two-note chime synthesized on the fly; bursts within one chime play once. */
export function playNeedsYouSound(volume: number): void {
  if (context?.state !== "running" || volume <= 0) return;
  const start = context.currentTime;
  if (start < playingUntil) return;
  playingUntil = start + 0.45;
  const gain = context.createGain();
  gain.connect(context.destination);
  const peak = 0.25 * Math.min(1, volume);
  for (const [offset, frequency] of [
    [0, 880],
    [0.16, 1318.5],
  ] as const) {
    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = frequency;
    envelope.gain.setValueAtTime(0.0001, start + offset);
    envelope.gain.exponentialRampToValueAtTime(peak, start + offset + 0.015);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.28);
    oscillator.connect(envelope).connect(gain);
    oscillator.start(start + offset);
    oscillator.stop(start + offset + 0.3);
  }
}

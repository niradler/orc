import type { PushSubscriptionInput, PushTopic } from "@orc/core/push";

export type PushSupport = "supported" | "insecure" | "install-required" | "unsupported";

function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function isAppleMobile(): boolean {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent))
  );
}

export function pushSupport(): PushSupport {
  if (!window.isSecureContext) return "insecure";
  if (!("serviceWorker" in navigator)) return "unsupported";
  // iOS only exposes Web Push to apps added to the Home Screen.
  if (!("PushManager" in window))
    return isAppleMobile() && !isStandalone() ? "install-required" : "unsupported";
  if (!("Notification" in window)) return "unsupported";
  return "supported";
}

export function registerServiceWorker(): void {
  if (!window.isSecureContext || !("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js")
      .catch((error: unknown) => console.warn("Service worker registration failed", error));
  });
}

const BROWSERS: [RegExp, string][] = [
  [/Edg\//, "Edge"],
  [/Firefox\//, "Firefox"],
  [/Chrome\//, "Chrome"],
  [/Safari\//, "Safari"],
];
const PLATFORMS: [RegExp, string][] = [
  [/Android/, "Android"],
  [/iPad|iPhone|iPod/, "iOS"],
  [/Windows/, "Windows"],
  [/Mac OS X/, "macOS"],
  [/Linux/, "Linux"],
];

function matchName(patterns: [RegExp, string][], fallback: string): string {
  return patterns.find(([pattern]) => pattern.test(navigator.userAgent))?.[1] ?? fallback;
}

function deviceLabel(): string {
  const platform = isAppleMobile() ? "iOS" : matchName(PLATFORMS, "device");
  return `${matchName(BROWSERS, "Browser")} on ${platform}`;
}

function decodeKey(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "="));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

function encodeKey(buffer: ArrayBuffer | null): string {
  if (!buffer) throw new Error("The browser returned an incomplete push subscription.");
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function toSubscriptionInput(
  subscription: PushSubscription,
  topics?: PushTopic[],
): PushSubscriptionInput {
  return {
    endpoint: subscription.endpoint,
    keys: {
      p256dh: encodeKey(subscription.getKey("p256dh")),
      auth: encodeKey(subscription.getKey("auth")),
    },
    label: deviceLabel(),
    ...(topics ? { topics } : {}),
  };
}

export async function currentPushSubscription(): Promise<PushSubscription | null> {
  if (pushSupport() !== "supported") return null;
  const registration = await navigator.serviceWorker.getRegistration();
  return (await registration?.pushManager.getSubscription()) ?? null;
}

/** Asks for permission and subscribes this browser; a key change replaces the old subscription. */
export async function createPushSubscription(publicKey: string): Promise<PushSubscription> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted")
    throw new Error("Notifications are blocked. Allow them in the browser's site settings.");
  const registration = await navigator.serviceWorker.ready;
  const applicationServerKey = decodeKey(publicKey);
  const existing = await registration.pushManager.getSubscription();
  const sameKey =
    existing?.options.applicationServerKey &&
    encodeKey(existing.options.applicationServerKey) === publicKey;
  if (existing && sameKey) return existing;
  await existing?.unsubscribe();
  return registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
}

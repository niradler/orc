/**
 * Every deployment serves a new set of hashed chunks, so a tab that booted before
 * the deploy (or a service worker that answered a navigation from its cached
 * shell) asks for chunk names the server no longer has. Those import failures are
 * recoverable by reloading once; everything else is a real bug and must stay
 * visible with its actual message and stack instead of a generic error page.
 */
const RELOAD_KEY = "orc_stale_build_reload_at";
const RELOAD_GUARD_MS = 15_000;

const STALE_BUILD_SIGNATURES = [
  "failed to fetch dynamically imported module", // Chromium, Safari
  "error loading dynamically imported module", // Firefox
  "importing a module script failed", // Safari
  "unable to preload css", // Vite's modulepreload helper
];

export interface ErrorDetails {
  name: string;
  message: string;
  stack: string | null;
}

/** Recognizes the browser-specific wording of a chunk that no longer exists. */
export function isStaleBuildError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const lower = message.toLowerCase();
  return STALE_BUILD_SIGNATURES.some((signature) => lower.includes(signature));
}

export function describeError(error: unknown): ErrorDetails {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack ?? null };
  }
  if (typeof error === "string") return { name: "Error", message: error, stack: null };
  try {
    return { name: "Error", message: JSON.stringify(error) ?? String(error), stack: null };
  } catch {
    return { name: "Error", message: String(error), stack: null };
  }
}

/** Message and stack for the panel, without repeating a stack that already starts with it. */
export function errorDisplayText(error: unknown): string {
  const details = describeError(error);
  const header = `${details.name}: ${details.message}`;
  if (!details.stack) return header;
  return details.stack.startsWith(header) ? details.stack : `${header}\n\n${details.stack}`;
}

/** The text behind **Copy details**, so a reported error carries its context. */ export function formatErrorReport(
  error: unknown,
): string {
  const details = describeError(error);
  const lines = [
    `${details.name}: ${details.message}`,
    `URL: ${window.location.href}`,
    `Time: ${new Date().toISOString()}`,
    `Browser: ${navigator.userAgent}`,
  ];
  if (details.stack) lines.push("", details.stack);
  return lines.join("\n");
}

/**
 * Reloads once to pick up the current build. The guard keeps a persistent
 * failure (a broken deploy, an offline server) from looping the reload, and it
 * is deliberately not cleared after boot: the reloaded page fails at the same
 * point, so clearing it would loop forever.
 */
export function reloadForStaleBuild(
  options: {
    reload?: () => void;
    now?: number;
    storage?: Pick<Storage, "getItem" | "setItem"> | null;
  } = {},
): boolean {
  const { reload = () => window.location.reload(), now = Date.now() } = options;
  let storage = options.storage;
  if (storage === undefined) {
    try {
      storage = window.sessionStorage;
    } catch {
      storage = null;
    }
  }
  // Without a working guard a reload loop is worse than the error panel, so
  // storage that cannot even be obtained means no reload attempt at all.
  if (!storage) return false;
  try {
    const last = Number(storage.getItem(RELOAD_KEY) ?? 0);
    if (Number.isFinite(last) && Math.max(0, now - last) < RELOAD_GUARD_MS) return false;
    storage.setItem(RELOAD_KEY, String(now));
  } catch {
    return false;
  }
  reload();
  return true;
}

/**
 * Captures failures that never reach a React boundary: Vite's failed
 * modulepreload, and rejections or script errors thrown outside render. Console
 * output keeps the original error and stack for bug reports.
 */
export function installGlobalErrorHandlers(): void {
  window.addEventListener("vite:preloadError", (event) => {
    const payload = (event as Event & { payload?: unknown }).payload;
    // Never preventDefault: Vite only rethrows the failure when the event is not
    // canceled, and a swallowed failure resolves the lazy import with `undefined`
    // (rendering as "Cannot read properties of undefined (reading 'default')")
    // instead of the message that names the missing chunk.
    console.error("[orc] module preload failed", payload);
    if (isStaleBuildError(payload)) reloadForStaleBuild();
  });

  window.addEventListener("unhandledrejection", (event) => {
    if (!isStaleBuildError(event.reason)) {
      console.error("[orc] unhandled rejection", event.reason);
      return;
    }
    reloadForStaleBuild();
  });

  window.addEventListener("error", (event) => {
    const source = event.filename ? ` (${event.filename}:${event.lineno}:${event.colno})` : "";
    console.error("[orc] uncaught error", event.error ?? event.message, source);
  });
}

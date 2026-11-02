import * as Dialog from "@radix-ui/react-dialog";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { getApiUrl } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  API_ACCESS_CHANGED,
  checkApiAccess,
  endOfDateInput,
  migrateStoredSecret,
  readBrowserSession,
  signIn,
  toDateInput,
  type WorkspacePreferences,
} from "@/lib/api-credentials";
import { TERMINAL_FONT_KEY } from "@/lib/terminal-runtime";
import { setTheme } from "@/lib/theme";

function applyPreferences(preferences: WorkspacePreferences): void {
  if (preferences.theme) setTheme(preferences.theme);
  if (preferences.terminal_font !== undefined) {
    try {
      localStorage.setItem(TERMINAL_FONT_KEY, preferences.terminal_font);
    } catch {
      // Workspace access still works when browser preferences cannot be cached.
    }
  }
}

export function ApiAccessGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<"checking" | "login" | "ready" | "error">("checking");
  const [secret, setSecret] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [connection, setConnection] = useState(() => ({ url: getApiUrl() }));
  const queryClient = useQueryClient();

  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    setState("checking");
    setError("");
    const url = connection.url;
    migrateStoredSecret(url)
      .then(() => checkApiAccess(url, controller.signal))
      .then(async (preferences) => {
        if (controller.signal.aborted) return;
        if (preferences === null) {
          // The 401 already means sign-in is needed; the session read only suggests a date, and
          // without one the server applies its default lifetime.
          const session = await readBrowserSession(url, controller.signal).catch(() => null);
          setValidUntil(session ? toDateInput(session.default_expires_at) : "");
          setState("login");
        } else {
          applyPreferences(preferences);
          setState("ready");
        }
      })
      .catch(() => {
        if (!controller.signal.aborted || !disposed) {
          setError("Could not connect to the ORC API. Try again.");
          setState("error");
        }
      });
    let disposed = false;
    return () => {
      disposed = true;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [connection]);

  useEffect(() => {
    const recheck = () => {
      queryClient.clear();
      setConnection({ url: getApiUrl() });
    };
    window.addEventListener(API_ACCESS_CHANGED, recheck);
    return () => window.removeEventListener(API_ACCESS_CHANGED, recheck);
  }, [queryClient]);

  async function login(): Promise<void> {
    setPending(true);
    setError("");
    try {
      const url = getApiUrl();
      if (!(await signIn(url, secret, validUntil ? endOfDateInput(validUntil) : undefined))) {
        setError("Incorrect API secret. Try again.");
        return;
      }
      const preferences = await checkApiAccess(url);
      if (preferences === null) {
        setError(
          "Signed in, but the browser did not keep the session cookie. Check cookie settings.",
        );
        return;
      }
      setSecret("");
      applyPreferences(preferences);
      queryClient.clear();
      setState("ready");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not sign in. Try again.");
    } finally {
      setPending(false);
    }
  }

  if (state === "ready") return children;
  if (state !== "login")
    return (
      <main className="flex min-h-screen items-center justify-center bg-background text-foreground">
        <div className="space-y-4 p-6">
          {state === "checking" ? (
            <p role="status">Connecting to ORC…</p>
          ) : (
            <>
              <p role="alert">{error}</p>
              <Button
                data-testid="api-access-retry"
                onClick={() => setConnection({ url: getApiUrl() })}
              >
                Retry connection
              </Button>
            </>
          )}
        </div>
      </main>
    );
  return (
    <Dialog.Root open>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/80" />
        <Dialog.Content
          data-testid="api-login"
          className="fixed left-1/2 top-1/2 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 space-y-5 rounded-xl border border-border bg-background p-6 text-foreground shadow-lg"
          onEscapeKeyDown={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
        >
          <div className="space-y-2">
            <Dialog.Title className="text-lg font-medium">Sign in to ORC</Dialog.Title>
            <Dialog.Description className="text-sm text-muted-foreground">
              This server requires an API secret.
            </Dialog.Description>
          </div>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void login();
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="api-login-secret">API secret</Label>
              <Input
                id="api-login-secret"
                data-testid="api-login-secret"
                type="password"
                autoComplete="off"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                required
                disabled={pending}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="api-login-valid-until">Valid until</Label>
              <Input
                id="api-login-valid-until"
                data-testid="api-login-valid-until"
                type="date"
                min={toDateInput(Date.now() / 1000)}
                max={toDateInput(Date.now() / 1000 + 364 * 86_400)}
                value={validUntil}
                onChange={(event) => setValidUntil(event.target.value)}
                disabled={pending}
              />
              <p className="text-xs text-muted-foreground">
                The browser keeps a signed session cookie until then, never the secret.
              </p>
            </div>
            {error && (
              <p role="alert" data-testid="api-login-error" className="text-sm text-error">
                {error}
              </p>
            )}
            <Button
              data-testid="api-login-submit"
              className="w-full"
              type="submit"
              disabled={pending || !secret}
            >
              {pending ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

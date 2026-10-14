import { type APIRequestContext, test as base } from "@playwright/test";
import { API_BASE, AUTH_HEADERS } from "./_helpers";

function createsTerminal(url: string): boolean {
  return /\/api\/terminals\/?$/.test(new URL(url, API_BASE).pathname);
}

// Track only resources created by this test. Keep continuity assertions inside
// the test, then close its shells even when an assertion fails.
export const test = base.extend<{ terminalIds: Set<string>; terminalCleanup: undefined }>({
  terminalIds: async ({ browserName: _browserName }, use) => {
    await use(new Set<string>());
  },
  request: async ({ request, terminalIds }, use) => {
    const tracked = new Proxy(request, {
      get(target, key) {
        if (key === "post") {
          return async (...args: Parameters<APIRequestContext["post"]>) => {
            const response = await target.post(...args);
            if (createsTerminal(args[0]) && response.status() === 201) {
              const terminal = (await response.json()) as { id: string };
              terminalIds.add(terminal.id);
            }
            return response;
          };
        }
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await use(tracked);
  },
  terminalCleanup: [
    async ({ page, request, terminalIds }, use) => {
      const pending: Promise<void>[] = [];
      page.on("response", (response) => {
        if (
          response.request().method() === "POST" &&
          createsTerminal(response.url()) &&
          response.status() === 201
        ) {
          pending.push(
            response.json().then((terminal: { id: string }) => {
              terminalIds.add(terminal.id);
            }),
          );
        }
      });
      await use(undefined);
      const failed: string[] = [];
      const captures = await Promise.allSettled(pending);
      for (const capture of captures) {
        if (capture.status === "rejected")
          failed.push(`Creation tracking: ${String(capture.reason)}`);
      }
      for (const id of terminalIds) {
        try {
          const response = await request.delete(`${API_BASE}/terminals/${encodeURIComponent(id)}`, {
            headers: AUTH_HEADERS,
            timeout: 10_000,
          });
          // The test may already have closed its terminal through the UI.
          if (!response.ok() && response.status() !== 404)
            failed.push(`${id}: ${response.status()}`);
        } catch (error) {
          failed.push(`${id}: ${String(error)}`);
        }
      }
      if (failed.length) throw new Error(`Terminal cleanup failed: ${failed.join(", ")}`);
    },
    { auto: true },
  ],
});

import type { HumanRequest, HumanResponse } from "@orc/core/human-requests";
import type { Page } from "@playwright/test";
import { attentionLive, attentionRequests, attentionWaiting } from "./_attention-fixtures";

export async function attentionState(page: Page, initial = attentionRequests()) {
  let requests = initial;
  const calls: Array<{ id: string; operation: string; body: unknown }> = [];
  let failure: { id: string; operation: string; message: string } | null = null;
  let hold: { id: string; operation: string; ready: Promise<void> } | null = null;
  await page.route("**/api/human-requests", (route) =>
    route.fulfill({
      json: requests.filter((request) =>
        ["pending", "answered", "unavailable"].includes(request.status),
      ),
    }),
  );
  for (const operation of ["respond", "cancel"]) {
    await page.route(`**/api/human-requests/*/${operation}`, async (route) => {
      const id = new URL(route.request().url()).pathname.split("/").at(-2) ?? "";
      const body = route.request().postDataJSON() as { version: number; response?: HumanResponse };
      calls.push({ id, operation, body });
      if (hold?.id === id && hold.operation === operation) {
        const ready = hold.ready;
        hold = null;
        await ready;
      }
      if (failure?.id === id && failure.operation === operation) {
        const message = failure.message;
        failure = null;
        return route.fulfill({ status: 503, json: { error: message } });
      }
      const request = requests.find((request) => request.id === id);
      if (!request || body.version !== request.version)
        return route.fulfill({ status: 409, json: { error: "Request changed" } });
      const changed: HumanRequest = {
        ...request,
        version: request.version + 1,
        status: operation === "cancel" ? "cancelled" : "answered",
        response: body.response ?? null,
        responded_at: Date.now(),
      };
      requests = requests.map((request) => (request.id === id ? changed : request));
      return route.fulfill({ json: changed });
    });
  }
  await page.route("**/api/chat/waiting", (route) =>
    route.fulfill({ json: { waiting: attentionWaiting } }),
  );
  await page.route("**/api/sessions/live?**", (route) =>
    route.fulfill({ json: { sessions: attentionLive } }),
  );
  return {
    calls,
    holdNext(id: string, operation: string) {
      let release = () => {};
      hold = {
        id,
        operation,
        ready: new Promise<void>((resolve) => {
          release = resolve;
        }),
      };
      return () => release();
    },
    failNext(id: string, operation: string, message: string) {
      failure = { id, operation, message };
    },
  };
}

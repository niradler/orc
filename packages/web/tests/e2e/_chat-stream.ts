import type { Page } from "@playwright/test";

// Keep the real first response open after its thread frame, independent of browser speed.
export async function holdChatStream(page: Page): Promise<() => Promise<void>> {
  await page.evaluate(() => {
    const fetch = window.fetch.bind(window);
    let intercept = true;
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    window.addEventListener("orc-test-release-chat-stream", release, { once: true });
    window.fetch = async (...args) => {
      const input = args[0];
      const url = input instanceof Request ? input.url : String(input);
      if (!intercept || !new URL(url, location.href).pathname.endsWith("/chat/stream"))
        return fetch(...args);
      intercept = false;
      const response = await fetch(...args);
      if (!response.ok || !response.body) return response;
      const reader = response.body.getReader();
      let first = true;
      let pending = new Uint8Array();
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (first) {
            while (true) {
              const chunk = await reader.read();
              if (chunk.done) throw new Error("Chat response ended before its first SSE frame");
              const joined = new Uint8Array(pending.length + chunk.value.length);
              joined.set(pending);
              joined.set(chunk.value, pending.length);
              pending = joined;
              const boundary = pending.findIndex(
                (value, index) => value === 10 && pending[index + 1] === 10,
              );
              if (boundary === -1) continue;
              controller.enqueue(pending.slice(0, boundary + 2));
              pending = pending.slice(boundary + 2);
              first = false;
              return;
            }
          }
          await held;
          if (pending.length) {
            controller.enqueue(pending);
            pending = new Uint8Array();
            return;
          }
          const chunk = await reader.read();
          if (chunk.done) controller.close();
          else controller.enqueue(chunk.value);
        },
        async cancel(reason) {
          release();
          await reader.cancel(reason);
        },
      });
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    };
  });
  return async () => {
    await page.evaluate(() => window.dispatchEvent(new Event("orc-test-release-chat-stream")));
  };
}

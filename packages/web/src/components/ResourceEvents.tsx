import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { getApiSecret, getApiUrl } from "@/api/client";
import { API_ACCESS_CHANGED } from "@/lib/api-credentials";
import {
  consumeResourceEvents,
  invalidateResources,
  parseResources,
  refreshQueries,
  setResourceConnection,
} from "@/lib/resource-events";

export function ResourceEvents(): null {
  const client = useQueryClient();
  useEffect(() => {
    const controller = new AbortController();
    setResourceConnection("connecting");
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let activeAttempt: AbortController | undefined;
    let reconnectImmediately = false;
    let attempt = 0;
    const connect = async (): Promise<void> => {
      if (activeAttempt || controller.signal.aborted) return;
      if (!navigator.onLine) {
        setResourceConnection("disconnected");
        return;
      }
      const attemptController = new AbortController();
      activeAttempt = attemptController;
      const abort = (): void => attemptController.abort();
      controller.signal.addEventListener("abort", abort, { once: true });
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      const keepAlive = (): void => {
        clearTimeout(watchdog);
        watchdog = setTimeout(abort, 60_000);
      };
      try {
        keepAlive();
        const secret = getApiSecret();
        const response = await fetch(`${getApiUrl().replace(/\/+$/, "")}/events`, {
          headers: {
            Accept: "text/event-stream",
            ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
          },
          signal: attemptController.signal,
          cache: "no-store",
        });
        if (controller.signal.aborted) {
          await response.body?.cancel();
          return;
        }
        if (response.status === 401) {
          await response.body?.cancel();
          window.dispatchEvent(new Event(API_ACCESS_CHANGED));
          return;
        }
        await consumeResourceEvents(
          response,
          attemptController.signal,
          (event, data) => {
            if (controller.signal.aborted) return;
            if (event === "ready") {
              setResourceConnection("connected");
              attempt = 0;
              void refreshQueries(client);
            } else if (event === "change") void invalidateResources(client, parseResources(data));
          },
          keepAlive,
        );
      } catch (error) {
        if (!controller.signal.aborted) console.warn("ORC update stream disconnected", error);
      } finally {
        clearTimeout(watchdog);
        controller.signal.removeEventListener("abort", abort);
        attemptController.abort();
        activeAttempt = undefined;
      }
      if (!controller.signal.aborted) {
        setResourceConnection("disconnected");
        if (navigator.onLine) {
          const delay = reconnectImmediately
            ? 0
            : Math.min(30_000, 1000 * 2 ** Math.min(attempt++, 5));
          reconnectImmediately = false;
          retryTimer = setTimeout(() => {
            void connect();
          }, delay);
        }
      }
    };
    const offline = (): void => {
      clearTimeout(retryTimer);
      setResourceConnection("disconnected");
      activeAttempt?.abort();
    };
    const online = (): void => {
      clearTimeout(retryTimer);
      if (activeAttempt) {
        reconnectImmediately = true;
        activeAttempt.abort();
      } else void connect();
    };
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    void connect();
    return () => {
      controller.abort();
      clearTimeout(retryTimer);
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
    };
  }, [client]);
  return null;
}

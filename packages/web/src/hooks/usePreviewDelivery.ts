import type { PreviewRequest } from "@orc/core/desktop-preview";
import { useEffect, useRef, useState } from "react";
import { api, apiFetch } from "@/api/client";
import { type PreviewCompletion, PreviewExecutionLedger } from "@/lib/preview-delivery";

export function usePreviewDelivery(
  session: string | null,
  scopeKey: string,
  agentAccess: boolean,
  execute: (request: PreviewRequest) => Promise<PreviewCompletion>,
): string | null {
  const client = useRef(crypto.randomUUID()),
    lease = useRef<string | undefined>(undefined);
  const ledger = useRef(new PreviewExecutionLedger());
  const registrationQueue = useRef(Promise.resolve());
  const latestAccess = useRef(agentAccess);
  latestAccess.current = agentAccess;
  const latestScope = useRef(scopeKey);
  latestScope.current = scopeKey;
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const close = () => {
      if (lease.current)
        void apiFetch(`/desktop-preview/clients/${client.current}/close`, {
          method: "POST",
          headers: { "X-Preview-Lease": lease.current },
          keepalive: true,
        });
    };
    window.addEventListener("pagehide", close);
    return () => window.removeEventListener("pagehide", close);
  }, []);
  useEffect(() => {
    if (!session) return;
    let stopped = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        let activeLease: string | undefined;
        const registration = registrationQueue.current.then(async () => {
          if (stopped) return;
          const clientLease = await api.preview.register(
            client.current,
            session,
            latestAccess.current,
            lease.current,
          );
          lease.current = clientLease.lease;
          activeLease = clientLease.lease;
        });
        registrationQueue.current = registration.then(
          () => {},
          () => {},
        );
        await registration;
        if (stopped || !activeLease) return;
        const pending = await api.preview.pending(client.current, activeLease);
        for (const request of pending.requests) {
          if (stopped || latestScope.current !== scopeKey) break;
          const completion = await ledger.current.run(request.id, () => execute(request));
          await api.preview.ack(
            request.id,
            client.current,
            activeLease,
            completion.status,
            completion.error,
            completion.result,
          );
        }
        if (!stopped) setError(null);
      } catch (cause) {
        if (!stopped)
          setError(cause instanceof Error ? cause.message : "Agent preview delivery unavailable");
      } finally {
        if (!stopped) timer = setTimeout(() => void poll(), 1000);
      }
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [session, scopeKey, execute]);
  return error;
}

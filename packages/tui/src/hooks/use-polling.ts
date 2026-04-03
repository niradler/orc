import { createLogger } from "@orc/core/logger";
import { useCallback, useEffect, useRef, useState } from "react";

const logger = createLogger("tui:polling");

type PollResult<T> = {
  data: T | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
};

export function usePolling<T>(
  fn: () => Promise<{ data: T | null; error: { error: string } | null }>,
  intervalMs = 5000,
): PollResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const fetch = useCallback(async () => {
    try {
      const result = await fnRef.current();
      if (result.data) {
        setData(result.data);
        setError(null);
      } else if (result.error) {
        setError(result.error.error);
        logger.warn("Poll returned error", { error: result.error.error });
      }
    } catch (e) {
      const msg = String(e);
      setError(msg);
      logger.error("Poll threw", { error: msg });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch();
    timerRef.current = setInterval(fetch, intervalMs);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [fetch, intervalMs]);

  return { data, loading, error, refresh: fetch };
}

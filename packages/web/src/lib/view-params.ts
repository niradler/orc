import { useEffect, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

export function withViewParam(
  params: URLSearchParams,
  name: string,
  value: string,
  fallback: string,
): URLSearchParams {
  const next = new URLSearchParams(params);
  if (value === fallback) next.delete(name);
  else next.set(name, value);
  return next;
}

/** Share view identifiers, never draft contents, credentials or executable operations. */
export function useViewParam<T extends string>(
  name: string,
  fallback: T,
  allowed?: readonly T[],
): [T, (value: T, options?: { replace?: boolean }) => void] {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const pending = useRef<string | undefined>(undefined);
  useEffect(() => {
    pending.current = params.toString();
  }, [params]);
  const raw = params.get(name);
  const value = raw !== null && (!allowed || allowed.includes(raw as T)) ? (raw as T) : fallback;
  return [
    value,
    (next, options) => {
      const current = new URLSearchParams(window.location.search);
      const updated = withViewParam(current, name, next, fallback);
      const target = updated.toString();
      if (target === current.toString() || target === pending.current) return;
      pending.current = target;
      navigate(
        { pathname: window.location.pathname, search: target, hash: window.location.hash },
        options,
      );
    },
  ];
}

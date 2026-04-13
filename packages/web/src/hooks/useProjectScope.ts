import { useSearchParams } from "react-router-dom";

/**
 * Resolves the active project scope for a view. URL `?project=` wins for this
 * view only; it never writes back to localStorage. Falls back to the caller's
 * saved scope when the param is absent.
 */
export function useProjectScope(fallbackProjectId: string): string {
  const [searchParams] = useSearchParams();
  const urlProject = searchParams.get("project");
  return urlProject ?? fallbackProjectId;
}

import type { GlobalSearchHit } from "@/api/client";
import { MEMORIES_PATH, memoryPath } from "./memory-routes";

/** Never interpret a result title or ID as a URL. */
export function searchHitPath(hit: GlobalSearchHit): string {
  const id = encodeURIComponent(hit.id);
  switch (hit.kind) {
    case "task":
      return `/tasks/${id}`;
    case "project":
      return `/projects/${id}`;
    case "job":
      return `/jobs/${id}`;
    case "memory":
      // Memory hits are keyed by name, unique only within their project.
      return hit.project_id
        ? memoryPath(hit.project_id, hit.id)
        : `${MEMORIES_PATH}?memoryQuery=${id}`;
    case "session":
      return `/audit/${id}`;
  }
}

export function commandMatches(label: string, keywords: string, query: string): boolean {
  const haystack = `${label} ${keywords}`.toLocaleLowerCase();
  return query
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .every((word) => haystack.includes(word));
}

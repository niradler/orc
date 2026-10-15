import type { GlobalSearchHit } from "@/api/client";

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
      return `/knowledge/memories/${id}`;
    case "session":
      return `/audit/${id}`;
    case "wiki":
      return `/knowledge/wiki?page=${id}${hit.project_id === null ? "&scope=global" : ""}`;
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

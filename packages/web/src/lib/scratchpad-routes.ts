export const SCRATCHPADS_PATH = "/scratchpad";

export function scratchpadPath(id: string): string {
  return `${SCRATCHPADS_PATH}/${encodeURIComponent(id)}`;
}

/** A deep link for anyone with ORC access; an installed ORC serves this UI from its API. */
export function scratchpadShareUrl(id: string): string {
  return new URL(scratchpadPath(id), window.location.origin).toString();
}

export const MEMORIES_PATH = "/knowledge/memories";

/** Path of one memory; identity is (project, name), so both are in the route. */
export function memoryPath(projectId: string, name: string): string {
  return `${MEMORIES_PATH}/${encodeURIComponent(projectId)}/${encodeURIComponent(name)}`;
}

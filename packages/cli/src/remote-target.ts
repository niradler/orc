/** Destination for `orc task move --to`. A URL or host:port, the same target as `ORC_API_BASE`. */
export function resolveRemoteBase(target: string): string {
  const value = target.trim();
  if (/^https?:\/\//i.test(value)) return value.replace(/\/+$/, "").replace(/\/api$/, "");
  const match = /^(\[[^\]]+\]|[^:\s]+):(\d{1,5})$/.exec(value);
  if (match?.[1] && match[2]) {
    const port = Number(match[2]);
    if (port >= 1 && port <= 65535) return `http://${match[1]}:${port}`;
  }
  throw new Error(
    `No connection profile named "${value}". Pass the destination API base, the same value as ORC_API_BASE (https://orc.example.com or 127.0.0.1:7700).`,
  );
}

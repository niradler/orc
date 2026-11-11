export function buildMcpUrl(apiBase: string, project?: string): string {
  const url = new URL(`${apiBase.replace(/\/+$/, "")}/mcp`);
  url.searchParams.set("mode", "meta");
  if (project) url.searchParams.set("project", project);
  return url.toString();
}

export function redact(value: string, secret: string | undefined): string {
  if (!secret) return value;
  return value.split(secret).join("[redacted]");
}

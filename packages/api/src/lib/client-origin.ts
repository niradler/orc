/** Keep the request host; TLS terminators may upgrade its externally visible scheme. */
export function clientOrigin(request: Request): string {
  const url = new URL(request.url);
  if (request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https")
    url.protocol = "https:";
  return url.origin;
}

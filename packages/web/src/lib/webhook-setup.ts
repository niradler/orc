export const DEFAULT_WEBHOOK_EVENTS =
  "pull_request, pull_request_review, pull_request_review_comment";

export function webhookFilters(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

export function webhookUrl(token: string, apiUrl: string, browserOrigin: string): string {
  return new URL(`/webhooks/${encodeURIComponent(token)}`, new URL(apiUrl, browserOrigin)).href;
}

export function isLocalWebhookUrl(value: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(value).hostname);
}

import { cn } from "@/lib/utils";
import { isolatedHtml } from "./sandboxed-html";

/**
 * Inline HTML beside an answer. The sandbox has no `allow-same-origin`, so the
 * frame runs on an opaque origin with no ORC storage, credentials or API access,
 * and the injected CSP blocks every network destination.
 */
export function HtmlBlock({
  html,
  title,
  height = "short",
}: {
  html: string;
  title?: string;
  height?: "short" | "tall";
}) {
  return (
    <iframe
      data-testid="chat-ui-html"
      title={title ?? "Inline HTML content"}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      srcDoc={isolatedHtml(html)}
      className={cn(
        "w-full rounded-md border border-outline-variant bg-white",
        height === "tall" ? "h-[26rem]" : "h-60",
      )}
    />
  );
}

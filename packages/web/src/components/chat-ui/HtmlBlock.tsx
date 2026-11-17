import { withOrcKit } from "@/lib/orc-kit";
import { useAppearance, useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { isolatedHtml } from "./sandboxed-html";

/**
 * Inline HTML beside an answer. The sandbox has no `allow-same-origin`, so the
 * frame runs on an opaque origin with no ORC storage, credentials, API or parent
 * access, and the injected CSP blocks scripted requests (fetch, network images,
 * fonts, forms). The frame can still navigate itself to another URL, so its
 * content is untrusted output, and its scripts run on this page's main thread.
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
  const { theme } = useTheme();
  const { darkBackground } = useAppearance();
  return (
    <iframe
      data-testid="chat-ui-html"
      title={title ?? "Inline HTML content"}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      loading="lazy"
      srcDoc={isolatedHtml(withOrcKit(html, theme, darkBackground))}
      className={cn(
        "w-full rounded-md border border-outline-variant bg-background",
        height === "tall" ? "h-[26rem]" : "h-60",
      )}
    />
  );
}

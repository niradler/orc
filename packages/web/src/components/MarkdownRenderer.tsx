import { code } from "@streamdown/code";
import { mermaid } from "@streamdown/mermaid";
import { ImageIcon } from "lucide-react";
import { type ComponentProps, memo, type ReactNode } from "react";
import { defaultRemarkPlugins, Streamdown } from "streamdown";
import { imageRendering } from "@/lib/markdown-images";
import { useTheme } from "@/lib/theme";
import { remarkWikiLinks, type WikiLinks, wikiLinkKey } from "@/lib/wiki-links";

const plugins = { code, mermaid };

type ElementProps = ComponentProps<"img"> | Record<string, unknown>;

/** Remote images are links, never loads: see imageRendering. */
function MarkdownImage(props: ElementProps) {
  const alt = typeof props.alt === "string" ? props.alt : "";
  const shown = imageRendering(props.src);
  if (shown.kind === "inline") return <img src={shown.src} alt={alt} className="max-w-full" />;
  if (shown.kind === "text") return alt ? <span>[{alt}]</span> : null;
  return (
    <a
      href={shown.href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      referrerPolicy="no-referrer"
      data-testid="markdown-remote-image"
      title={`Remote image, not loaded: ${shown.href}`}
      className="inline-flex items-center gap-1 text-primary underline"
    >
      <ImageIcon size={14} className="shrink-0" />
      {alt || shown.href}
    </a>
  );
}

export const MarkdownRenderer = memo(function MarkdownRenderer({
  children,
  wikiLinks,
  readable = false,
}: {
  children: string;
  wikiLinks?: WikiLinks;
  readable?: boolean;
}) {
  const { theme } = useTheme();
  return (
    <Streamdown
      mode="static"
      plugins={plugins}
      components={{
        img: MarkdownImage,
        ...(wikiLinks
          ? {
              a: (props: ComponentProps<"a"> | Record<string, unknown>) => {
                const href = typeof props.href === "string" ? props.href : undefined;
                const children = props.children as ReactNode;
                if (href?.startsWith("#wiki-")) {
                  const slug = wikiLinks.loose
                    ? wikiLinkKey(decodeURIComponent(href.slice(6)))
                    : href.slice(6);
                  return wikiLinks.slugs.includes(slug) ? (
                    <button
                      type="button"
                      data-testid={`wiki-link-${slug}`}
                      className="text-primary underline"
                      onClick={() => wikiLinks.select(slug)}
                    >
                      {children}
                    </button>
                  ) : (
                    <span>{children}</span>
                  );
                }
                return (
                  <a href={href} target="_blank" rel="noopener noreferrer">
                    {children}
                  </a>
                );
              },
            }
          : {}),
      }}
      {...(wikiLinks
        ? {
            remarkPlugins: [
              ...Object.values(defaultRemarkPlugins),
              [remarkWikiLinks, { loose: Boolean(wikiLinks.loose) }],
            ],
          }
        : {})}
      shikiTheme={["github-light", "github-dark"]}
      mermaid={{ config: { theme: theme === "dark" ? "dark" : "default" } }}
      controls={{
        table: false,
        code: { copy: true, download: false },
        mermaid: {
          copy: true,
          download: false,
          fullscreen: true,
          panZoom: true,
        },
      }}
      className={
        readable
          ? "text-base leading-7 text-on-surface [&_p]:my-4 [&_pre]:max-w-full [&_pre]:overflow-auto [&_pre]:text-sm [&_h1]:text-3xl [&_h2]:text-2xl [&_h3]:text-xl [&_h1]:my-6 [&_h2]:my-5 [&_h3]:my-4 [&_a]:text-primary [&_ul]:my-4 [&_ol]:my-4 [&_img]:max-w-full [&_table]:text-sm"
          : "text-sm leading-relaxed text-on-surface [&_p]:my-2 [&_pre]:max-w-full [&_pre]:overflow-auto [&_pre]:text-xs [&_h1]:text-xl [&_h2]:text-lg [&_h3]:text-base [&_a]:text-primary [&_ul]:my-2 [&_ol]:my-2"
      }
    >
      {children}
    </Streamdown>
  );
});

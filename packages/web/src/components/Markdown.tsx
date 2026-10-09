import { code } from "@streamdown/code";
import { mermaid } from "@streamdown/mermaid";
import { type ComponentProps, memo, type ReactNode } from "react";
import { defaultRemarkPlugins, Streamdown } from "streamdown";
import { remarkWikiLinks } from "@/lib/wiki-links";

const plugins = { code, mermaid };

export const Markdown = memo(function Markdown({
  children,
  wikiLinks,
}: {
  children: string;
  wikiLinks?: { slugs: string[]; select: (slug: string) => void };
}) {
  return (
    <Streamdown
      mode="static"
      plugins={plugins}
      {...(wikiLinks
        ? {
            remarkPlugins: [...Object.values(defaultRemarkPlugins), remarkWikiLinks],
            components: {
              a: (props: ComponentProps<"a"> | Record<string, unknown>) => {
                const href = typeof props.href === "string" ? props.href : undefined;
                const children = props.children as ReactNode;
                if (href?.startsWith("#wiki-")) {
                  const slug = href.slice(6);
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
            },
          }
        : {})}
      shikiTheme={["github-dark", "github-dark"]}
      mermaid={{ config: { theme: "dark" } }}
      controls={{
        table: false,
        code: { copy: true, download: false },
        mermaid: { copy: true, download: false, fullscreen: true, panZoom: true },
      }}
      className="text-xs leading-relaxed text-on-surface [&_p]:my-2 [&_pre]:text-[11px] [&_h1]:text-base [&_h2]:text-sm [&_h3]:text-xs [&_a]:text-primary [&_ul]:my-2 [&_ol]:my-2"
    >
      {children}
    </Streamdown>
  );
});

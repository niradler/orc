import { code } from "@streamdown/code";
import { mermaid } from "@streamdown/mermaid";
import { ImageIcon } from "lucide-react";
import {
  type ComponentProps,
  cloneElement,
  isValidElement,
  memo,
  type ReactElement,
  type ReactNode,
} from "react";
import { defaultRemarkPlugins, Streamdown } from "streamdown";
import { imageRendering } from "@/lib/markdown-images";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
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

/** Links and wiki links look alike: always underlined, since link colour alone matches body text. */
const LINK =
  "text-primary underline decoration-outline underline-offset-2 hover:decoration-current";

type ChildProps = { children?: ReactNode; node?: { tagName?: string } };

/** The item's own text, without nested lists, to name its checkbox. */
function itemText(children: ReactNode): string {
  const parts: string[] = [];
  const walk = (node: ReactNode): boolean => {
    if (typeof node === "string" || typeof node === "number") parts.push(String(node));
    else if (Array.isArray(node)) return node.every(walk);
    else if (isValidElement<ChildProps>(node)) {
      const tag = node.props.node?.tagName;
      if (tag === "ul" || tag === "ol") return false;
      walk(node.props.children);
    }
    return true;
  };
  walk(children);
  return parts.join("").replace(/\s+/g, " ").trim();
}

/** A task item's checkbox is named by the item, so it is not announced as an unlabeled control. */
function MarkdownListItem({
  children,
  className,
  node: _node,
  ...props
}: ComponentProps<"li"> & { node?: unknown }) {
  const task = typeof className === "string" && className.includes("task-list-item");
  const label = task ? itemText(children) : "";
  return (
    <li className={cn("py-1 [&>p]:inline", className)} data-streamdown="list-item" {...props}>
      {task
        ? (Array.isArray(children) ? children : [children]).map((child, index) =>
            isValidElement(child) && child.type === "input"
              ? cloneElement(child as ReactElement<ComponentProps<"input">>, {
                  // biome-ignore lint/suspicious/noArrayIndexKey: markdown children are static
                  key: index,
                  "aria-label": label || "Task",
                })
              : child,
          )
        : children}
    </li>
  );
}

/** Shared by both densities: underlined links, and task items show a checkbox instead of a bullet. */
const PROSE =
  "[&_a]:text-primary [&_a]:underline [&_a]:decoration-outline [&_a]:underline-offset-2 [&_a:hover]:decoration-current [&_.contains-task-list]:list-none [&_.contains-task-list]:pl-0 [&_li_.contains-task-list]:pl-6 [&_.task-list-item>input]:mr-2 [&_.task-list-item>input]:align-middle";

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
        li: MarkdownListItem,
        ...(wikiLinks
          ? {
              a: (props: ComponentProps<"a"> | Record<string, unknown>) => {
                const href = typeof props.href === "string" ? props.href : undefined;
                const children = props.children as ReactNode;
                if (href?.startsWith("#wiki-")) {
                  const slug = wikiLinkKey(decodeURIComponent(href.slice(6)));
                  return wikiLinks.slugs.includes(slug) ? (
                    <button
                      type="button"
                      data-testid={`wiki-link-${slug}`}
                      className={LINK}
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
            remarkPlugins: [...Object.values(defaultRemarkPlugins), remarkWikiLinks],
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
      className={cn(
        PROSE,
        readable
          ? // A document page's own title is larger than any content heading. Headings sit
            // closer to the section they open than to the one before; lists stay compact.
            // Streamdown spaces its blocks with space-y, whose sibling selector outranks plain
            // descendant rules, so block spacing here is marked important.
            "text-base leading-[1.65] text-on-surface *:my-4! [&_pre]:max-w-full [&_pre]:overflow-auto [&_pre]:text-sm [&_:is(h1,h2,h3,h4,h5,h6)]:mb-2! [&_:is(h1,h2,h3,h4,h5,h6)]:font-medium [&_:is(h1,h2,h3,h4,h5,h6)]:leading-snug [&_h1]:mt-10! [&_h1]:text-2xl [&_h2]:mt-8! [&_h2]:text-xl [&_h3]:mt-6! [&_h3]:text-lg [&_:is(h4,h5,h6)]:mt-5! [&_:is(h4,h5,h6)]:text-base [&>:is(ul,ol)]:my-3! [&_:is(ul,ol)]:list-outside [&_:is(ul,ol)]:pl-6 [&_li]:py-0.5 [&_li>:is(ul,ol)]:my-1 [&_img]:max-w-full [&_table]:text-sm [&>*:first-child]:mt-0! [&>*:last-child]:mb-0!"
          : "text-sm leading-relaxed text-on-surface [&_p]:my-2 [&_pre]:max-w-full [&_pre]:overflow-auto [&_pre]:text-xs [&_h1]:text-xl [&_h2]:text-lg [&_h3]:text-base [&_ul]:my-2 [&_ol]:my-2",
      )}
    >
      {children}
    </Streamdown>
  );
});

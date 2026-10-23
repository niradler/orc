import { lazy, memo, type ReactNode, Suspense } from "react";
import type { WikiLinks } from "@/lib/wiki-links";

const Renderer = lazy(() =>
  import("@/components/MarkdownRenderer").then((module) => ({ default: module.MarkdownRenderer })),
);

export const Markdown = memo(function Markdown(props: {
  children: string;
  wikiLinks?: WikiLinks;
  readable?: boolean;
  fallback?: ReactNode;
}) {
  const { fallback, ...rendererProps } = props;
  return (
    <Suspense
      fallback={
        fallback ?? (
          <div role="status" className="text-sm text-outline">
            Loading document…
          </div>
        )
      }
    >
      <Renderer {...rendererProps} />
    </Suspense>
  );
});

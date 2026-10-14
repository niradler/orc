import { lazy, memo, Suspense } from "react";

const Renderer = lazy(() =>
  import("@/components/MarkdownRenderer").then((module) => ({ default: module.MarkdownRenderer })),
);

export const Markdown = memo(function Markdown(props: {
  children: string;
  wikiLinks?: { slugs: string[]; select: (slug: string) => void };
  readable?: boolean;
}) {
  return (
    <Suspense
      fallback={
        <div role="status" className="text-sm text-outline">
          Loading document…
        </div>
      }
    >
      <Renderer {...props} />
    </Suspense>
  );
});

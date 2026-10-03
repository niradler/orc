import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "@/api/client";
import { diffLines } from "@/lib/git-diff";

export function FileDiffCard({
  terminalId,
  path,
  original,
  staged,
  open,
  focused,
  toggle,
}: {
  terminalId: string;
  path: string;
  original: string | null;
  staged: boolean;
  open: boolean;
  focused: boolean;
  toggle: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => setVisible(entries.some((entry) => entry.isIntersecting)),
      { rootMargin: "300px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "nearest" });
  }, [focused]);
  const diff = useQuery({
    queryKey: ["git", terminalId, "diff", staged, path],
    queryFn: () => api.git.diff(terminalId, staged, path),
    enabled: open && (visible || focused),
    refetchInterval: 5_000,
  });
  const lines = diff.data?.diff ? diffLines(diff.data.diff) : [];
  const additions = lines.filter((line) => line.kind === "add").length;
  const removals = lines.filter((line) => line.kind === "remove").length;
  return (
    <section
      ref={ref}
      data-testid="git-diff-file"
      data-path={path}
      className="rounded border border-surface-highest overflow-hidden"
    >
      <button
        type="button"
        data-testid="git-diff-file-toggle"
        aria-expanded={open}
        onClick={toggle}
        className="w-full flex items-center gap-2 text-left bg-surface-highest/50 p-3 hover:bg-surface-highest"
      >
        {open ? (
          <ChevronDown size={16} className="shrink-0" />
        ) : (
          <ChevronRight size={16} className="shrink-0" />
        )}
        <span className="flex-1 min-w-0 break-all font-mono text-xs">
          {original ? `${original} → ` : ""}
          {path}
        </span>
        {diff.data && (
          <span className="shrink-0 text-xs">
            <span className="text-green-400">+{additions}</span>{" "}
            <span className="text-red-400">−{removals}</span>
          </span>
        )}
      </button>
      {open && (
        <>
          {diff.error && (
            <p role="alert" className="p-3">
              {diff.error.message}
            </p>
          )}
          <div data-testid="git-diff" className="overflow-auto font-mono text-xs">
            {diff.isPending ? (
              <p className="p-3 text-outline">Loading diff…</p>
            ) : !lines.length ? (
              <p className="p-3 text-outline">No text changes in this view.</p>
            ) : (
              lines.map((line) => (
                <div
                  key={line.id}
                  data-testid={`git-diff-${line.kind}`}
                  className={`flex min-w-max whitespace-pre ${line.kind === "add" ? "bg-green-500/10 text-green-400" : line.kind === "remove" ? "bg-red-500/10 text-red-400" : line.kind === "hunk" ? "bg-blue-500/10 text-blue-400" : line.kind === "meta" ? "text-outline" : ""}`}
                >
                  <span className="w-10 shrink-0 text-right pr-2 select-none opacity-60">
                    {line.old}
                  </span>
                  <span className="w-10 shrink-0 text-right pr-2 select-none opacity-60">
                    {line.next}
                  </span>
                  <span className="pr-3">{line.text || " "}</span>
                </div>
              ))
            )}
          </div>
          {diff.data?.truncated && <p className="p-2 text-outline">Diff truncated at 200 KB.</p>}
        </>
      )}
    </section>
  );
}

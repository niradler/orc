import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, type GitStatus } from "@/api/client";
import { diffLines } from "@/lib/git-diff";
import { fileChangeState } from "@/lib/git-status";

function DiffSection({
  terminalId,
  path,
  staged,
}: {
  terminalId: string;
  path: string;
  staged: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
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
  const diff = useQuery({
    queryKey: ["git", terminalId, "diff", staged, path],
    queryFn: () => api.git.diff(terminalId, staged, path),
    enabled: visible,
    refetchInterval: 5_000,
  });
  const lines = diff.data?.diff ? diffLines(diff.data.diff) : [];
  return (
    <div
      ref={ref}
      data-testid={staged ? "git-diff-staged-section" : "git-diff-working-section"}
      className="border-t border-surface-highest"
    >
      <div className="flex justify-between p-2 text-xs text-outline">
        <span>{staged ? "Staged" : "Unstaged"}</span>
        {diff.data && (
          <span>
            <span className="text-green-400">
              +{lines.filter((line) => line.kind === "add").length}
            </span>{" "}
            <span className="text-red-400">
              −{lines.filter((line) => line.kind === "remove").length}
            </span>
          </span>
        )}
      </div>
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
    </div>
  );
}

export function FileDiffCard({
  terminalId,
  file,
  open,
  checked,
  select,
  toggle,
}: {
  terminalId: string;
  file: GitStatus["files"][number];
  open: boolean;
  checked: boolean;
  select: (checked: boolean) => void;
  toggle: () => void;
}) {
  const { staged, working, conflict, label } = fileChangeState(file);
  return (
    <section
      data-testid="git-diff-file"
      data-path={file.path}
      className="rounded border border-surface-highest overflow-hidden"
    >
      <div data-testid="git-status-file" className="flex items-center bg-surface-highest/50 px-2">
        <input
          type="checkbox"
          aria-label={`Select ${file.path}`}
          checked={checked}
          onChange={(event) => select(event.target.checked)}
          className="shrink-0"
        />
        <button
          type="button"
          data-testid="git-diff-file-toggle"
          aria-expanded={open}
          onClick={toggle}
          className="flex-1 min-w-0 flex items-center gap-2 text-left p-3 hover:bg-surface-highest"
        >
          {open ? (
            <ChevronDown size={16} className="shrink-0" />
          ) : (
            <ChevronRight size={16} className="shrink-0" />
          )}
          <span className="flex-1 min-w-0 break-all font-mono text-xs">
            {file.original ? `${file.original} → ` : ""}
            {file.path}
          </span>
          <span data-testid="git-file-status" className="shrink-0 text-xs text-outline text-right">
            {label}
            <br />
            {conflict
              ? "Resolve then stage"
              : staged
                ? working
                  ? "Staged + Unstaged"
                  : "Staged"
                : "Unstaged"}
          </span>
        </button>
      </div>
      {open && (
        <>
          {staged && <DiffSection terminalId={terminalId} path={file.path} staged />}
          {working && <DiffSection terminalId={terminalId} path={file.path} staged={false} />}
        </>
      )}
    </section>
  );
}

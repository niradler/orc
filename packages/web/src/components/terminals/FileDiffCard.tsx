import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, type GitStatus } from "@/api/client";
import { diffLines, pairDiffLines } from "@/lib/git-diff";
import { fileChangeState } from "@/lib/git-status";

function DiffSection({
  terminalId,
  path,
  staged,
  sideBySide,
}: {
  terminalId: string;
  path: string;
  staged: boolean;
  sideBySide: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const client = useQueryClient();
  const queryKey = ["git", terminalId, "diff", staged, path] as const;
  const [visible, setVisible] = useState(() => client.getQueryData(queryKey) !== undefined);
  useEffect(() => {
    if (visible) return;
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setVisible(true);
      },
      { rootMargin: "300px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [visible]);
  const diff = useQuery({
    queryKey,
    queryFn: () => api.git.diff(terminalId, staged, path),
    enabled: visible,
  });
  const lines = diff.data?.diff
    ? diffLines(diff.data.diff).filter((line) => line.kind !== "meta")
    : [];
  return (
    <div
      ref={ref}
      data-testid={staged ? "git-diff-staged-section" : "git-diff-working-section"}
      className="border-t border-surface-highest"
    >
      <div className="flex justify-between p-2 text-xs text-on-surface-variant">
        <span>{staged ? "Staged" : "Unstaged"}</span>
        {diff.data && (
          <span>
            <span className="text-secondary">
              +{lines.filter((line) => line.kind === "add").length}
            </span>{" "}
            <span className="text-error">
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
          <p className="p-3 text-on-surface-variant">Loading diff…</p>
        ) : !lines.length ? (
          <p className="p-3 text-on-surface-variant">No text changes in this view.</p>
        ) : sideBySide ? (
          <div data-testid="git-diff-side-by-side" className="min-w-[640px]">
            <div className="grid grid-cols-2 border-b border-outline-variant text-on-surface-variant">
              <span className="px-3 py-1">Before</span>
              <span className="border-l border-outline-variant px-3 py-1">After</span>
            </div>
            {pairDiffLines(lines).map((pair) =>
              pair.full ? (
                <div
                  key={pair.id}
                  className="whitespace-pre bg-surface px-3 text-on-surface-variant"
                >
                  {pair.full.text || " "}
                </div>
              ) : (
                <div key={pair.id} className="grid grid-cols-2">
                  {(["left", "right"] as const).map((side) => {
                    const line = pair[side];
                    return (
                      <div
                        key={side}
                        data-testid={line ? `git-diff-${line.kind}` : "git-diff-empty"}
                        className={`flex min-w-0 whitespace-pre ${side === "right" ? "border-l border-outline-variant" : ""} ${line?.kind === "remove" ? "bg-error/10 text-error" : line?.kind === "add" ? "bg-secondary/10 text-secondary" : ""}`}
                      >
                        <span className="w-12 shrink-0 pr-2 text-right select-none text-on-surface-variant">
                          {side === "left" ? line?.old : line?.next}
                        </span>
                        <span className="min-w-0 flex-1 whitespace-pre-wrap break-all pr-3">
                          {line?.text.slice(1) || " "}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ),
            )}
          </div>
        ) : (
          lines.map((line) => (
            <div
              key={line.id}
              data-testid={`git-diff-${line.kind}`}
              className={`flex min-w-max whitespace-pre ${line.kind === "add" ? "bg-secondary/10 text-secondary" : line.kind === "remove" ? "bg-error/10 text-error" : line.kind === "hunk" ? "bg-surface text-on-surface-variant" : line.kind === "meta" ? "text-on-surface-variant" : ""}`}
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
      {diff.data?.truncated && (
        <p className="p-2 text-on-surface-variant">Diff truncated at 200 KB.</p>
      )}
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
  sideBySide = false,
  openFile,
}: {
  terminalId: string;
  file: GitStatus["files"][number];
  open: boolean;
  checked: boolean;
  select: (checked: boolean) => void;
  toggle: () => void;
  sideBySide?: boolean;
  openFile?: ((path: string) => void) | undefined;
}) {
  const { staged, working, conflict, label } = fileChangeState(file);
  return (
    <section
      data-testid="git-diff-file"
      data-path={file.path}
      className="border-t border-outline-variant overflow-hidden"
    >
      <div data-testid="git-status-file" className="flex items-center px-2">
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
          className="flex-1 min-w-0 min-h-11 sm:min-h-9 flex items-center gap-2 text-left px-2 py-2 hover:bg-surface"
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
          <span
            data-testid="git-file-status"
            className="shrink-0 text-xs text-on-surface-variant text-right"
          >
            {label}
            {" · "}
            {conflict
              ? "Resolve then stage"
              : staged
                ? working
                  ? "Staged + Unstaged"
                  : "Staged"
                : "Unstaged"}
          </span>
        </button>
        {openFile && (
          <button
            type="button"
            data-testid="git-open-file"
            onClick={() => openFile(file.path)}
            className="shrink-0 min-h-11 px-2 text-xs text-primary hover:bg-surface"
            title={`Open ${file.path} in Files`}
          >
            Open file
          </button>
        )}
      </div>
      {open && (
        <>
          {staged && (
            <DiffSection terminalId={terminalId} path={file.path} staged sideBySide={sideBySide} />
          )}
          {working && (
            <DiffSection
              terminalId={terminalId}
              path={file.path}
              staged={false}
              sideBySide={sideBySide}
            />
          )}
        </>
      )}
    </section>
  );
}

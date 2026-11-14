import type { GithubItem } from "@/api/client";
import { cn } from "@/lib/utils";

type Ci = NonNullable<GithubItem["ci"]>;

const LABELS: Record<Ci["state"], string> = {
  success: "Checks passing",
  failure: "Checks failing",
  pending: "Checks running",
  none: "No checks",
};

const TONES: Record<Ci["state"], string> = {
  success: "text-secondary",
  failure: "text-error",
  pending: "text-progress",
  none: "text-muted-foreground",
};

/** The branch's pull-request CI state, linked to GitHub's checks when it is a
 *  github.com URL. Shared by the inspector Overview, Changes and PR review. */
export function CiStatus({ ci, className }: { ci: Ci; className?: string }) {
  const label = (
    <>
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {LABELS[ci.state]}
      {ci.total > 0 && <span className="text-muted-foreground"> · {ci.total}</span>}
    </>
  );
  const classes = cn("inline-flex items-center gap-1.5 text-xs", TONES[ci.state], className);
  if (!/^https:\/\/github\.com\//.test(ci.url)) return <span className={classes}>{label}</span>;
  return (
    <a
      href={ci.url}
      target="_blank"
      rel="noopener noreferrer"
      title={`${ci.total} checks/statuses on the pull request's current commit`}
      className={cn(classes, "hover:underline")}
    >
      {label}
    </a>
  );
}

export const prStateLabel = (state: string) =>
  state === "open" ? "Open" : state === "merged" ? "Merged" : state === "closed" ? "Closed" : state;

export const prStateTone = (state: string) =>
  state === "open"
    ? "text-secondary"
    : state === "merged"
      ? "text-progress"
      : "text-muted-foreground";

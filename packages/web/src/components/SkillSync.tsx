import type { SkillSyncInput } from "@orc/sdk/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function SkillSync({ name }: { name: string }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const origin = useQuery({
    queryKey: ["skill-origin", name],
    queryFn: () => api.skills.origin(name),
  });
  const sync = useMutation({
    mutationFn: (input: SkillSyncInput) => api.skills.sync(name, input),
    onSuccess: async (result) => {
      setConfirming(false);
      if (result.applied) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["skill", name] }),
          queryClient.invalidateQueries({ queryKey: ["skills"] }),
          queryClient.invalidateQueries({ queryKey: ["skill-origin", name] }),
        ]);
      }
    },
  });
  if (origin.error)
    return (
      <p role="alert" className="text-sm text-destructive">
        {origin.error.message}
      </p>
    );
  if (!origin.data) return null;
  const result = sync.data;
  const conflict = result && !result.applied && result.conflicts.length > 0;
  return (
    <div className="space-y-2 mb-4">
      <p className="text-xs text-outline">
        Imported from{" "}
        <a
          className="text-primary underline"
          href={`https://github.com/${origin.data.repository}/tree/${encodeURIComponent(origin.data.ref === "HEAD" ? origin.data.commit : origin.data.ref)}/${origin.data.path}`}
          target="_blank"
          rel="noreferrer"
        >
          {origin.data.repository}
        </a>{" "}
        · {origin.data.commit.slice(0, 8)}
      </p>
      <Button
        data-testid="skill-sync"
        variant="outline"
        size="sm"
        disabled={sync.isPending}
        onClick={() => sync.mutate({})}
      >
        {sync.isPending ? "Syncing…" : "Sync from GitHub"}
      </Button>
      {result?.applied && (
        <p role="status" data-testid="skill-sync-status" className="text-xs">
          {result.changed.length
            ? `Synced ${result.changed.length} files. Local edits preserved outside confirmed conflicts.`
            : "Up to date. Local edits preserved."}
        </p>
      )}
      {conflict && (
        <div data-testid="skill-sync-conflicts" className="space-y-2">
          <p role="alert" className="text-sm">
            Sync paused. Both you and GitHub changed these files:
          </p>
          <ul className="text-xs space-y-1">
            {result.conflicts.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
          <Button
            data-testid="skill-sync-review-override"
            variant="outline"
            size="sm"
            onClick={() => setConfirming(true)}
          >
            Review override
          </Button>
        </div>
      )}
      {sync.error && (
        <p role="alert" className="text-sm text-destructive">
          {sync.error.message}
        </p>
      )}
      <Dialog open={confirming} onOpenChange={(open) => !sync.isPending && setConfirming(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Replace conflicting local edits?</DialogTitle>
          </DialogHeader>
          <p className="text-sm">
            GitHub's version at {result?.commit.slice(0, 8)} will replace or remove these files.
            Your other local edits will be kept. The current skill folder will be backed up.
          </p>
          <ul className="text-sm space-y-1">
            {result?.conflicts.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
          <DialogFooter>
            <Button variant="ghost" disabled={sync.isPending} onClick={() => setConfirming(false)}>
              Keep local edits
            </Button>
            <Button
              data-testid="skill-sync-confirm-override"
              disabled={sync.isPending}
              onClick={() =>
                result &&
                sync.mutate({
                  override: true,
                  expectedCommit: result.commit,
                  expectedRevision: result.revision,
                })
              }
            >
              {sync.isPending ? "Syncing…" : "Replace listed files"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

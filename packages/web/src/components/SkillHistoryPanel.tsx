import type { ScopeQuery, SkillMeta } from "@orc/sdk/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { diffLines } from "diff";
import { useState } from "react";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function SkillHistoryPanel({
  name,
  scope,
  mutation,
}: {
  name: string;
  scope: ScopeQuery;
  mutation?: SkillMeta["mutation"];
}) {
  const cache = useQueryClient();
  const [reason, setReason] = useState("");
  const history = useQuery({
    queryKey: ["skill-history", name, scope],
    queryFn: () => api.skills.history(name, scope),
  });
  const revert = useMutation({
    mutationFn: (changeId: string) => {
      if (!mutation) throw new Error("No active instruction edit");
      return api.skills.revert(name, {
        project_id: mutation.project_id,
        change_id: changeId,
        expected_change_id: mutation.id,
        reason: reason.trim(),
      });
    },
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: ["skill"] });
      void cache.invalidateQueries({ queryKey: ["skills"] });
      void cache.invalidateQueries({ queryKey: ["skill-history"] });
      setReason("");
    },
  });
  if (!history.data?.changes.length && !history.error) return null;
  return (
    <section data-testid="skill-history-panel" className="mb-5 space-y-3">
      {mutation && (
        <p data-testid="skill-mutated-label" className="text-xs text-primary">
          Mutated · {mutation.project_id ? "Project" : "Global"} ·{" "}
          {new Date(mutation.updated_at * 1000).toLocaleString()} · {mutation.author}
        </p>
      )}
      <h3 className="text-sm font-medium">Instruction history</h3>
      <Input
        data-testid="skill-revert-reason"
        aria-label="Reason for reverting instructions"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="Reason for reverting..."
      />
      {history.error && <p role="alert">{(history.error as Error).message}</p>}
      {revert.error && <p role="alert">{(revert.error as Error).message}</p>}
      {history.data?.changes.map((change) => (
        <details
          key={change.id}
          data-testid="skill-history-change"
          className="border-b border-outline-variant p-3"
        >
          <summary className="text-xs cursor-pointer">
            {change.action} · {change.reason} · {change.author} ·{" "}
            <time dateTime={new Date(change.created_at * 1000).toISOString()}>
              {new Date(change.created_at * 1000).toLocaleString()}
            </time>
          </summary>
          <SkillChangeContent before={change.previous_raw} after={change.raw} />
          <Button
            data-testid="skill-revert-change"
            size="sm"
            variant="outline"
            disabled={!reason.trim() || revert.isPending}
            onClick={() => revert.mutate(change.id)}
          >
            Restore instructions before this change
          </Button>
        </details>
      ))}
    </section>
  );
}

function SkillChangeContent({ before, after }: { before: string; after: string }) {
  const [showFull, setShowFull] = useState(false);
  const changes = diffLines(before, after).filter((part) => part.added || part.removed);
  return (
    <div className="my-3 space-y-2">
      <pre data-testid="skill-change-diff" className="text-xs whitespace-pre-wrap break-all">
        {changes.length === 0
          ? "No instruction changes"
          : changes.map((part) => (
              <span
                key={`${changes.indexOf(part)}-${part.added ? "added" : "removed"}`}
                className={
                  part.added
                    ? "text-green-600 dark:text-green-400"
                    : "text-red-600 dark:text-red-400"
                }
              >
                {part.value
                  .split(/(?<=\n)/)
                  .filter(Boolean)
                  .map((line) => `${part.added ? "+ " : "- "}${line}`)
                  .join("")}
                {!part.value.endsWith("\n") && "\n"}
              </span>
            ))}
      </pre>
      <Button type="button" size="sm" variant="outline" onClick={() => setShowFull(!showFull)}>
        {showFull ? "Hide full skill" : "Show full skill"}
      </Button>
      {showFull && (
        <div data-testid="skill-change-full">
          <p className="text-xs text-outline mt-2">Before</p>
          <pre className="text-xs whitespace-pre-wrap break-all">{before}</pre>
          <p className="text-xs text-outline mt-2">After</p>
          <pre className="text-xs whitespace-pre-wrap break-all">{after}</pre>
        </div>
      )}
    </div>
  );
}

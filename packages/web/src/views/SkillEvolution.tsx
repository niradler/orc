import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function SkillEvolution({ projectId }: { projectId?: string }) {
  const [reason, setReason] = useState("");
  const client = useQueryClient();
  const history = useQuery({
    queryKey: ["skill-evolution", projectId],
    queryFn: () => api.evolution.history(projectId),
    refetchInterval: 30000,
  });
  const proposals = useQuery({
    queryKey: ["skill-proposals", projectId],
    queryFn: () => api.evolution.proposals(projectId),
    refetchInterval: 30000,
  });
  const revert = useMutation({
    mutationFn: (id: string) => api.evolution.revert(id, projectId ?? null, reason),
    onSuccess: async () => {
      setReason("");
      await Promise.all([
        client.invalidateQueries({ queryKey: ["skill-evolution"] }),
        client.invalidateQueries({ queryKey: ["skill-proposals"] }),
        client.invalidateQueries({ queryKey: ["skill"] }),
      ]);
    },
  });
  return (
    <details
      data-testid="skill-evolution-history"
      className="my-6 border border-surface-highest p-4"
    >
      <summary>Automatic skill changes and evaluation history</summary>
      <p className="text-sm text-outline my-3">
        Validated changes activate automatically. Review before/after versions here and revert the
        current change with a reason.
      </p>
      {(history.error || proposals.error || revert.error) && (
        <p role="alert">
          {history.error?.message ?? proposals.error?.message ?? revert.error?.message}
        </p>
      )}
      <Input
        data-testid="skill-revert-reason"
        aria-label="Reason for reverting a skill change"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="Reason for reverting"
      />
      {!history.data?.history.length && (
        <p className="text-sm my-3">No automatic changes for this project.</p>
      )}
      {history.data?.history.map((activation) => (
        <article
          key={activation.id}
          data-testid="skill-activation"
          className="border border-surface-highest p-3 my-3"
        >
          <h3>
            {activation.skill_name} · {activation.action} ·{" "}
            {activation.active ? "current" : "historical"}
          </h3>
          <p>{activation.reason}</p>
          <p className="text-xs text-outline">
            {new Date(activation.created_at * 1000).toLocaleString()} · evaluation{" "}
            {activation.evaluation_id ?? "human revert"}
          </p>
          <details>
            <summary>Before and after</summary>
            <div className="grid md:grid-cols-2 gap-3">
              <div>
                <h4>Before</h4>
                <pre className="whitespace-pre-wrap text-xs">{activation.previous_raw}</pre>
              </div>
              <div>
                <h4>After</h4>
                <pre className="whitespace-pre-wrap text-xs">{activation.raw}</pre>
              </div>
            </div>
          </details>
          {Boolean(activation.active) && activation.action === "promote" && (
            <Button
              data-testid="skill-revert-button"
              disabled={!reason.trim() || revert.isPending}
              onClick={() => revert.mutate(activation.id)}
            >
              Revert this change
            </Button>
          )}
        </article>
      ))}
      {proposals.data?.proposals.map((proposal) => (
        <details key={proposal.id} className="my-3">
          <summary>
            {proposal.skill_name} · {proposal.status}
          </summary>
          <p>{proposal.decision}</p>
          <pre className="whitespace-pre-wrap text-xs">{proposal.payload}</pre>
          {proposals.data.evaluations
            .filter((evaluation) => evaluation.proposal_id === proposal.id)
            .map((evaluation) => (
              <div key={evaluation.id}>
                <p>{evaluation.result}</p>
                <pre className="whitespace-pre-wrap text-xs">{evaluation.payload}</pre>
              </div>
            ))}
        </details>
      ))}
    </details>
  );
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function RulesPanel() {
  const client = useQueryClient();
  const state = useQuery({ queryKey: ["rules"], queryFn: () => api.rules.list(), retry: false });
  const [workspace, setWorkspace] = useState("");
  const [reason, setReason] = useState("");
  const [denyDelete, setDenyDelete] = useState(true);
  const [denyComments, setDenyComments] = useState(false);
  const [message, setMessage] = useState("");
  const save = useMutation({
    mutationFn: () => {
      const current = state.data?.history.find(
        (r) => r.current && r.workspace.toLowerCase() === workspace.trim().toLowerCase(),
      );
      const rules = [
        ...(current?.policy?.rules.filter(
          (r) => r.id !== "prevent-deletion" && r.id !== "prevent-comments",
        ) ?? []),
        ...(denyDelete
          ? [
              {
                id: "prevent-deletion",
                kind: "deny_delete" as const,
                reason: "Prevent file deletion and unmediated execution",
              },
            ]
          : []),
        ...(denyComments
          ? [
              {
                id: "prevent-comments",
                kind: "deny_comments" as const,
                reason: "Prevent new JavaScript/TypeScript comments",
              },
            ]
          : []),
      ];
      return api.rules.activate(
        { workspace: workspace.trim(), project_id: current?.project_id ?? null, rules },
        current?.id ?? null,
        reason,
      );
    },
    onSuccess: () => {
      setMessage(
        "Policy saved. Enforcement follows the server rules setting and installed adapters.",
      );
      void client.invalidateQueries({ queryKey: ["rules"] });
    },
    onError: (e) => setMessage(String(e)),
  });
  const revert = useMutation({
    mutationFn: (id: string) => api.rules.revert(id, reason),
    onSuccess: () => {
      setMessage("Previous policy restored; history retained.");
      void client.invalidateQueries({ queryKey: ["rules"] });
    },
    onError: (e) => setMessage(String(e)),
  });
  return (
    <section
      data-testid="rules-panel"
      className="space-y-3 border border-surface-highest rounded-md p-4 mt-8"
    >
      <h2 className="font-headline font-bold text-sm">Agent rules</h2>
      <p className="text-xs text-outline">
        Workspace policies can block tools before execution. Arbitrary shell commands, unverified
        tools and subagent launches are blocked by file-protection rules. Comment checks support
        JavaScript and TypeScript.
      </p>
      {state.error ? (
        <p role="alert" data-testid="rules-error" className="text-xs">
          {String(state.error)}
        </p>
      ) : (
        <>
          <p data-testid="rules-status" className="text-xs">
            ORC-managed enforcement: {state.data?.enabled ? "enabled" : "disabled"}. Claude SDK is
            supported; other sessions require a qualified native hook.
          </p>
          <Label htmlFor="rules-workspace">Absolute workspace directory</Label>
          <Input
            id="rules-workspace"
            data-testid="rules-workspace"
            value={workspace}
            onChange={(e) => setWorkspace(e.target.value)}
          />
          <label className="flex gap-2 text-xs">
            <input
              data-testid="rules-delete"
              type="checkbox"
              checked={denyDelete}
              onChange={(e) => setDenyDelete(e.target.checked)}
            />
            Prevent file deletion
          </label>
          <label className="flex gap-2 text-xs">
            <input
              data-testid="rules-comments"
              type="checkbox"
              checked={denyComments}
              onChange={(e) => setDenyComments(e.target.checked)}
            />
            Prevent new code comments
          </label>
          <Label htmlFor="rules-reason">Change or revert reason</Label>
          <Input
            id="rules-reason"
            data-testid="rules-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <Button
            data-testid="rules-save"
            disabled={
              save.isPending ||
              !workspace.trim() ||
              !reason.trim() ||
              (!denyDelete && !denyComments)
            }
            onClick={() => save.mutate()}
          >
            Save policy
          </Button>
          <div className="space-y-2">
            {state.data?.history.map((row) => (
              <div
                data-testid="rule-revision"
                data-revision-id={row.id}
                key={row.id}
                className="border-t border-surface-highest pt-2 text-xs"
              >
                <p>
                  {row.workspace} · {row.current ? "current" : "historical"} ·{" "}
                  {row.policy ? `${row.policy.rules.length} rules` : "disabled"}
                </p>
                <p>{row.reason}</p>
                <details>
                  <summary>Policy</summary>
                  <pre className="whitespace-pre-wrap break-all">
                    {JSON.stringify(row.policy, null, 2)}
                  </pre>
                </details>
                {row.current && (
                  <Button
                    data-testid="rule-revert"
                    variant="outline"
                    disabled={revert.isPending || !reason.trim()}
                    onClick={() => revert.mutate(row.id)}
                  >
                    Restore previous policy
                  </Button>
                )}
              </div>
            ))}
          </div>
          <details data-testid="rules-decisions">
            <summary>Recent decisions and actions</summary>
            <pre className="text-xs whitespace-pre-wrap break-all">
              {JSON.stringify(
                { decisions: state.data?.decisions, actions: state.data?.actions },
                null,
                2,
              )}
            </pre>
          </details>
        </>
      )}
      {message && (
        <p role="status" data-testid="rules-message" className="text-xs">
          {message}
        </p>
      )}
    </section>
  );
}

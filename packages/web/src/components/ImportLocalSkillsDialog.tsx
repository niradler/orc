import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type LocalSkill } from "@/api/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const STATUS_LABEL: Record<LocalSkill["status"], string> = {
  new: "",
  installed: "Already in ORC",
  conflict: "Name taken in ORC (different content)",
  changed: "Changed since import",
  invalid: "Invalid",
};

const key = (skill: LocalSkill) => `${skill.agent}/${skill.name}`;

export function ImportLocalSkillsDialog({ onClose }: { onClose: () => void }) {
  const [selected, setSelected] = useState<string[]>([]);
  const queryClient = useQueryClient();
  const listing = useQuery({
    queryKey: ["skills", "local-agents"],
    queryFn: api.skills.localAgents,
  });
  const importing = useMutation({
    mutationFn: api.skills.importLocal,
    onSuccess: async (result) => {
      setSelected([]);
      await queryClient.invalidateQueries({ queryKey: ["skills"] });
      if (!result.skipped.length) onClose();
    },
  });
  const busy = importing.isPending;
  const agents = listing.data?.agents ?? [];
  const selectedNames = new Set(selected.map((item) => item.split("/")[1]));
  const toggle = (skill: LocalSkill, checked: boolean) =>
    setSelected(
      checked ? [...selected, key(skill)] : selected.filter((item) => item !== key(skill)),
    );
  const selectAll = (skills: LocalSkill[]) => {
    const next = [...selected];
    const names = new Set(selectedNames);
    for (const skill of skills) {
      if (skill.status !== "new" || names.has(skill.name)) continue;
      next.push(key(skill));
      names.add(skill.name);
    }
    setSelected(next);
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Import from local agents</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-outline">
          Copies skills from agent folders such as ~/.claude/skills and ~/.codex/skills into ORC.
          The originals are not changed.
        </p>
        {listing.isLoading && <p role="status">Scanning agent folders…</p>}
        {listing.data && !agents.length && <p role="status">No local agent skill folders found.</p>}
        <div className="max-h-[55vh] overflow-y-auto space-y-4">
          {agents.map((agent) => {
            const fresh = agent.skills.filter((skill) => skill.status === "new");
            return (
              <section key={agent.id} data-testid="local-agent" data-agent={agent.id}>
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div>
                    <p className="text-sm font-medium">{agent.label}</p>
                    <p className="text-xs text-outline">{agent.dir}</p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid="local-agent-select-all"
                    disabled={busy || !fresh.length}
                    onClick={() => selectAll(agent.skills)}
                  >
                    Select all new ({fresh.length})
                  </Button>
                </div>
                <div className="space-y-2">
                  {agent.skills.map((skill) => {
                    const checked = selected.includes(key(skill));
                    const takenElsewhere = !checked && selectedNames.has(skill.name);
                    return (
                      <label
                        key={key(skill)}
                        className="flex items-start gap-3 border border-surface-highest rounded p-3"
                        data-testid="local-skill"
                        data-skill-name={skill.name}
                      >
                        <input
                          type="checkbox"
                          data-testid="local-skill-select"
                          checked={checked}
                          disabled={busy || skill.status !== "new" || takenElsewhere}
                          onChange={(event) => toggle(skill, event.target.checked)}
                        />
                        <span className="text-sm">
                          <span className="font-medium">{skill.name}</span>
                          {STATUS_LABEL[skill.status] && (
                            <span className="ml-2 text-xs text-outline">
                              {STATUS_LABEL[skill.status]}
                            </span>
                          )}
                          <span className="block text-xs text-outline">
                            {skill.error ?? skill.description}
                          </span>
                          {skill.extra_fields.length > 0 && (
                            <span
                              className="block text-xs text-outline"
                              data-testid="local-skill-extra-fields"
                            >
                              Extra fields: {skill.extra_fields.join(", ")}
                            </span>
                          )}
                          {skill.also_in.length > 0 && (
                            <span className="block text-xs text-outline">
                              Also in {skill.also_in.join(", ")}
                            </span>
                          )}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
        {importing.data?.skipped.map((skip) => (
          <p key={`${skip.agent}/${skip.name}`} role="alert" className="text-xs text-destructive">
            Skipped {skip.name}: {skip.reason}
          </p>
        ))}
        {(listing.error || importing.error) && (
          <p role="alert" className="text-sm text-destructive">
            {(listing.error || importing.error)?.message}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Close
          </Button>
          <Button
            data-testid="local-skill-import-submit"
            disabled={busy || !selected.length}
            onClick={() =>
              importing.mutate(
                selected.map((item) => {
                  const [agent = "", name = ""] = item.split("/");
                  return { agent, name };
                }),
              )
            }
          >
            {importing.isPending
              ? "Importing…"
              : `Import selected${selected.length ? ` (${selected.length})` : ""}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

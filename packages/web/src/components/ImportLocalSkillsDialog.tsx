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
      <DialogContent
        closeDisabled={busy}
        className="flex min-w-0 w-[min(800px,calc(100vw-2rem))] max-w-none max-h-[calc(var(--app-height,100dvh)-2rem)] flex-col gap-0 overflow-hidden p-0"
      >
        <DialogHeader className="shrink-0 border-b px-4 py-4 pr-12 sm:px-6">
          <DialogTitle>Import from local agents</DialogTitle>
        </DialogHeader>
        <div
          className="min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6"
          data-testid="local-skill-import-body"
        >
          <p className="text-xs text-outline">
            Copies skills from agent folders such as ~/.claude/skills and ~/.codex/skills into ORC.
            The originals are not changed.
          </p>
          {listing.isLoading && <p role="status">Scanning agent folders…</p>}
          {listing.data && !agents.length && (
            <p role="status">No local agent skill folders found.</p>
          )}
          <div className="space-y-4">
            {agents.map((agent) => {
              const fresh = agent.skills.filter((skill) => skill.status === "new");
              return (
                <section key={agent.id} data-testid="local-agent" data-agent={agent.id}>
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{agent.label}</p>
                      <details className="text-xs text-outline">
                        <summary className="flex min-h-11 cursor-pointer items-center md:min-h-6 pointer-coarse:min-h-11">
                          Source folder
                        </summary>
                        <p className="wrap-break-word">{agent.dir}</p>
                      </details>
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
                  <div className="divide-y divide-border">
                    {agent.skills.map((skill) => {
                      const checked = selected.includes(key(skill));
                      const takenElsewhere = !checked && selectedNames.has(skill.name);
                      return (
                        <div
                          key={key(skill)}
                          className="min-w-0 py-2"
                          data-testid="local-skill"
                          data-skill-name={skill.name}
                        >
                          <label className="flex min-h-11 min-w-0 items-center gap-3 text-sm md:min-h-6 pointer-coarse:min-h-11">
                            <input
                              type="checkbox"
                              className="mt-1 shrink-0"
                              data-testid="local-skill-select"
                              checked={checked}
                              disabled={busy || skill.status !== "new" || takenElsewhere}
                              onChange={(event) => toggle(skill, event.target.checked)}
                            />
                            <span className="min-w-0 text-sm wrap-break-word">
                              <span className="font-medium">{skill.name}</span>
                              {STATUS_LABEL[skill.status] && (
                                <span className="ml-2 text-xs text-outline">
                                  {STATUS_LABEL[skill.status]}
                                </span>
                              )}
                            </span>
                          </label>
                          {skill.error && (
                            <p className="pl-6 text-xs text-destructive wrap-break-word">
                              {skill.error}
                            </p>
                          )}
                          <details className="min-w-0 pl-6">
                            <summary
                              data-testid="local-skill-details"
                              aria-label={`Details for ${skill.name}`}
                              className="flex min-h-11 cursor-pointer items-center gap-2 rounded-sm text-xs text-outline md:min-h-8 pointer-coarse:min-h-11"
                            >
                              <span className="min-w-0 flex-1 truncate">{skill.description}</span>
                              <span className="shrink-0">Details</span>
                            </summary>
                            <div className="space-y-1 pb-2 text-xs wrap-break-word">
                              <p>{skill.description}</p>
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
                            </div>
                          </details>
                        </div>
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
        </div>
        <DialogFooter className="shrink-0 border-t px-4 py-3 sm:px-6">
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

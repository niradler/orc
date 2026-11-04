import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Info } from "lucide-react";
import { useState } from "react";
import { api, type LocalSkill } from "@/api/client";
import { HelpPopover } from "@/components/HelpPopover";
import {
  MatchNote,
  NativeFolderField,
  PROJECT_PREFIX,
  ProjectSkillFolderOptions,
} from "@/components/NativeFolderField";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

const STATUS_LABEL: Record<LocalSkill["status"], string> = {
  new: "",
  installed: "Already in ORC",
  duplicate: "Already in ORC under another name",
  conflict: "Name taken in ORC (different content)",
  changed: "Changed since import",
  invalid: "Invalid",
};

const key = (skill: LocalSkill) => `${skill.agent}:${skill.path}`;

export function ImportLocalSkillsDialog({ onClose }: { onClose: () => void }) {
  const [selected, setSelected] = useState<LocalSkill[]>([]);
  const [source, setSource] = useState("agents");
  const [folderDraft, setFolderDraft] = useState("");
  const [folder, setFolder] = useState("");
  const queryClient = useQueryClient();
  const scanPath = source.startsWith(PROJECT_PREFIX)
    ? source.slice(PROJECT_PREFIX.length)
    : source === "folder"
      ? folder
      : "";
  const scanning = source === "agents" || Boolean(scanPath);
  const listing = useQuery({
    queryKey: ["skills", "local-agents", scanPath],
    queryFn: () => api.skills.localAgents(scanPath || undefined),
    enabled: scanning,
  });
  const importing = useMutation({
    mutationFn: (skills: LocalSkill[]) =>
      api.skills.importLocal(
        skills.map((skill) => ({
          agent: skill.agent,
          name: skill.name,
          ...(scanPath ? { path: skill.path } : {}),
        })),
        scanPath || undefined,
      ),
    onSuccess: async (result) => {
      setSelected([]);
      await queryClient.invalidateQueries({ queryKey: ["skills"] });
      if (!result.skipped.length) onClose();
    },
  });
  const busy = importing.isPending;
  const agents = scanning ? (listing.data?.agents ?? []) : [];
  const selectedKeys = new Set(selected.map(key));
  const selectedNames = new Set(selected.map((skill) => skill.name));
  const toggle = (skill: LocalSkill, checked: boolean) =>
    setSelected(
      checked ? [...selected, skill] : selected.filter((item) => key(item) !== key(skill)),
    );
  const selectAll = (skills: LocalSkill[]) => {
    const next = [...selected];
    const names = new Set(selectedNames);
    for (const skill of skills) {
      if (skill.status !== "new" || names.has(skill.name)) continue;
      next.push(skill);
      names.add(skill.name);
    }
    setSelected(next);
  };
  const changeSource = (next: string) => {
    setSource(next);
    setSelected([]);
    importing.reset();
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        closeDisabled={busy}
        className="flex min-w-0 w-[min(800px,calc(100vw-2rem))] max-w-none max-h-[calc(var(--app-height,100dvh)-2rem)] flex-col gap-0 overflow-hidden p-0"
      >
        <DialogHeader className="shrink-0 flex-row items-center gap-1 border-b px-4 py-3 pr-12 sm:px-6">
          <DialogTitle>Import from local agents</DialogTitle>
          <HelpPopover label="local skill imports">
            Copies skills from agent folders such as ~/.claude/skills and ~/.codex/skills, a project
            checkout's skill folders, or any folder of skill folders, into ORC. The originals are
            not changed. Near copies of skills already in ORC are flagged so a one-letter edit does
            not create a duplicate.
          </HelpPopover>
        </DialogHeader>
        <div
          className="min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6"
          data-testid="local-skill-import-body"
        >
          <div className="space-y-2">
            <label htmlFor="local-skill-source" className="text-sm font-medium">
              Source
            </label>
            <select
              id="local-skill-source"
              data-testid="local-skill-source"
              className="block h-11 w-full rounded-md border border-input bg-background px-3 text-sm sm:h-8"
              value={source}
              disabled={busy}
              onChange={(event) => changeSource(event.target.value)}
            >
              <option value="agents">Your agent skill folders</option>
              <ProjectSkillFolderOptions withSkillsOnly />
              <option value="folder">Custom folder</option>
            </select>
            {source === "folder" && (
              <form
                className="flex flex-col gap-2 sm:flex-row sm:items-end"
                onSubmit={(event) => {
                  event.preventDefault();
                  setSelected([]);
                  setFolder(folderDraft.trim());
                }}
              >
                <div className="min-w-0 flex-1">
                  <NativeFolderField
                    id="local-skill-folder"
                    label="Folder"
                    value={folderDraft}
                    disabled={busy}
                    onChange={setFolderDraft}
                  />
                </div>
                <Button
                  type="submit"
                  variant="outline"
                  data-testid="local-skill-folder-scan"
                  disabled={busy || !folderDraft.trim()}
                >
                  Scan
                </Button>
              </form>
            )}
          </div>
          {listing.isLoading && scanning && <p role="status">Scanning skill folders…</p>}
          {listing.data && scanning && !agents.length && (
            <p role="status">No local agent skill folders found.</p>
          )}
          {listing.data && scanPath && agents.length > 0 && !agents[0]?.skills.length && (
            <p role="status">No skills found in this folder.</p>
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
                      const checked = selectedKeys.has(key(skill));
                      const takenElsewhere = !checked && selectedNames.has(skill.name);
                      return (
                        <div
                          key={key(skill)}
                          className="flex min-w-0 items-center gap-2 py-2"
                          data-testid="local-skill"
                          data-skill-name={skill.name}
                        >
                          <label className="flex min-h-11 min-w-0 flex-1 items-start gap-3 text-sm">
                            <input
                              type="checkbox"
                              aria-label={`Select ${skill.name}`}
                              className="mt-1 shrink-0"
                              data-testid="local-skill-select"
                              checked={checked}
                              disabled={busy || skill.status !== "new" || takenElsewhere}
                              onChange={(event) => toggle(skill, event.target.checked)}
                            />
                            <span className="min-w-0 text-sm wrap-break-word">
                              <span className="block truncate font-medium">{skill.name}</span>
                              {STATUS_LABEL[skill.status] && (
                                <span className="ml-2 text-xs text-outline">
                                  {STATUS_LABEL[skill.status]}
                                </span>
                              )}
                              <span className="mt-0.5 line-clamp-2 text-xs leading-4 text-outline">
                                {skill.description}
                              </span>
                              <MatchNote match={skill.match} folder={agent.label} />
                              {skill.error && (
                                <span className="block text-xs text-destructive wrap-break-word">
                                  {skill.error}
                                </span>
                              )}
                            </span>
                          </label>
                          <Popover>
                            <PopoverTrigger asChild>
                              <Button
                                type="button"
                                size="icon"
                                variant="ghost"
                                actionHelp={false}
                                data-testid="local-skill-details"
                                aria-label={`Details for ${skill.name}`}
                                className="shrink-0"
                              >
                                <Info aria-hidden />
                              </Button>
                            </PopoverTrigger>
                            <PopoverContent
                              data-testid="local-skill-details-content"
                              aria-label={`Details for ${skill.name}`}
                              align="end"
                              className="max-h-[60dvh] w-96 max-w-[calc(100vw-2rem)] overflow-y-auto space-y-2 text-sm wrap-break-word"
                            >
                              <p className="font-medium">{skill.name}</p>
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
                            </PopoverContent>
                          </Popover>
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
            onClick={() => importing.mutate(selected)}
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

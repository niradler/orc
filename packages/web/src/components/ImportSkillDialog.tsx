import { useMutation, useQueryClient } from "@tanstack/react-query";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function ImportSkillDialog({ onClose }: { onClose: () => void }) {
  const [source, setSource] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const queryClient = useQueryClient();
  const discover = useMutation({
    mutationFn: api.skills.discover,
    onSuccess: () => setSelected([]),
  });
  const importing = useMutation({
    mutationFn: api.skills.import,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["skills"] });
      onClose();
    },
  });
  const busy = discover.isPending || importing.isPending;
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Import from GitHub</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            discover.mutate(source.trim());
          }}
        >
          <Label htmlFor="skill-repository">Repository or skills.sh link</Label>
          <Input
            id="skill-repository"
            data-testid="skill-repository-input"
            value={source}
            disabled={busy}
            onChange={(event) => {
              setSource(event.target.value);
              discover.reset();
              importing.reset();
              setSelected([]);
            }}
            placeholder="https://github.com/vercel-labs/agent-skills"
            autoFocus
          />
          <p className="text-xs text-outline">
            Public GitHub repositories, owner/repo, skill-folder URLs and skills.sh links.
            Supporting files are included.
          </p>
          <Button type="submit" data-testid="skill-discover" disabled={busy || !source.trim()}>
            {discover.isPending ? "Discovering…" : "Discover skills"}
          </Button>
        </form>
        {discover.data && (
          <div className="space-y-2">
            <p className="text-xs text-outline">
              {discover.data.skills.length} skills found · {discover.data.commit.slice(0, 8)}
            </p>
            {!discover.data.skills.length && (
              <p role="status">No valid skills found in this source.</p>
            )}
            <div className="max-h-[45vh] overflow-y-auto space-y-2">
              {discover.data.skills.map((skill) => (
                <label
                  key={skill.path}
                  className="flex items-start gap-3 border border-surface-highest rounded p-3"
                  data-testid="remote-skill"
                  data-skill-name={skill.name}
                >
                  <input
                    type="checkbox"
                    data-testid="remote-skill-select"
                    checked={selected.includes(skill.path)}
                    disabled={
                      busy ||
                      skill.installed ||
                      (!selected.includes(skill.path) && selected.length >= 16)
                    }
                    onChange={(event) =>
                      setSelected(
                        event.target.checked
                          ? [...selected, skill.path]
                          : selected.filter((path) => path !== skill.path),
                      )
                    }
                  />
                  <span className="text-sm">
                    <span className="font-medium">{skill.name}</span>
                    {skill.installed && (
                      <span className="ml-2 text-xs text-outline">Already installed</span>
                    )}
                    <span className="block text-xs text-outline">{skill.description}</span>
                    <span className="block text-xs text-outline">
                      {skill.path || "Repository root"}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            {discover.data.issues.map((issue) => (
              <p key={issue.path} role="alert" className="text-xs text-destructive">
                {issue.path}: {issue.error}
              </p>
            ))}
          </div>
        )}
        {(discover.error || importing.error) && (
          <p role="alert" className="text-sm text-destructive">
            {(discover.error || importing.error)?.message}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            data-testid="skill-import-submit"
            disabled={busy || !discover.data || !selected.length}
            onClick={() =>
              discover.data &&
              importing.mutate({
                source: source.trim(),
                commit: discover.data.commit,
                paths: selected,
              })
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

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { useProjects, useCreateProject, useDeleteProject } from "@/hooks/useProjects";
import { ViewHeader } from "@/components/ViewHeader";
import { StatusBadge } from "@/components/StatusBadge";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import type { TaskStatus } from "@/api/client";

export default function Projects() {
  const { data: projects, isLoading, error, refetch } = useProjects();
  const deleteProject = useDeleteProject();
  const [creating, setCreating] = useState(false);

  if (error) return <ErrorState message={error.message} onRetry={() => refetch()} />;

  return (
    <div>
      <ViewHeader
        title="Projects"
        meta={`${(projects ?? []).length} total`}
        action={
          <Button size="sm" onClick={() => setCreating(true)}
            className="font-label text-xs uppercase tracking-widest bg-primary/10 text-primary border border-primary/30 hover:bg-primary/20">
            + New Project
          </Button>
        }
      />

      {isLoading ? (
        <div className="space-y-2">
          {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-12 w-full bg-surface-highest" />)}
        </div>
      ) : (projects ?? []).length === 0 ? (
        <EmptyState message="No projects" />
      ) : (
        <div className="border border-surface-highest rounded-sm overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="border-b border-surface-highest hover:bg-transparent">
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline">Name</TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline">Description</TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-28">Status</TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-36">Tags</TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-24">Created</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(projects ?? []).map((p) => (
                <TableRow key={p.id} className="border-b border-surface-highest/50 hover:bg-surface-low">
                  <TableCell className="font-body text-xs font-semibold text-on-surface">{p.name}</TableCell>
                  <TableCell className="font-body text-xs text-outline max-w-xs truncate">{p.description ?? "—"}</TableCell>
                  <TableCell>
                    <StatusBadge
                      status={
                        p.status === "active" ? ("doing" as TaskStatus)
                        : p.status === "done" ? ("done" as TaskStatus)
                        : ("todo" as TaskStatus)
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {(p.tags ?? []).map((t) => (
                        <span key={t} className="font-label text-[9px] px-1.5 py-0.5 bg-surface-highest text-outline border border-surface-highest/50">
                          {t}
                        </span>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="font-label text-[10px] text-outline">
                    {new Date(p.created_at).toLocaleDateString()}
                  </TableCell>
                  <TableCell>
                    <button onClick={() => deleteProject.mutate(p.id)}
                      className="text-outline hover:text-error transition-colors p-1">
                      <Trash2 size={12} />
                    </button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {creating && <CreateProjectDialog open={creating} onClose={() => setCreating(false)} />}
    </div>
  );
}

function CreateProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const createProject = useCreateProject();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    createProject.mutate(
      { name: name.trim(), description: description.trim() || undefined },
      { onSuccess: () => { setName(""); setDescription(""); onClose(); } },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="bg-surface border-surface-highest max-w-md">
        <DialogHeader>
          <DialogTitle className="font-headline text-sm uppercase tracking-widest text-on-surface">New Project</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 mt-2">
          <div className="space-y-1.5">
            <Label className="font-label text-[10px] uppercase tracking-widest text-outline">Name *</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="project-name"
              className="bg-background border-surface-highest text-on-surface font-body text-xs" autoFocus />
          </div>
          <div className="space-y-1.5">
            <Label className="font-label text-[10px] uppercase tracking-widest text-outline">Description</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)}
              placeholder="Short description..." rows={2}
              className="bg-background border-surface-highest text-on-surface font-body text-xs resize-none" />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={onClose}
              className="font-label text-xs uppercase text-outline">Cancel</Button>
            <Button type="submit" size="sm" disabled={createProject.isPending || !name.trim()}
              className="font-label text-xs uppercase bg-primary/15 text-primary border border-primary/30">
              {createProject.isPending ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

import {
  SCRATCHPAD_KINDS,
  SCRATCHPAD_TITLE_MAX,
  type Scratchpad,
  type ScratchpadKind,
} from "@orc/core/scratchpad";
import { useRef, useState } from "react";
import type { LiveSession } from "@/api/client";
import { FormDialog } from "@/components/FormDialog";
import { TagInput } from "@/components/TagInput";
import { Button } from "@/components/ui/button";
import { DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useProjects } from "@/hooks/useProjects";
import { useCreateScratchpad, useUpdateScratchpad } from "@/hooks/useScratchpads";
import { useLiveSessions } from "@/hooks/useSessions";
import { formatWhen } from "@/lib/live-sessions";
import { KIND_META } from "@/lib/scratchpad-kinds";

const NO_PROJECT = "none";
const NO_SESSION = "none";
const SESSION_CHOICES = 50;

/**
 * The most recent agent sessions to offer, in the chosen project when there is one. The pad's
 * current session stays listed even when it is older or in another project.
 */
function sessionChoices(
  sessions: LiveSession[] | undefined,
  projectId: string,
  current: string,
): LiveSession[] {
  const recent = (sessions ?? [])
    .filter(
      (s) =>
        s.session_id &&
        (projectId === NO_PROJECT || s.project_id === projectId || s.session_id === current),
    )
    .sort((a, b) =>
      (b.last_activity_at ?? b.created_at).localeCompare(a.last_activity_at ?? a.created_at),
    )
    .slice(0, SESSION_CHOICES);
  const kept = sessions?.find((s) => s.session_id === current);
  return kept && !recent.includes(kept) ? [kept, ...recent] : recent;
}

/** Creates a pad, or edits an existing pad's title, project, session and tags. */
export function ScratchpadFormDialog({
  pad,
  defaultProjectId = "",
  defaultKind = "doc",
  defaultTitle,
  defaultContent,
  defaultSessionId,
  onClose,
  onSaved,
}: {
  pad?: Scratchpad;
  defaultProjectId?: string;
  defaultKind?: ScratchpadKind;
  /** Seeds a new pad created from a chat selection; edits still use `pad`. */
  defaultTitle?: string;
  defaultContent?: string;
  defaultSessionId?: string;
  onClose: () => void;
  onSaved?: (pad: Scratchpad) => void;
}) {
  const [kind, setKind] = useState<ScratchpadKind>(pad?.kind ?? defaultKind);
  const [title, setTitle] = useState(pad?.title ?? defaultTitle ?? "");
  const [projectId, setProjectId] = useState(
    (pad ? pad.project_id : defaultProjectId) || NO_PROJECT,
  );
  const [sessionId, setSessionId] = useState(pad?.session_id ?? defaultSessionId ?? NO_SESSION);
  const [tags, setTags] = useState<string[]>(pad?.tags ?? []);
  const [tagDraft, setTagDraft] = useState("");
  const [pinned, setPinned] = useState(pad?.pinned ?? false);
  const [keepAlive, setKeepAlive] = useState(pad?.keep_alive ?? false);
  // "keep" leaves an existing expiry alone; a new pad starts without one.
  const [expiry, setExpiry] = useState(pad?.expires_at ? "keep" : "none");
  const initialFields = useRef(
    JSON.stringify([kind, title, projectId, sessionId, tags, pinned, keepAlive, expiry]),
  );
  const { data: projects } = useProjects({ status: "active" });
  const { data: sessions } = useLiveSessions(false, undefined, true);
  const sessionOptions = sessionChoices(sessions, projectId, sessionId);
  const create = useCreateScratchpad();
  const update = useUpdateScratchpad();
  const mutation = pad ? update : create;

  function submit(afterSave: () => void) {
    const fields = {
      title: title.trim(),
      project_id: projectId === NO_PROJECT ? null : projectId,
      session_id: sessionId === NO_SESSION ? null : sessionId,
      tags,
      pinned,
      keep_alive: expiry === "none" ? false : keepAlive,
      ...(expiry === "keep" ? {} : expiry === "none" ? { expires_at: null } : { ttl: expiry }),
    };
    const done = (saved: Scratchpad) => {
      afterSave();
      onSaved?.(saved);
    };
    if (pad) update.mutate({ id: pad.id, ...fields }, { onSuccess: done });
    else
      create.mutate(
        {
          kind,
          ...fields,
          ...(defaultContent === undefined ? {} : { content: defaultContent }),
        },
        { onSuccess: done },
      );
  }

  return (
    <FormDialog
      open
      onClose={onClose}
      busy={mutation.isPending}
      dirty={
        Boolean(tagDraft.trim()) ||
        JSON.stringify([kind, title, projectId, sessionId, tags, pinned, keepAlive, expiry]) !==
          initialFields.current
      }
      testId="scratchpad-form"
    >
      {(requestClose, closeAfterSave) => (
        <>
          <DialogHeader>
            <DialogTitle>{pad ? "Scratchpad properties" : "New scratchpad"}</DialogTitle>
          </DialogHeader>
          <form
            className="min-h-0"
            onSubmit={(event) => {
              event.preventDefault();
              submit(closeAfterSave);
            }}
          >
            <div className="work-form-body grid grid-cols-1 gap-4 md:grid-cols-2">
              {!pad && (
                <fieldset className="space-y-2 md:col-span-2">
                  <legend className="font-label text-sm">Kind</legend>
                  <div className="grid grid-cols-3 gap-2">
                    {SCRATCHPAD_KINDS.map((value) => {
                      const { label, icon: Icon } = KIND_META[value];
                      return (
                        <button
                          key={value}
                          type="button"
                          data-testid={`scratchpad-form-kind-${value}`}
                          aria-pressed={kind === value}
                          onClick={() => setKind(value)}
                          className={`flex min-h-8 items-center justify-center gap-1 rounded-md border px-2 py-2 transition-colors ${
                            kind === value
                              ? "border-primary bg-surface-low"
                              : "border-outline-variant hover:bg-surface-low"
                          }`}
                        >
                          <span className="inline-flex items-center gap-1.5 font-label text-[13px]">
                            <Icon size={14} aria-hidden /> {label}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  <p className="text-xs text-muted-foreground" data-testid="scratchpad-kind-hint">
                    {KIND_META[kind].hint}
                  </p>
                </fieldset>
              )}
              <div className="space-y-2 md:col-span-2">
                <Label htmlFor="scratchpad-title">Title</Label>
                <Input
                  id="scratchpad-title"
                  data-testid="scratchpad-form-title"
                  value={title}
                  maxLength={SCRATCHPAD_TITLE_MAX}
                  autoFocus
                  onChange={(e) => setTitle(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="scratchpad-project">Project</Label>
                <Select value={projectId} onValueChange={setProjectId}>
                  <SelectTrigger id="scratchpad-project" data-testid="scratchpad-form-project">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-surface border-outline-variant">
                    <SelectItem value={NO_PROJECT}>No project</SelectItem>
                    {projects?.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="scratchpad-session">Session</Label>
                <Select value={sessionId} onValueChange={setSessionId}>
                  <SelectTrigger id="scratchpad-session" data-testid="scratchpad-form-session">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-surface border-outline-variant">
                    <SelectItem value={NO_SESSION}>No session</SelectItem>
                    {sessionId !== NO_SESSION &&
                      !sessionOptions.some((s) => s.session_id === sessionId) && (
                        <SelectItem value={sessionId}>{sessionId.slice(0, 8)}</SelectItem>
                      )}
                    {sessionOptions.map((s) => (
                      <SelectItem
                        key={s.id}
                        value={s.session_id as string}
                        data-testid="scratchpad-form-session-option"
                      >
                        {s.agent} · {s.name ?? "Untitled session"} ·{" "}
                        {formatWhen(s.last_activity_at ?? s.created_at)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2 md:col-span-2">
                <Label>Tags</Label>
                <TagInput
                  value={tags}
                  onChange={setTags}
                  onDraftChange={setTagDraft}
                  placeholder="Add a tag"
                  aria-label="Tags"
                  data-testid="scratchpad-form-tags"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="scratchpad-expiry">Expiry</Label>
                <Select value={expiry} onValueChange={setExpiry}>
                  <SelectTrigger
                    id="scratchpad-expiry"
                    data-testid="scratchpad-form-expiry"
                    className="w-full"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-surface border-outline-variant">
                    {pad?.expires_at && <SelectItem value="keep">Keep current</SelectItem>}
                    <SelectItem value="none">Never</SelectItem>
                    <SelectItem value="1h">After 1 hour</SelectItem>
                    <SelectItem value="1d">After 1 day</SelectItem>
                    <SelectItem value="7d">After 7 days</SelectItem>
                    <SelectItem value="30d">After 30 days</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Expiring pads are archived for a grace period before deletion. Pinned or
                  referenced pads are kept.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-4">
                <label className="flex min-h-11 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    data-testid="scratchpad-form-pinned"
                    checked={pinned}
                    onChange={(event) => setPinned(event.target.checked)}
                  />
                  Pin (never auto-expire)
                </label>
                <label className="flex min-h-11 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    data-testid="scratchpad-form-keep-alive"
                    checked={keepAlive}
                    disabled={expiry === "none"}
                    onChange={(event) => setKeepAlive(event.target.checked)}
                  />
                  Extend on edit
                </label>
              </div>
              {mutation.error && (
                <p role="alert" className="text-sm text-destructive md:col-span-2">
                  {mutation.error.message}
                </p>
              )}
            </div>
            <DialogFooter className="work-form-footer">
              <Button
                type="button"
                variant="ghost"
                onClick={requestClose}
                disabled={mutation.isPending}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                data-testid="scratchpad-form-submit"
                disabled={!title.trim() || mutation.isPending}
              >
                {pad ? "Save" : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </>
      )}
    </FormDialog>
  );
}

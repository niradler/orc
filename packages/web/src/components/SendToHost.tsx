import {
  SEND_BLOCKED_HEADERS,
  type SessionSend,
  type SessionSendPreview,
} from "@orc/core/session-send";
import { Check, Send } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type LiveSession, type Project } from "@/api/client";
import { HelpPopover } from "@/components/HelpPopover";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { type ApiHost, hostHeaders, readApiHosts, readApiUrl, sameApiUrl } from "@/lib/api-hosts";

/** Repository identity loose enough to preselect the matching destination project. */
function repoKey(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^[^/@:]+@([^/:]+):/, "$1/")
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/\/?\.git\/?$/, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

export function SendToHost({
  session,
  open,
  onClose,
}: {
  session: LiveSession;
  open: boolean;
  onClose: () => void;
}) {
  const [hosts, setHosts] = useState<ApiHost[]>([]);
  const [preview, setPreview] = useState<SessionSendPreview | null>(null);
  const [host, setHost] = useState<ApiHost | null>(null);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [project, setProject] = useState("");
  const [note, setNote] = useState("");
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<SessionSend | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setHosts(readApiHosts().filter((item) => !sameApiUrl(item.url, readApiUrl())));
    setPreview(null);
    setHost(null);
    setProjects(null);
    setProject("");
    setNote("");
    setResult(null);
    setError(null);
    let current = true;
    api.sessions
      .sendPreview(session.id)
      .then((value) => {
        if (current) setPreview(value);
      })
      .catch((cause: unknown) => {
        if (current) setError(cause instanceof Error ? cause.message : String(cause));
      });
    // Reopening a moved session lands on its existing send, so the link to the
    // destination stays available without sending the session again.
    if (session.send?.status === "ready") {
      api.sessions
        .sends(session.id)
        .then(({ sends }) => {
          const ready = sends.find((item) => item.status === "ready");
          if (current && ready) setResult(ready);
        })
        .catch(() => {
          // The form still works when the history cannot be read.
        });
    }
    return () => {
      current = false;
    };
  }, [open, session.id, session.send?.status]);

  async function pickHost(next: ApiHost): Promise<void> {
    setHost(next);
    setProjects(null);
    setProject("");
    setError(null);
    setLoadingProjects(true);
    try {
      const response = await fetch(`${next.url}/api/projects?limit=100`, {
        credentials: "include",
        cache: "no-store",
        headers: hostHeaders(next),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
        throw new Error(
          typeof body?.error === "string"
            ? body.error
            : `The host answered HTTP ${response.status}`,
        );
      }
      const body = (await response.json()) as { projects: Project[] };
      setProjects(body.projects);
      const match = preview?.repository
        ? body.projects.find((item) => repoKey(item.git_remote_url) === repoKey(preview.repository))
        : undefined;
      setProject((match ?? body.projects[0])?.name ?? "");
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      setError(
        /failed to fetch|networkerror|load failed/i.test(detail)
          ? `Could not reach ${next.label}. Check the URL, the network, and that this dashboard's origin is allowed under the host's Security settings.`
          : `Could not list projects on ${next.label}: ${detail}`,
      );
    } finally {
      setLoadingProjects(false);
    }
  }

  async function send(): Promise<void> {
    if (!host || !project) return;
    setSending(true);
    setError(null);
    try {
      const sent = await api.sessions.sendTo(session.id, {
        host_label: host.label,
        url: host.url,
        token: host.token,
        headers: host.headers.filter(
          (header) =>
            header.name.trim() &&
            header.value &&
            !SEND_BLOCKED_HEADERS.has(header.name.trim().toLowerCase()),
        ),
        project,
        note: note.trim(),
      });
      setResult(sent);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  }

  const selectedProject = projects?.find((item) => item.name === project);
  const busy = sending || loadingProjects;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (sending) return;
        if (!next) onClose();
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        data-testid="send-to-host-dialog"
        className="max-w-lg"
      >
        <DialogTitle className="flex items-center gap-2">
          <Send size={15} aria-hidden="true" />
          Send session to a host
        </DialogTitle>
        {result ? (
          result.status === "ready" ? (
            <div className="space-y-3" data-testid="send-to-result">
              <p className="flex items-center gap-2 text-sm">
                <Check size={15} className="text-success" aria-hidden="true" />
                Sent to {result.host_label}. Continue the session there.
              </p>
              <p className="text-xs text-outline">
                Project {result.project} · branch {result.branch} · snapshot{" "}
                {result.commit?.slice(0, 12)}
              </p>
              {result.left_behind.length > 0 && (
                <p data-testid="send-to-left-behind" className="text-xs text-warning">
                  Kept on this machine (secret files): {result.left_behind.join(", ")}
                </p>
              )}
              <div className="flex flex-wrap justify-end gap-2">
                <Button type="button" variant="ghost" onClick={onClose}>
                  Done
                </Button>
                <Button type="button" data-testid="send-to-open" asChild>
                  <a
                    href={`${result.host_url}/chat?sessionLive=${encodeURIComponent(result.remote_session_id ?? "")}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open on {result.host_label}
                  </a>
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-3" data-testid="send-to-result">
              <p role="alert" data-testid="send-to-error" className="text-sm text-error">
                {result.error ?? "The send failed."}
              </p>
              <div className="flex flex-wrap justify-end gap-2">
                <Button type="button" variant="ghost" onClick={onClose}>
                  Close
                </Button>
                <Button
                  type="button"
                  data-testid="send-to-retry"
                  onClick={() => {
                    setResult(null);
                    setError(null);
                  }}
                >
                  Try again
                </Button>
              </div>
            </div>
          )
        ) : (
          <div className="space-y-4">
            {preview && !preview.eligible && (
              <p role="alert" data-testid="send-to-ineligible" className="text-sm text-error">
                {preview.reason}
              </p>
            )}
            {preview?.eligible && (
              <p className="text-xs text-outline">
                Moves this conversation and a snapshot of {preview.repository ?? "its repository"}
                {preview.subdirectory ? ` (${preview.subdirectory})` : ""} to the host you pick.
                Secret-looking files stay on this machine.
              </p>
            )}
            <div className="space-y-2">
              <div className="flex items-center gap-1">
                <span className="text-sm">Host</span>
                <HelpPopover label="Send to host" testId="send-to-host-help">
                  Saved ORC servers from Settings → Hosts, except the one you are connected to. The
                  destination needs a project whose folder is a checkout of the same repository, and
                  both machines must reach its Git remote. The host's token is used for this send
                  only and is not stored here.
                </HelpPopover>
              </div>
              {hosts.length === 0 ? (
                <p data-testid="send-to-no-hosts" className="text-xs text-outline">
                  No saved hosts. Add a server under Settings → Hosts first.
                </p>
              ) : (
                <div className="max-h-40 space-y-1 overflow-y-auto" data-testid="send-to-host-list">
                  {hosts.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      data-testid={`send-to-host-${item.id}`}
                      disabled={busy || !preview?.eligible}
                      onClick={() => void pickHost(item)}
                      className={`flex min-h-11 w-full items-center justify-between gap-2 rounded-md border px-3 py-1.5 text-left text-sm disabled:opacity-50 ${
                        host?.id === item.id
                          ? "border-focus bg-surface-highest"
                          : "border-border hover:bg-surface-highest"
                      }`}
                    >
                      <span className="truncate">{item.label}</span>
                      <span className="truncate text-xs text-outline">{item.url}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            {host && (
              <div className="space-y-2">
                <label htmlFor="send-to-project" className="text-sm">
                  Destination project
                </label>
                {loadingProjects ? (
                  <p className="text-xs text-outline">Loading projects…</p>
                ) : projects && projects.length > 0 ? (
                  <>
                    <select
                      id="send-to-project"
                      data-testid="send-to-project-select"
                      className="form-control form-control-single"
                      disabled={busy}
                      value={project}
                      onChange={(event) => setProject(event.target.value)}
                    >
                      {projects.map((item) => (
                        <option key={item.id} value={item.name}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                    {selectedProject?.scope && (
                      <p className="truncate text-xs text-outline">{selectedProject.scope}</p>
                    )}
                  </>
                ) : (
                  <p data-testid="send-to-no-projects" className="text-xs text-outline">
                    No projects on this host. Create one there with its folder scope pointing at a
                    checkout of the same repository.
                  </p>
                )}
              </div>
            )}
            {host && projects && projects.length > 0 && (
              <div className="space-y-2">
                <label htmlFor="send-to-note" className="text-sm">
                  Note for the agent <span className="text-outline">(optional)</span>
                </label>
                <Textarea
                  id="send-to-note"
                  data-testid="send-to-note"
                  rows={2}
                  maxLength={4000}
                  disabled={busy}
                  placeholder="next: finish the parser tests"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                />
              </div>
            )}
            {error && (
              <p role="alert" data-testid="send-to-error" className="text-sm text-error">
                {error}
              </p>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="ghost" disabled={sending} onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="button"
                data-testid="send-to-submit"
                disabled={busy || !host || !project || !preview?.eligible}
                onClick={() => void send()}
              >
                {sending ? "Sending…" : "Send"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

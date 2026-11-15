import { Eye, EyeOff, Plus, Save, Trash2, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  DesktopConnectionSettings,
  useDesktopConnectionState,
} from "@/components/DesktopConnectionSettings";
import { HelpPopover } from "@/components/HelpPopover";
import { SshHostSettings } from "@/components/SshHostSettings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSsh } from "@/hooks/useSsh";
import { API_ACCESS_CHANGED } from "@/lib/api-credentials";
import {
  type ApiHost,
  type ApiHostDraft,
  type ApiHostHeader,
  apiHostError,
  apiHostWarning,
  CURRENT_HOST,
  CURRENT_HOST_ID,
  deleteApiHost,
  hostHeaders,
  listApiHosts,
  readActiveHostId,
  readApiUrl,
  rememberApiHostSwitch,
  sameApiUrl,
  saveApiHost,
  writeActiveHostId,
  writeApiUrl,
} from "@/lib/api-hosts";
import { isSecretKey } from "@/lib/connection-source";
import { desktopBridge } from "@/lib/desktop-bridge";
import { defaultServerAddress, orcServerAddress, THIS_SERVER } from "@/lib/host-labels";
import { cn } from "@/lib/utils";

const inputClass = "bg-surface-highest border-outline-variant text-on-surface font-body text-sm";

/**
 * One list for both host kinds: the ORC server this dashboard talks to (API) and the host where
 * its work runs (SSH). A server that both serves the dashboard and runs work shows both badges.
 */
export function HostsSettings({
  expandExecution = false,
  expandConnection = false,
}: {
  /** Legacy `?settingsSection=execution` links open the execution host editor. */
  expandExecution?: boolean;
  /** The desktop connection window opens the ORC server editor. */
  expandConnection?: boolean;
}) {
  const desktop = desktopBridge()?.connection;
  const execution = <ExecutionHostRow openOn={expandExecution} />;
  return (
    <section aria-labelledby="hosts-title" data-testid="hosts-settings">
      <h2 id="hosts-title" className="mb-1 hidden text-base font-medium md:block">
        Hosts
      </h2>
      <div className="mb-4 flex items-start gap-1">
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">
          The ORC server this dashboard talks to, and where its work runs.
        </p>
        <HelpPopover label="hosts" testId="hosts-help">
          The API rows are the ORC servers this dashboard can talk to. The SSH row is where the
          connected server runs chats, terminals and jobs: its own machine, or a host from its{" "}
          <code className="text-primary">~/.ssh/config</code>. Tokens and headers are stored in this
          browser and only sent to the address they were saved for.
        </HelpPopover>
      </div>
      {desktop ? (
        <DesktopHosts execution={execution} openOn={expandConnection} />
      ) : (
        <BrowserHosts execution={execution} />
      )}
    </section>
  );
}

function HostBadge({ kind }: { kind: "api" | "ssh" }) {
  return (
    <Badge
      variant={kind === "api" ? "secondary" : "outline"}
      data-testid={`host-badge-${kind}`}
      title={kind === "api" ? "Serves this dashboard's API" : "Runs chats, terminals and jobs"}
      className="shrink-0 font-mono text-[10px] tracking-wide"
    >
      {kind.toUpperCase()}
    </Badge>
  );
}

/** The connected server's own machine and its SSH aliases: the hosts work can actually run on. */
function ExecutionHostRow({ openOn = false }: { openOn?: boolean }) {
  const { data: ssh, error } = useSsh();
  const [open, setOpen] = useState(openOn);
  // Panels stay mounted, so a later legacy deep link still has to open the editor.
  useEffect(() => {
    if (openOn) setOpen(true);
  }, [openOn]);
  const alias = ssh?.host ?? null;
  const address = orcServerAddress();
  const title = alias ?? THIS_SERVER;
  const subtitle = error
    ? error.message
    : ssh === undefined
      ? "Loading execution host…"
      : alias
        ? "SSH alias from ~/.ssh/config on this ORC server"
        : `Runs work on this ORC server${address ? ` (${address})` : ""}, not in the browser`;

  return (
    <li data-testid="host-row-ssh" className="py-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {!alias && <HostBadge kind="api" />}
            <HostBadge kind="ssh" />
            <span className="truncate text-sm font-medium">{title}</span>
          </div>
          <div className={cn("truncate text-xs", error ? "text-error" : "text-muted-foreground")}>
            {subtitle}
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          data-testid="ssh-host-change"
          aria-expanded={open}
          aria-controls="execution-host-editor"
          onClick={() => setOpen((current) => !current)}
        >
          {open ? "Close" : "Change"}
        </Button>
      </div>
      {open && (
        <div id="execution-host-editor" className="mt-3">
          <SshHostSettings />
        </div>
      )}
    </li>
  );
}

function DesktopHosts({ execution, openOn = false }: { execution: ReactNode; openOn?: boolean }) {
  const { state, loadError, loading, retry } = useDesktopConnectionState();
  const [editing, setEditing] = useState(openOn);
  useEffect(() => {
    if (openOn) setEditing(true);
  }, [openOn]);
  const readOnly = state?.editable === false;
  // A failed status read must not hide the only control that can repair the target.
  const showEditor = editing || readOnly || (!loading && !state);
  const remote = state?.mode === "remote";
  const title = loading ? "Loading server…" : remote ? "Remote ORC server" : THIS_SERVER;
  const subtitle = loadError
    ? loadError
    : remote
      ? state?.url || "Remote address"
      : "The installation this app started";

  return (
    <div data-testid="desktop-hosts">
      <ul className="divide-y divide-border border-y border-border">
        <li data-testid="host-row-api" className="flex min-h-12 flex-wrap items-center gap-2 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <HostBadge kind="api" />
              <span className="truncate text-sm font-medium">{title}</span>
              {state?.current === "remote" && <Badge variant="secondary">Active</Badge>}
            </div>
            <div
              className={cn("truncate text-xs", loadError ? "text-error" : "text-muted-foreground")}
            >
              {subtitle}
            </div>
          </div>
          {loadError && (
            <Button
              variant="ghost"
              size="sm"
              data-testid="desktop-connection-retry"
              onClick={retry}
            >
              Retry
            </Button>
          )}
          {(state?.editable || loadError) && (
            <Button
              variant="ghost"
              size="sm"
              data-testid="desktop-connection-change"
              aria-expanded={editing}
              aria-controls="desktop-connection-editor"
              onClick={() => setEditing((current) => !current)}
            >
              {editing ? "Close" : "Change"}
            </Button>
          )}
        </li>
        {execution}
      </ul>
      {showEditor && (
        <div id="desktop-connection-editor" className="mt-4 rounded-md border border-border p-4">
          <DesktopConnectionSettings />
        </div>
      )}
    </div>
  );
}

function BrowserHosts({ execution }: { execution: ReactNode }) {
  const [hosts, setHosts] = useState<ApiHost[]>(listApiHosts);
  const [activeUrl, setActiveUrl] = useState(readApiUrl);
  const [activeId, setActiveId] = useState<string | null>(readActiveHostId);
  const [draft, setDraft] = useState<ApiHostDraft | null>(null);
  const [deleting, setDeleting] = useState<ApiHost | null>(null);
  const [testing, setTesting] = useState(false);
  const testAttempt = useRef(0);
  const [tested, setTested] = useState("");
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");

  const refresh = () => {
    setHosts(listApiHosts());
    setActiveUrl(readApiUrl());
    setActiveId(readActiveHostId());
  };

  const resetMessages = () => {
    setError("");
    setFeedback("");
    setTested("");
  };

  const activeHost =
    hosts.find((host) => host.id === activeId) ??
    hosts.find((host) => sameApiUrl(host.url, activeUrl));
  const unsaved = !activeHost && !sameApiUrl(activeUrl, CURRENT_HOST.url);
  const active = (host: ApiHost) =>
    activeHost ? host.id === activeHost.id : sameApiUrl(host.url, activeUrl);

  function switchToHost(host: ApiHost): void {
    rememberApiHostSwitch();
    writeApiUrl(host.url);
    writeActiveHostId(host.id);
    setActiveUrl(host.url);
    setActiveId(host.id);
    window.dispatchEvent(new Event(API_ACCESS_CHANGED));
  }

  async function testHost(candidate: ApiHostDraft): Promise<void> {
    const invalid = apiHostError(candidate);
    if (invalid) {
      setError(invalid);
      return;
    }
    const attempt = ++testAttempt.current;
    const stillEditing = () => attempt === testAttempt.current;
    setTesting(true);
    setError("");
    setTested("");
    try {
      const url = candidate.url.trim().replace(/\/+$/, "");
      // A stored token belongs to the saved address, so a changed address is tested without it.
      const saved = candidate.id ? hosts.find((host) => host.id === candidate.id) : undefined;
      const addressChanged = saved ? !sameApiUrl(saved.url, candidate.url) : false;
      const response = await fetch(`${url}/settings`, {
        credentials: "include",
        cache: "no-store",
        headers: hostHeaders({
          ...candidate,
          id: candidate.id ?? "draft",
          token: addressChanged ? "" : candidate.token,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!stillEditing()) return;
      if (response.status === 401) {
        setTested(
          addressChanged
            ? "Reached the server. Save the new address to send its token there, or add one."
            : "Reached the server. Add a valid access token, or sign in on its dashboard and test again.",
        );
      } else if (!response.ok) {
        setTested(`The server answered HTTP ${response.status}.`);
      } else {
        setTested("Connected. This server accepts requests.");
      }
    } catch {
      if (stillEditing())
        setError("Could not reach that server. Check the URL, the network and allowed origins.");
    } finally {
      if (stillEditing()) setTesting(false);
    }
  }

  function saveDraft(): void {
    if (!draft) return;
    const invalid = apiHostError(draft);
    if (invalid) {
      setError(invalid);
      return;
    }
    try {
      const saved = saveApiHost(draft);
      const wasNew = !draft.id;
      const wasActive = !wasNew && activeHost?.id === saved.id;
      const urlChanged = wasActive && activeHost ? !sameApiUrl(activeHost.url, saved.url) : false;
      setDraft(null);
      refresh();
      resetMessages();
      if (wasNew) {
        switchToHost(saved);
        return;
      }
      if (wasActive) {
        // Only a new address needs the gate to re-check; new credentials reach the next request.
        if (urlChanged) {
          rememberApiHostSwitch();
          writeApiUrl(saved.url);
          setActiveUrl(saved.url);
          window.dispatchEvent(new Event(API_ACCESS_CHANGED));
        }
        return;
      }
      setFeedback("Server saved.");
    } catch {
      setError("The server could not be saved in this browser.");
    }
  }

  function removeHost(host: ApiHost): void {
    const wasActive = active(host);
    setDeleting(null);
    if (!deleteApiHost(host.id)) {
      setError("The server could not be removed from this browser.");
      return;
    }
    refresh();
    resetMessages();
    if (wasActive) {
      writeApiUrl(CURRENT_HOST.url);
      writeActiveHostId(CURRENT_HOST_ID);
      window.dispatchEvent(new Event(API_ACCESS_CHANGED));
      return;
    }
    setFeedback(`${host.label} was removed.`);
  }

  const edit = (host?: ApiHost) => {
    resetMessages();
    testAttempt.current += 1;
    setTesting(false);
    setDraft(
      host
        ? { ...host, headers: host.headers.map((header) => ({ ...header })) }
        : { label: "", url: "", token: "", headers: [] },
    );
  };

  return (
    <div data-testid="browser-hosts">
      <ul className="divide-y divide-border border-y border-border">
        {unsaved && (
          <li
            data-testid="api-host-unsaved"
            className="flex min-h-12 flex-wrap items-center gap-2 py-3"
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <HostBadge kind="api" />
                <span className="truncate text-sm font-medium">Current connection</span>
                <Badge variant="outline">Not saved</Badge>
              </div>
              <div className="truncate text-xs text-muted-foreground">{activeUrl}</div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              data-testid="api-host-save-current"
              className="min-h-11 md:min-h-8"
              onClick={() =>
                edit({ ...CURRENT_HOST, id: "", label: "Saved server", url: activeUrl })
              }
            >
              Save
            </Button>
          </li>
        )}
        {hosts.map((host) => {
          const isActive = active(host);
          const address =
            host.id === CURRENT_HOST_ID ? (defaultServerAddress() ?? host.url) : host.url;
          return (
            <li
              key={host.id}
              data-testid={`api-host-${host.id}`}
              className="flex min-h-12 flex-wrap items-center gap-2 py-3"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <HostBadge kind="api" />
                  <span className="truncate text-sm font-medium">{host.label}</span>
                  {isActive && <Badge variant="secondary">Active</Badge>}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {address}
                  {host.token ? " · token saved" : ""}
                  {host.headers.length > 0
                    ? ` · ${host.headers.length} ${host.headers.length === 1 ? "header" : "headers"}`
                    : ""}
                </div>
              </div>
              {!isActive && (
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid={`api-host-use-${host.id}`}
                  className="min-h-11 md:min-h-8"
                  onClick={() => switchToHost(host)}
                >
                  Use
                </Button>
              )}
              {host.id !== CURRENT_HOST_ID && (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    data-testid={`api-host-edit-${host.id}`}
                    className="min-h-11 md:min-h-8"
                    onClick={() => edit(host)}
                  >
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Delete ${host.label}`}
                    data-testid={`api-host-delete-${host.id}`}
                    className="size-11 md:size-8"
                    onClick={() => setDeleting(host)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </>
              )}
            </li>
          );
        })}
        {execution}
        <li className="py-2">
          <Button
            variant="outline"
            data-testid="api-host-add"
            disabled={draft !== null}
            onClick={() => edit()}
          >
            <Plus className="size-4" />
            Add server
          </Button>
        </li>
        {draft && (
          <li className="py-4" data-testid="api-host-editor">
            <div className="space-y-4 rounded-md border border-border p-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-medium">{draft.id ? "Edit server" : "Add server"}</h3>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Close server editor"
                  className="size-11 md:size-8"
                  onClick={() => {
                    testAttempt.current += 1;
                    setTesting(false);
                    setDraft(null);
                    resetMessages();
                  }}
                >
                  <X className="size-4" />
                </Button>
              </div>
              <div className="space-y-2">
                <Label htmlFor="api-host-name">Name</Label>
                <Input
                  id="api-host-name"
                  data-testid="api-host-name"
                  value={draft.label}
                  placeholder="Work ORC"
                  onChange={(event) => {
                    setDraft({ ...draft, label: event.target.value });
                    resetMessages();
                  }}
                />
              </div>
              <div className="space-y-2">
                <div className="flex items-center gap-1">
                  <Label htmlFor="api-host-url">Server URL</Label>
                  <HelpPopover label="server URL" testId="api-host-url-help">
                    <code>/api</code> follows this dashboard. A remote server needs HTTPS and this
                    dashboard's origin in its Security allowed origins. Its token and headers go
                    only to this address, so a mistyped address cannot receive them before you save.
                  </HelpPopover>
                </div>
                <Input
                  id="api-host-url"
                  data-testid="api-host-url"
                  inputMode="url"
                  value={draft.url}
                  placeholder="/api or https://orc.example.com/api"
                  onChange={(event) => {
                    setDraft({ ...draft, url: event.target.value });
                    resetMessages();
                  }}
                />
                {apiHostWarning(draft) && (
                  <p data-testid="api-host-warning" className="text-xs text-tertiary">
                    {apiHostWarning(draft)}
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <div className="flex items-center gap-1">
                  <Label htmlFor="api-host-token">Access token</Label>
                  <HelpPopover label="server access token" testId="api-host-token-help">
                    Optional. Create a revocable token in the server's Security settings and it is
                    sent as a Bearer token. Leave blank to use the normal sign-in cookie.
                  </HelpPopover>
                </div>
                <TokenField
                  id="api-host-token"
                  testId="api-host-token"
                  value={draft.token}
                  placeholder="Optional revocable token"
                  onChange={(token) => {
                    setDraft({ ...draft, token });
                    resetMessages();
                  }}
                />
              </div>
              <div className="space-y-2">
                <div className="flex items-center gap-1">
                  <Label>Headers</Label>
                  <HelpPopover label="server headers" testId="api-host-headers-help">
                    Extra request headers for a reverse proxy, for example Cloudflare Access. They
                    are sent only to this server's address and stored in this browser. Values for
                    names like token, key or secret are masked in this form. Headers this dashboard
                    sets itself (such as Authorization, Content-Type, Accept or Cookie) are
                    rejected: use the token field for a bearer token.
                  </HelpPopover>
                </div>
                <HeaderFields
                  headers={draft.headers}
                  onChange={(headers) => {
                    setDraft({ ...draft, headers });
                    resetMessages();
                  }}
                />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  data-testid="api-host-test"
                  disabled={testing}
                  onClick={() => void testHost(draft)}
                >
                  {testing ? "Testing…" : "Test connection"}
                </Button>
                <Button data-testid="api-host-save" disabled={testing} onClick={saveDraft}>
                  <Save className="size-4" />
                  {draft.id ? "Save changes" : "Save and use"}
                </Button>
              </div>
              {tested && (
                <p
                  role="status"
                  data-testid="api-host-test-result"
                  className="text-sm text-muted-foreground"
                >
                  {tested}
                </p>
              )}
              {error && (
                <p role="alert" data-testid="api-host-error" className="text-sm text-error">
                  {error}
                </p>
              )}
            </div>
          </li>
        )}
        {feedback && !draft && (
          <li role="status" data-testid="api-host-feedback" className="py-2 text-sm text-secondary">
            {feedback}
          </li>
        )}
        {error && !draft && (
          <li role="alert" className="py-2 text-sm text-error">
            {error}
          </li>
        )}
      </ul>

      <ConfirmDialog
        open={deleting !== null}
        title="Delete server"
        description={`Remove ${deleting?.label ?? "this server"} from this browser? Its token and headers are deleted too.${
          deleting && active(deleting)
            ? " This dashboard goes back to the local ORC server, and that server needs its own sign-in or token."
            : ""
        }`}
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting && removeHost(deleting)}
      />
    </div>
  );
}

function TokenField({
  id,
  testId,
  value,
  placeholder,
  onChange,
}: {
  id: string;
  testId: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  const [revealed, setRevealed] = useState(false);
  return (
    <div className="flex items-center gap-1">
      <Input
        id={id}
        data-testid={testId}
        type={revealed ? "text" : "password"}
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className={`${inputClass} font-mono`}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={revealed ? "Hide access token" : "Show access token"}
        aria-pressed={revealed}
        onClick={() => setRevealed((current) => !current)}
      >
        {revealed ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </Button>
    </div>
  );
}

function HeaderFields({
  headers,
  onChange,
}: {
  headers: ApiHostHeader[];
  onChange: (headers: ApiHostHeader[]) => void;
}) {
  const update = (index: number, patch: Partial<ApiHostHeader>) =>
    onChange(headers.map((header, i) => (i === index ? { ...header, ...patch } : header)));
  return (
    <div className="space-y-2">
      {headers.map((header, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity while the name is edited
        <div key={index} className="flex flex-wrap items-center gap-1 sm:flex-nowrap">
          <Input
            aria-label={`Header name ${index + 1}`}
            data-testid={`api-host-header-name-${index}`}
            value={header.name}
            placeholder="Name"
            onChange={(event) => update(index, { name: event.target.value })}
            className={`${inputClass} font-mono sm:w-2/5`}
          />
          <Input
            aria-label={`Header value ${index + 1}`}
            data-testid={`api-host-header-value-${index}`}
            type={isSecretKey(header.name) ? "password" : "text"}
            autoComplete="off"
            spellCheck={false}
            value={header.value}
            placeholder="Value"
            onChange={(event) => update(index, { value: event.target.value })}
            className={`${inputClass} min-w-0 flex-1 font-mono`}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Remove ${header.name || `header ${index + 1}`}`}
            onClick={() => onChange(headers.filter((_, i) => i !== index))}
          >
            <X className="size-4" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        data-testid="api-host-header-add"
        onClick={() => onChange([...headers, { name: "", value: "" }])}
      >
        <Plus className="size-4" />
        Add header
      </Button>
    </div>
  );
}

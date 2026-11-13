import { CheckCircle, CircleAlert, Eye, EyeOff, Plug, Save, X } from "lucide-react";
import { useEffect, useState } from "react";
import { HelpPopover } from "@/components/HelpPopover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { isSecretKey } from "@/lib/connection-source";
import {
  type DesktopConnectionDraft,
  type DesktopConnectionMode,
  type DesktopConnectionState,
  type DesktopHeaderPair,
  desktopBridge,
} from "@/lib/desktop-bridge";

const inputClass = "bg-surface-highest border-outline-variant text-on-surface font-body text-sm";

type TestResult = { status: "ready" | "sign_in_required"; version: string };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Desktop-only server target. The remote page can read its status but not change it. */
export function DesktopConnectionSettings() {
  const bridge = desktopBridge()?.connection;
  const [state, setState] = useState<DesktopConnectionState | null>(null);
  const [mode, setMode] = useState<DesktopConnectionMode>("local");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [headers, setHeaders] = useState<DesktopHeaderPair[]>([]);
  const [clearToken, setClearToken] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<"test" | "save" | null>(null);
  const [result, setResult] = useState<TestResult | null>(null);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");

  useEffect(() => {
    if (!bridge) return;
    let active = true;
    bridge
      .state()
      .then((next) => {
        if (!active) return;
        setState(next);
        setMode(next.mode);
        setUrl(next.url);
        setHeaders(next.headers);
      })
      .catch((cause) => active && setError(message(cause)))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [bridge]);

  if (!bridge) return null;

  if (loading)
    return (
      <p role="status" data-testid="page-loading" className="text-sm text-muted-foreground">
        Loading connection…
      </p>
    );

  if (state && !state.editable)
    return (
      <div data-testid="desktop-connection" className="space-y-4">
        <p className="text-sm">
          This window shows <span className="font-medium">{state.url}</span>.
        </p>
        <p className="text-sm text-muted-foreground">
          Change the server from the local ORC dashboard. It keeps the remote address, token and
          headers in this app's data folder.
        </p>
        <Button
          data-testid="desktop-connection-local"
          variant="outline"
          onClick={() => void bridge.openLocalSettings()}
        >
          Open local connection settings
        </Button>
      </div>
    );

  const draft = (): DesktopConnectionDraft => ({
    mode,
    url,
    token,
    clear_token: clearToken,
    headers,
  });
  const validate = (): string | null => {
    if (mode === "remote" && !url.trim()) return "Enter the remote server URL.";
    return null;
  };
  const run = async (kind: "test" | "save") => {
    const invalid = validate();
    setError(invalid ?? "");
    setFeedback("");
    setResult(null);
    if (invalid) return;
    setPending(kind);
    try {
      if (kind === "test") {
        setResult(await bridge.test(draft()));
      } else {
        await bridge.save(draft());
        setFeedback("Connection saved. Reconnecting…");
      }
    } catch (cause) {
      setError(message(cause));
    } finally {
      setPending(null);
    }
  };
  const setHeader = (index: number, patch: Partial<DesktopHeaderPair>) =>
    setHeaders((current) => current.map((pair, i) => (i === index ? { ...pair, ...patch } : pair)));

  return (
    <div data-testid="desktop-connection" className="space-y-6">
      <div className="grid gap-4 lg:grid-cols-[minmax(160px,1fr)_minmax(0,2fr)]">
        <div>
          <div className="flex items-center gap-1">
            <Label htmlFor="desktop-connection-server">Server</Label>
            <HelpPopover label="desktop server" testId="desktop-connection-help">
              Local uses the ORC daemon this app started. Remote loads another ORC installation's
              dashboard and sends requests only to that address. The selection, token and headers
              are stored in this app's data folder, not the server's <code>~/.orc/config.json</code>
              .
            </HelpPopover>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {state?.current === "remote"
              ? "This window is using the remote server."
              : "This window is using the local server."}
          </p>
        </div>
        <div className="space-y-2">
          <Select
            value={mode}
            onValueChange={(value) => {
              setMode(value as DesktopConnectionMode);
              setError("");
              setFeedback("");
              setResult(null);
            }}
          >
            <SelectTrigger
              id="desktop-connection-server"
              data-testid="desktop-connection-mode"
              className={inputClass}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-surface border-outline-variant">
              <SelectItem value="local">Local (this machine)</SelectItem>
              <SelectItem value="remote">Remote server</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {mode === "remote" && (
        <>
          <div className="grid gap-4 border-t border-border pt-4 lg:grid-cols-[minmax(160px,1fr)_minmax(0,2fr)]">
            <div>
              <Label htmlFor="desktop-connection-url">Server URL</Label>
              <p className="mt-1 text-xs text-muted-foreground">The dashboard address.</p>
            </div>
            <Input
              id="desktop-connection-url"
              data-testid="desktop-connection-url"
              inputMode="url"
              value={url}
              placeholder="https://orc.example.com"
              onChange={(event) => {
                setUrl(event.target.value);
                setError("");
                setResult(null);
              }}
              className={inputClass}
            />
          </div>
          <div className="grid gap-4 border-t border-border pt-4 lg:grid-cols-[minmax(160px,1fr)_minmax(0,2fr)]">
            <div>
              <div className="flex items-center gap-1">
                <Label htmlFor="desktop-connection-token">Access token</Label>
                <HelpPopover label="access token" testId="desktop-connection-token-help">
                  Optional. A revocable token from the server's Security settings signs this window
                  in without the API secret. Leave it blank to use the normal sign-in prompt.
                </HelpPopover>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {state?.has_token ? "Saved; leave blank to keep it." : "Optional."}
              </p>
            </div>
            <div className="space-y-2">
              <TokenInput
                value={token}
                placeholder={
                  state?.has_token ? "Saved token — leave blank to keep" : "Paste a token"
                }
                onChange={(value) => {
                  setToken(value);
                  if (value) setClearToken(false);
                }}
              />
              {state?.has_token && (
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    data-testid="desktop-connection-clear-token"
                    checked={clearToken}
                    onChange={(event) => {
                      setClearToken(event.target.checked);
                      if (event.target.checked) setToken("");
                    }}
                  />
                  Remove the saved token and use sign-in
                </label>
              )}
            </div>
          </div>
          <div className="grid gap-4 border-t border-border pt-4 lg:grid-cols-[minmax(160px,1fr)_minmax(0,2fr)]">
            <div>
              <div className="flex items-center gap-1">
                <Label>Headers</Label>
                <HelpPopover label="server headers" testId="desktop-connection-headers-help">
                  Extra request headers for a reverse proxy, for example Cloudflare Access. They are
                  sent only to this server's address. Authorization is set from the token.
                </HelpPopover>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">Optional proxy headers.</p>
            </div>
            <HeadersField headers={headers} onChange={setHeaders} onEdit={setHeader} />
          </div>
        </>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {mode === "remote" && (
          <Button
            type="button"
            variant="outline"
            data-testid="desktop-connection-test"
            disabled={!!pending}
            onClick={() => void run("test")}
          >
            <Plug size={14} /> {pending === "test" ? "Testing…" : "Test connection"}
          </Button>
        )}
        <Button
          type="button"
          data-testid="desktop-connection-save"
          disabled={!!pending}
          onClick={() => void run("save")}
        >
          {feedback ? <CheckCircle size={14} /> : <Save size={14} />}
          {pending === "save"
            ? "Saving…"
            : mode === "local"
              ? "Use local server"
              : "Save and reconnect"}
        </Button>
      </div>

      {result && (
        <p
          role="status"
          data-testid="desktop-connection-result"
          className={result.status === "ready" ? "text-sm text-secondary" : "text-sm text-tertiary"}
        >
          {result.status === "ready"
            ? `Connected to ORC ${result.version}.`
            : `Reached ORC ${result.version}. Sign in on the remote dashboard, or add a token above.`}
        </p>
      )}
      {(error || feedback) && (
        <p
          role={error ? "alert" : "status"}
          data-testid="desktop-connection-feedback"
          className={error ? "flex gap-2 text-sm text-error" : "flex gap-2 text-sm text-secondary"}
        >
          {error && <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />}
          {error || feedback}
        </p>
      )}
    </div>
  );
}

function TokenInput({
  value,
  placeholder,
  onChange,
}: {
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  const [revealed, setRevealed] = useState(false);
  return (
    <div className="flex items-center gap-1">
      <Input
        id="desktop-connection-token"
        data-testid="desktop-connection-token"
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

function HeadersField({
  headers,
  onChange,
  onEdit,
}: {
  headers: DesktopHeaderPair[];
  onChange: (headers: DesktopHeaderPair[]) => void;
  onEdit: (index: number, patch: Partial<DesktopHeaderPair>) => void;
}) {
  return (
    <div className="space-y-2">
      {headers.map((pair, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity while their name is edited
        <div key={index} className="flex flex-wrap items-center gap-1 sm:flex-nowrap">
          <Input
            aria-label={`Header name ${index + 1}`}
            value={pair.name}
            placeholder="Name"
            onChange={(event) => onEdit(index, { name: event.target.value })}
            className={`${inputClass} font-mono sm:w-2/5`}
          />
          <Input
            aria-label={`Header value ${index + 1}`}
            type={isSecretKey(pair.name) ? "password" : "text"}
            autoComplete="off"
            spellCheck={false}
            value={pair.value}
            placeholder="Value"
            onChange={(event) => onEdit(index, { value: event.target.value })}
            className={`${inputClass} min-w-0 flex-1 font-mono`}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Remove ${pair.name || `header ${index + 1}`}`}
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
        data-testid="desktop-connection-header-add"
        onClick={() => onChange([...headers, { name: "", value: "" }])}
      >
        Add header
      </Button>
    </div>
  );
}

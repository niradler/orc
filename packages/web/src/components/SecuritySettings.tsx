import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import { useState } from "react";
import { api, getApiUrl } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  createAccessToken,
  endOfDateInput,
  readBrowserSession,
  signOut,
  toDateInput,
} from "@/lib/api-credentials";

const DAY = 86_400;
const today = () => Math.floor(Date.now() / 1000);
const formatDate = (unix: number) => new Date(unix * 1000).toLocaleString();

export function SecuritySettings({ active }: { active: boolean }) {
  const client = useQueryClient();
  const session = useQuery({
    queryKey: ["browser-session", getApiUrl()],
    queryFn: () => readBrowserSession(getApiUrl()),
    enabled: active,
  });
  const settings = useQuery({
    queryKey: ["security-settings"],
    queryFn: api.settings.security.get,
    enabled: active,
  });
  const [days, setDays] = useState<string | null>(null);
  const [origins, setOrigins] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () =>
      api.settings.security.save({
        session_days: Number(days ?? settings.data?.session_days),
        cors_origins: (origins ?? settings.data?.cors_origins.join("\n") ?? "")
          .split(/[\s,]+/)
          .filter(Boolean),
      }),
    onSuccess: async (saved) => {
      client.setQueryData(["security-settings"], saved);
      setDays(null);
      setOrigins(null);
      await client.invalidateQueries({ queryKey: ["browser-session"] });
    },
  });
  const [secret, setSecret] = useState("");
  const [validUntil, setValidUntil] = useState(() => toDateInput(today() + 30 * DAY));
  const [copied, setCopied] = useState(false);
  const token = useMutation({
    mutationFn: () => createAccessToken(getApiUrl(), secret, endOfDateInput(validUntil)),
    onSuccess: () => {
      setSecret("");
      setCopied(false);
    },
  });
  const loading = settings.isPending || !!settings.error || save.isPending;

  return (
    <section aria-label="Security settings" className="space-y-8">
      <div className="space-y-3">
        <h2 className="text-base font-medium">Sign-in</h2>
        {session.error && <p role="alert">{session.error.message}</p>}
        {session.data && !session.data.required && (
          <p className="text-sm text-muted-foreground" data-testid="security-session">
            This server has no API secret, so no sign-in is needed.
          </p>
        )}
        {session.data?.required && (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm" data-testid="security-session">
              {session.data.expires_at
                ? `This browser is signed in until ${formatDate(session.data.expires_at)}.`
                : "This browser is signed in with a stored credential."}
            </p>
            <Button
              variant="outline"
              data-testid="security-sign-out"
              onClick={() => void signOut(getApiUrl())}
            >
              Sign out
            </Button>
          </div>
        )}
      </div>

      <form
        className="space-y-4 border-t border-border pt-6"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <h2 className="text-base font-medium">Defaults</h2>
        {settings.error && <p role="alert">{settings.error.message}</p>}
        <div className="space-y-2">
          <Label htmlFor="security-session-days">Default sign-in lifetime (days)</Label>
          <Input
            id="security-session-days"
            data-testid="security-session-days"
            type="number"
            min={1}
            max={365}
            step={1}
            required
            className="w-32"
            disabled={loading}
            value={days ?? String(settings.data?.session_days ?? "")}
            onChange={(event) => setDays(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Suggested expiry on the sign-in screen. Anyone signing in can pick a date up to a year
            ahead.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="security-cors-origins">Allowed web UI origins</Label>
          <textarea
            id="security-cors-origins"
            data-testid="security-cors-origins"
            className="form-control min-h-20 w-full font-mono text-xs"
            placeholder="https://orc.example.com"
            disabled={loading}
            value={origins ?? settings.data?.cors_origins.join("\n") ?? ""}
            onChange={(event) => setOrigins(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            One per line. Leave empty when the web UI and API share an address. Listing an origin
            lets it call this API with the sign-in cookie, which then requires HTTPS.
          </p>
        </div>
        <Button data-testid="security-save" type="submit" disabled={loading}>
          {save.isPending ? "Saving…" : "Save security settings"}
        </Button>
        {save.error && <p role="alert">{save.error.message}</p>}
        {save.isSuccess && <p role="status">Security settings saved.</p>}
      </form>

      <form
        className="space-y-4 border-t border-border pt-6"
        onSubmit={(event) => {
          event.preventDefault();
          token.mutate();
        }}
      >
        <h2 className="text-base font-medium">API access token</h2>
        <p className="text-sm text-muted-foreground">
          Send it as <code>Authorization: Bearer &lt;token&gt;</code> from scripts and MCP clients
          instead of the API secret. Changing the API secret revokes every token.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-2">
            <Label htmlFor="security-token-secret">API secret</Label>
            <Input
              id="security-token-secret"
              data-testid="security-token-secret"
              type="password"
              autoComplete="off"
              required
              className="w-64"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="security-token-valid-until">Valid until</Label>
            <Input
              id="security-token-valid-until"
              data-testid="security-token-valid-until"
              type="date"
              required
              min={toDateInput(today())}
              max={toDateInput(today() + 364 * DAY)}
              value={validUntil}
              onChange={(event) => setValidUntil(event.target.value)}
            />
          </div>
          <Button data-testid="security-token-create" type="submit" disabled={token.isPending}>
            {token.isPending ? "Creating…" : "Create token"}
          </Button>
        </div>
        {token.error && <p role="alert">{token.error.message}</p>}
        {token.data && (
          <div className="space-y-2" data-testid="security-token-result">
            <p className="text-xs text-muted-foreground">
              Copy it now; it is not shown again. Valid until {formatDate(token.data.expires_at)}.
            </p>
            <div className="flex gap-2">
              <Input
                readOnly
                aria-label="Access token"
                data-testid="security-token-value"
                className="font-mono text-xs"
                value={token.data.token}
                onFocus={(event) => event.target.select()}
              />
              <Button
                type="button"
                variant="outline"
                aria-label="Copy token"
                onClick={() =>
                  void navigator.clipboard.writeText(token.data.token).then(() => setCopied(true))
                }
              >
                <Copy size={14} />
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          </div>
        )}
      </form>
    </section>
  );
}

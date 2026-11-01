import { CircleAlert, CircleCheck, Eye, EyeOff, LogIn, Plus, X } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { FormDialog } from "@/components/FormDialog";
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
import { Textarea } from "@/components/ui/textarea";
import {
  useAuthorizeConnection,
  useConnection,
  useSaveConnection,
  useSignOutConnection,
  useTestConnection,
} from "@/hooks/useIntegrations";
import {
  type AuthMode,
  authModesFor,
  type ConnectionDraft,
  type ConnectionType,
  connectionTypes,
  draftError,
  emptyDraft,
  hasAdvanced,
  isSecretKey,
  oauthFlowLabels,
  oauthFlows,
  type Pair,
  toDraft,
  toSource,
} from "@/lib/connection-source";

const inputClass = "bg-background border-control-border text-on-surface font-body text-sm";
const labelClass = "font-label text-sm text-muted-foreground";

/** Creates a connection (`name` null) or edits one; nothing is written until Save. */
export function ConnectionEditor({ name, onClose }: { name: string | null; onClose: () => void }) {
  const connection = useConnection(name);
  if (name === null)
    return <ConnectionForm initialName="" initial={emptyDraft} onClose={onClose} />;
  if (connection.data)
    return (
      <ConnectionForm
        initialName={name}
        initial={toDraft(connection.data.source)}
        editing
        onClose={onClose}
      />
    );
  return (
    <FormDialog open dirty={false} onClose={onClose} testId="connection-editor">
      {() => (
        <p
          role={connection.error ? "alert" : undefined}
          className={connection.error ? "text-sm text-error" : "text-sm text-muted-foreground"}
        >
          {connection.error ? connection.error.message : "Loading connection…"}
        </p>
      )}
    </FormDialog>
  );
}

function ConnectionForm({
  initialName,
  initial,
  editing = false,
  onClose,
}: {
  initialName: string;
  initial: ConnectionDraft;
  editing?: boolean;
  onClose: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [draft, setDraft] = useState(initial);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [testedKey, setTestedKey] = useState<string | null>(null);
  const save = useSaveConnection();
  const check = useTestConnection();
  const authorize = useAuthorizeConnection();
  const signOut = useSignOutConnection();
  const set = (patch: Partial<ConnectionDraft>) =>
    setDraft((current) => {
      const next = { ...current, ...patch };
      // Switching type can drop the chosen auth mode (OAuth is for remote MCP only).
      const modes = authModesFor(next.type);
      if (!modes.some((mode) => mode.value === next.authMode)) next.authMode = "none";
      return next;
    });
  const key = JSON.stringify([name, draft]);
  const dirty = name !== initialName || JSON.stringify(draft) !== JSON.stringify(initial);
  const remote = draft.type === "http" || draft.type === "sse";
  const modes = authModesFor(draft.type);
  // A result only describes the draft it was run on; any edit hides it.
  const result = testedKey === key ? check.data : undefined;
  const testError = testedKey === key ? check.error : null;

  const validate = () => {
    const error = draftError(name, draft);
    setInvalid(error);
    return !error;
  };
  const runTest = () => {
    if (!validate()) return;
    setTestedKey(key);
    check.mutate({ name, source: toSource(draft) });
  };
  const submit = (event: React.FormEvent, closeAfterSave: () => void) => {
    event.preventDefault();
    if (!validate()) return;
    save.mutate({ name, source: toSource(draft), create: !editing }, { onSuccess: closeAfterSave });
  };
  // Sign-in reads the saved entry, so the draft is saved first; the provider then returns the
  // browser to the callback page, which finishes it.
  const signIn = async (closeAfterSave: () => void) => {
    if (!validate()) return;
    try {
      if (!editing || dirty)
        await save.mutateAsync({ name, source: toSource(draft), create: !editing });
      const start = await authorize.mutateAsync(name);
      closeAfterSave();
      if (start.authorizationUrl) window.location.assign(start.authorizationUrl);
    } catch {
      // Shown from the mutation state below.
    }
  };
  const busy = save.isPending || authorize.isPending;
  const signInButton = (closeAfterSave: () => void) => (
    <Button
      type="button"
      variant="outline"
      size="sm"
      data-testid="connection-sign-in"
      disabled={busy}
      onClick={() => void signIn(closeAfterSave)}
    >
      <LogIn className="size-4" />
      {authorize.isPending ? "Signing in…" : editing && !dirty ? "Sign in" : "Save and sign in"}
    </Button>
  );

  return (
    <FormDialog open dirty={dirty} busy={busy} onClose={onClose} testId="connection-editor">
      {(requestClose, closeAfterSave) => (
        <>
          <DialogHeader>
            <DialogTitle className="font-headline text-base text-on-surface">
              {editing ? `Edit ${initialName}` : "Add connection"}
            </DialogTitle>
          </DialogHeader>
          <form noValidate onSubmit={(event) => submit(event, closeAfterSave)} className="min-h-0">
            <div className="work-form-body space-y-5">
              <TypePicker value={draft.type} onChange={(type) => set({ type })} />

              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Name *"
                  hint={
                    editing ? "Names can't change: OAuth tokens are stored under it." : undefined
                  }
                >
                  {(id) => (
                    <Input
                      id={id}
                      data-testid="connection-name"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      disabled={editing}
                      placeholder="github"
                      autoFocus={!editing}
                      className={inputClass}
                    />
                  )}
                </Field>
                <Field label="Description">
                  {(id) => (
                    <Input
                      id={id}
                      value={draft.description}
                      onChange={(event) => set({ description: event.target.value })}
                      className={inputClass}
                    />
                  )}
                </Field>
              </div>

              {remote && (
                <Field label="Server URL *">
                  {(id) => (
                    <Input
                      id={id}
                      data-testid="connection-url"
                      inputMode="url"
                      value={draft.url}
                      onChange={(event) => set({ url: event.target.value })}
                      placeholder="https://mcp.example.com/mcp"
                      className={inputClass}
                    />
                  )}
                </Field>
              )}
              {(draft.type === "openapi" || draft.type === "graphql") && (
                <Field label={draft.type === "openapi" ? "Spec URL or file *" : "Endpoint URL *"}>
                  {(id) => (
                    <Input
                      id={id}
                      data-testid="connection-source"
                      value={draft.source}
                      onChange={(event) => set({ source: event.target.value })}
                      placeholder={
                        draft.type === "openapi"
                          ? "https://api.example.com/openapi.json"
                          : "https://api.example.com/graphql"
                      }
                      className={inputClass}
                    />
                  )}
                </Field>
              )}
              {draft.type === "stdio" && (
                <>
                  <Field label="Command *">
                    {(id) => (
                      <Input
                        id={id}
                        data-testid="connection-command"
                        value={draft.command}
                        onChange={(event) => set({ command: event.target.value })}
                        placeholder="npx"
                        className={inputClass}
                      />
                    )}
                  </Field>
                  <Field label="Arguments" hint="One per line.">
                    {(id) => (
                      <Textarea
                        id={id}
                        rows={3}
                        value={draft.args}
                        onChange={(event) => set({ args: event.target.value })}
                        className={`${inputClass} font-mono`}
                      />
                    )}
                  </Field>
                  <PairsField
                    label="Environment variables"
                    pairs={draft.env}
                    onChange={(env) => set({ env })}
                  />
                </>
              )}

              {modes.length > 0 && (
                <AuthSection
                  draft={draft}
                  editing={editing}
                  set={set}
                  account={
                    <div className="flex flex-wrap items-center gap-2">
                      {signInButton(closeAfterSave)}
                      {editing && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          data-testid="connection-sign-out"
                          disabled={busy || signOut.isPending}
                          onClick={() => signOut.mutate(initialName)}
                        >
                          Sign out
                        </Button>
                      )}
                      {signOut.isSuccess && (
                        <span role="status" className="text-xs text-muted-foreground">
                          Signed out.
                        </span>
                      )}
                    </div>
                  }
                />
              )}

              <details
                className="group rounded-md border border-outline-variant"
                open={hasAdvanced(initial) || undefined}
              >
                <summary className="flex min-h-11 cursor-pointer items-center px-3 text-sm font-medium">
                  Advanced
                </summary>
                <div className="space-y-4 border-t border-outline-variant p-3">
                  {draft.type === "openapi" && (
                    <Field label="Base URL" hint="Overrides the servers listed in the spec.">
                      {(id) => (
                        <Input
                          id={id}
                          value={draft.baseUrl}
                          onChange={(event) => set({ baseUrl: event.target.value })}
                          className={inputClass}
                        />
                      )}
                    </Field>
                  )}
                  {draft.type === "stdio" ? (
                    <Field label="Working folder">
                      {(id) => (
                        <Input
                          id={id}
                          value={draft.cwd}
                          onChange={(event) => set({ cwd: event.target.value })}
                          className={inputClass}
                        />
                      )}
                    </Field>
                  ) : (
                    <PairsField
                      label="Headers"
                      pairs={draft.headers}
                      onChange={(headers) => set({ headers })}
                    />
                  )}
                  <Field label="Allowed tools" hint="One name or glob per line. Empty allows all.">
                    {(id) => (
                      <Textarea
                        id={id}
                        rows={2}
                        value={draft.allowedTools}
                        onChange={(event) => set({ allowedTools: event.target.value })}
                        className={`${inputClass} font-mono`}
                      />
                    )}
                  </Field>
                  <Field label="Disabled tools" hint="One name or glob per line.">
                    {(id) => (
                      <Textarea
                        id={id}
                        rows={2}
                        value={draft.disabledTools}
                        onChange={(event) => set({ disabledTools: event.target.value })}
                        className={`${inputClass} font-mono`}
                      />
                    )}
                  </Field>
                </div>
              </details>

              <TestResult
                pending={check.isPending && testedKey === key}
                result={result}
                error={testError}
                signIn={remote ? signInButton(closeAfterSave) : null}
              />
              {(invalid || save.error || authorize.error || signOut.error) && (
                <p role="alert" className="text-sm text-error">
                  {invalid ??
                    save.error?.message ??
                    authorize.error?.message ??
                    signOut.error?.message}
                </p>
              )}
            </div>
            <DialogFooter className="work-form-footer">
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="connection-test"
                onClick={runTest}
                disabled={check.isPending || busy}
                className="mr-auto"
              >
                {check.isPending ? "Testing…" : "Test connection"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={requestClose}
                disabled={busy}
                className="font-label text-sm text-muted-foreground"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                data-testid="connection-save"
                disabled={busy || (editing && !dirty)}
              >
                {save.isPending ? "Saving…" : editing ? "Save" : "Add connection"}
              </Button>
            </DialogFooter>
          </form>
        </>
      )}
    </FormDialog>
  );
}

/** Radio cards: two columns on a phone, one row on wider screens. */
function TypePicker({
  value,
  onChange,
}: {
  value: ConnectionType;
  onChange: (type: ConnectionType) => void;
}) {
  return (
    <fieldset>
      <legend className={`${labelClass} mb-1.5`}>Type</legend>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5" data-testid="connection-type">
        {connectionTypes.map((option) => (
          <label
            key={option.value}
            className="flex min-h-11 cursor-pointer items-center justify-center rounded-md border border-outline-variant px-2 text-center text-sm has-checked:border-primary has-checked:bg-primary/10 has-checked:font-medium has-focus-visible:ring-2 has-focus-visible:ring-ring"
          >
            <input
              type="radio"
              name="connection-type"
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
              className="sr-only"
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function AuthSection({
  draft,
  editing,
  set,
  account,
}: {
  draft: ConnectionDraft;
  editing: boolean;
  set: (patch: Partial<ConnectionDraft>) => void;
  /** Sign-in controls for the browser and device flows. */
  account: ReactNode;
}) {
  const clientCredentials = draft.oauthFlow === "client_credentials";
  return (
    <fieldset className="space-y-4">
      <legend className="mb-2 text-sm font-medium">Authentication</legend>
      <Field label="Method">
        {(id) => (
          <Select
            value={draft.authMode}
            onValueChange={(authMode) => set({ authMode: authMode as AuthMode })}
          >
            <SelectTrigger id={id} data-testid="connection-auth" className={inputClass}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-surface border-outline-variant">
              {authModesFor(draft.type).map((mode) => (
                <SelectItem key={mode.value} value={mode.value} className="text-sm">
                  {mode.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </Field>
      {draft.authMode === "token" && (
        <Field
          label="Token *"
          hint="A token or full header value. ${VAR} reads an environment variable."
        >
          {(id) => (
            <SecretInput
              id={id}
              label="Token"
              value={draft.auth}
              onChange={(auth) => set({ auth })}
            />
          )}
        </Field>
      )}
      {draft.authMode === "oauth" && (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Flow">
              {(id) => (
                <Select
                  value={draft.oauthFlow || "browser"}
                  onValueChange={(flow) =>
                    set({
                      oauthFlow: flow === "browser" ? "" : (flow as ConnectionDraft["oauthFlow"]),
                    })
                  }
                >
                  <SelectTrigger id={id} className={inputClass}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-surface border-outline-variant">
                    {oauthFlows.map((flow) => (
                      <SelectItem key={flow} value={flow} className="text-sm">
                        {oauthFlowLabels[flow]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </Field>
            <Field
              label={clientCredentials ? "Client ID *" : "Client ID"}
              hint={clientCredentials ? undefined : "Blank registers a client automatically."}
            >
              {(id) => (
                <Input
                  id={id}
                  value={draft.oauthClientId}
                  onChange={(event) => set({ oauthClientId: event.target.value })}
                  className={inputClass}
                />
              )}
            </Field>
          </div>
          {clientCredentials ? (
            <Field
              label="Client secret"
              hint={editing ? "Leave blank to keep the stored secret." : "Stored with the tokens."}
            >
              {(id) => (
                <SecretInput
                  id={id}
                  label="Client secret"
                  value={draft.oauthClientSecret}
                  onChange={(oauthClientSecret) => set({ oauthClientSecret })}
                />
              )}
            </Field>
          ) : (
            account
          )}
        </>
      )}
    </fieldset>
  );
}

function TestResult({
  pending,
  result,
  error,
  signIn,
}: {
  pending: boolean;
  result: { status: string; count: number | null; message: string | null } | undefined;
  error: Error | null;
  signIn: ReactNode;
}) {
  if (pending)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Testing connection…
      </p>
    );
  if (error)
    return (
      <p role="alert" className="text-sm text-error">
        {error.message}
      </p>
    );
  if (!result) return null;
  if (result.status === "connected")
    return (
      <p role="status" data-testid="connection-test-result" className="flex gap-2 text-sm">
        <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
        <span>
          Connected · {result.count} {result.count === 1 ? "tool" : "tools"}
        </span>
      </p>
    );
  const auth = result.status === "auth_required";
  return (
    <div
      role="alert"
      data-testid="connection-test-result"
      className={`flex gap-2 text-sm ${auth ? "" : "text-error"}`}
    >
      <CircleAlert className={`mt-0.5 size-4 shrink-0 ${auth ? "text-warning" : ""}`} aria-hidden />
      <div className="min-w-0">
        <p>{auth ? "Reachable — the server needs a sign-in." : "Couldn't connect."}</p>
        {result.message && (
          <p className="wrap-break-word text-xs text-muted-foreground">{result.message}</p>
        )}
        {auth && signIn && <div className="mt-2">{signIn}</div>}
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string | undefined;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className={labelClass}>
        {label}
      </Label>
      {children(id)}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Masked by default; the eye button shows the value so it can be checked or edited. */
function SecretInput({
  id,
  label,
  value,
  onChange,
}: {
  id?: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const [revealed, setRevealed] = useState(false);
  return (
    <div className="flex items-center gap-1">
      <Input
        id={id}
        aria-label={id ? undefined : label}
        type={revealed ? "text" : "password"}
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={`${inputClass} font-mono`}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={revealed ? `Hide ${label}` : `Show ${label}`}
        aria-pressed={revealed}
        onClick={() => setRevealed((current) => !current)}
      >
        {revealed ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </Button>
    </div>
  );
}

function PairsField({
  label,
  pairs,
  onChange,
}: {
  label: string;
  pairs: Pair[];
  onChange: (pairs: Pair[]) => void;
}) {
  const update = (index: number, patch: Partial<Pair>) =>
    onChange(pairs.map((pair, i) => (i === index ? { ...pair, ...patch } : pair)));
  return (
    <fieldset className="space-y-2">
      <legend className={`${labelClass} mb-1.5`}>{label}</legend>
      {pairs.map((pair, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity while their name is edited
        <div key={index} className="flex flex-wrap items-center gap-1 sm:flex-nowrap">
          <Input
            aria-label={`${label} name ${index + 1}`}
            value={pair.key}
            onChange={(event) => update(index, { key: event.target.value })}
            placeholder="Name"
            className={`${inputClass} font-mono sm:w-2/5`}
          />
          <div className="min-w-0 flex-1">
            {isSecretKey(pair.key) ? (
              <SecretInput
                label={`${label} value ${index + 1}`}
                value={pair.value}
                onChange={(value) => update(index, { value })}
              />
            ) : (
              <Input
                aria-label={`${label} value ${index + 1}`}
                value={pair.value}
                onChange={(event) => update(index, { value: event.target.value })}
                placeholder="Value"
                className={`${inputClass} font-mono`}
              />
            )}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Remove ${pair.key || `${label.toLowerCase()} row ${index + 1}`}`}
            onClick={() => onChange(pairs.filter((_, i) => i !== index))}
          >
            <X className="size-4" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => onChange([...pairs, { key: "", value: "" }])}
      >
        <Plus className="size-4" />
        Add {label === "Headers" ? "header" : "variable"}
      </Button>
    </fieldset>
  );
}

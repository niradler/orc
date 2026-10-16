import type { KbEmbeddingSettings, KbSettings, KbSettingsPatch } from "@orc/core/kb";
import { Download, Trash2 } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { api } from "@/api/client";
import { ConfirmDialog } from "@/components/ConfirmDialog";
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
import { Separator } from "@/components/ui/separator";
import { useInvalidateKb, useKbParsers, useKbSettings, useKbStatus } from "@/hooks/useKnowledge";

const MB = 1024 * 1024;

function size(bytes: number | null): string {
  if (bytes === null) return "";
  return bytes >= 1024 * MB
    ? `${(bytes / 1024 / MB).toFixed(1)} GB`
    : `${Math.round(bytes / MB)} MB`;
}

type Form = {
  parser: string;
  docling_enabled: boolean;
  parser_timeout_secs: string;
  max_upload_mb: string;
  usage_retention_days: string;
  provider: KbEmbeddingSettings["provider"];
  base_url: string;
  model: string;
  dimensions: string;
  api_key: string;
  clear_key: boolean;
};

function toForm(s: KbSettings): Form {
  return {
    parser: s.parser,
    docling_enabled: s.docling_enabled,
    parser_timeout_secs: String(s.parser_timeout_secs),
    max_upload_mb: String(Math.round(s.max_upload_bytes / MB)),
    usage_retention_days: String(s.usage_retention_days),
    provider: s.embedding.provider,
    base_url: s.embedding.base_url ?? "",
    model: s.embedding.model ?? "",
    dimensions: s.embedding.dimensions ? String(s.embedding.dimensions) : "",
    api_key: "",
    clear_key: false,
  };
}

const PROVIDER_HINT: Record<KbEmbeddingSettings["provider"], string> = {
  none: "Keyword search only. Add an embedding provider for semantic and hybrid search.",
  ollama: "Local embeddings from Ollama, for example nomic-embed-text at http://localhost:11434.",
  openai: "OpenAI or any OpenAI-compatible endpoint, for example text-embedding-3-small.",
};

/** Server-side knowledge settings (saved to the ORC config, not this browser). */
export function KnowledgeSettings() {
  const settings = useKbSettings();
  const parsers = useKbParsers();
  const status = useKbStatus();
  const invalidate = useInvalidateKb();
  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const [removing, setRemoving] = useState(false);
  useEffect(() => {
    if (settings.data) setForm(toForm(settings.data));
  }, [settings.data]);

  if (settings.error)
    return (
      <section>
        <h2 className="mb-1 text-base font-medium">Knowledge</h2>
        <p role="alert" className="text-sm text-error">
          {(settings.error as Error).message}
        </p>
      </section>
    );
  if (!form || !settings.data) return null;
  const s = settings.data;
  const overridden = (name: string) => s.env_overrides.includes(`ORC_KNOWLEDGE_${name}`);
  const set = (change: Partial<Form>) => {
    setSaved(false);
    setForm({ ...form, ...change });
  };
  const docling = parsers.data?.parsers.find((p) => p.id === "docling");
  const installState = parsers.data?.docling;

  async function run(action: () => Promise<unknown>): Promise<boolean> {
    setPending(true);
    setError(null);
    try {
      await action();
      await invalidate();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Request failed");
      return false;
    } finally {
      setPending(false);
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    const num = (v: string) => (v.trim() ? Number(v) : null);
    const patch: KbSettingsPatch = {
      parser: form.parser,
      docling_enabled: form.docling_enabled,
      parser_timeout_secs: Number(form.parser_timeout_secs),
      max_upload_bytes: Number(form.max_upload_mb) * MB,
      usage_retention_days: Number(form.usage_retention_days),
      embedding: {
        provider: form.provider,
        base_url: form.base_url.trim() || null,
        model: form.model.trim() || null,
        dimensions: num(form.dimensions),
        ...(form.clear_key ? { api_key: null } : form.api_key ? { api_key: form.api_key } : {}),
      },
    };
    if (await run(() => api.kb.updateSettings(patch))) setSaved(true);
  }

  return (
    <section data-testid="settings-knowledge" aria-labelledby="settings-knowledge-title">
      <h2 id="settings-knowledge-title" className="mb-1 text-base font-medium text-on-surface">
        Knowledge
      </h2>
      <p className="mb-4 text-sm text-muted-foreground">
        How ORC parses uploads and searches knowledge bases. Saved on the server in{" "}
        <code className="text-primary">~/.orc/config.json</code>; files live in{" "}
        <code className="break-all text-primary">{s.root}</code>.
      </p>
      <Separator className="mb-4 bg-outline-variant" />
      {s.env_overrides.length > 0 && (
        <p className="mb-4 text-sm text-warning" data-testid="settings-knowledge-env">
          Set by environment, these win over saved values: {s.env_overrides.join(", ")}
        </p>
      )}
      <form onSubmit={save} className="space-y-6">
        <div className="space-y-3">
          <h3 className="text-sm font-medium">Parsers</h3>
          {parsers.data?.parsers.map((p) => (
            <div
              key={p.id}
              data-testid={`settings-parser-${p.id}`}
              className="rounded-md border border-outline-variant p-3 text-sm"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{p.label}</span>
                <span className="text-xs text-outline">
                  {p.installed ? `v${p.version}` : "not installed"}
                  {p.size_bytes ? ` · ${size(p.size_bytes)}${p.installed ? "" : " download"}` : ""}
                </span>
              </div>
              <p className="mt-1 text-outline">{p.description}</p>
              <p className="mt-1 text-xs text-outline">
                Formats: {p.capabilities.formats.join(", ")}
              </p>
              {p.detail && <p className="mt-1 text-xs text-outline">{p.detail}</p>}
              {p.id === "docling" && (
                <div className="mt-3 space-y-2">
                  {installState?.state === "installing" && (
                    <div
                      role="status"
                      data-testid="settings-docling-progress"
                      className="text-xs text-outline"
                    >
                      {installState.step}
                      <pre className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap font-mono">
                        {installState.log.slice(-8).join("\n")}
                      </pre>
                    </div>
                  )}
                  {installState?.state === "failed" && (
                    <p role="alert" className="text-xs text-error">
                      {installState.error}
                    </p>
                  )}
                  {p.installed ? (
                    <div className="flex flex-wrap items-center gap-3">
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          data-testid="settings-docling-enabled"
                          checked={form.docling_enabled}
                          onChange={(e) => set({ docling_enabled: e.target.checked })}
                        />
                        Use automatically for PDFs and images
                      </label>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="text-error"
                        data-testid="settings-docling-remove"
                        onClick={() => setRemoving(true)}
                      >
                        <Trash2 size={14} />
                        Remove
                      </Button>
                    </div>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      data-testid="settings-docling-install"
                      disabled={pending || installState?.state === "installing"}
                      onClick={() => run(() => api.kb.installDocling())}
                    >
                      <Download size={14} />
                      {installState?.state === "installing"
                        ? "Installing…"
                        : `Install Docling (${size(docling?.size_bytes ?? null) || "about 2 GB"})`}
                    </Button>
                  )}
                </div>
              )}
            </div>
          ))}
          <div className="space-y-2">
            <Label htmlFor="settings-kb-parser" className="text-sm text-muted-foreground">
              Default parser
            </Label>
            <Select
              value={form.parser}
              onValueChange={(v) => set({ parser: v })}
              disabled={overridden("PARSER")}
            >
              <SelectTrigger id="settings-kb-parser" data-testid="settings-kb-parser">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">
                  Automatic: Docling for PDFs and images when enabled
                </SelectItem>
                {parsers.data?.parsers.map((p) => (
                  <SelectItem key={p.id} value={p.id} disabled={!p.installed}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-outline">
              Knowledge bases can override it. Changing parsers applies to new uploads; reparse a
              document to apply it to existing ones.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="settings-kb-timeout" className="text-sm text-muted-foreground">
                Parse timeout (s)
              </Label>
              <Input
                id="settings-kb-timeout"
                type="number"
                min={10}
                value={form.parser_timeout_secs}
                onChange={(e) => set({ parser_timeout_secs: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="settings-kb-max-upload" className="text-sm text-muted-foreground">
                Max upload (MB)
              </Label>
              <Input
                id="settings-kb-max-upload"
                type="number"
                min={1}
                value={form.max_upload_mb}
                onChange={(e) => set({ max_upload_mb: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="settings-kb-retention" className="text-sm text-muted-foreground">
                Read log (days)
              </Label>
              <Input
                id="settings-kb-retention"
                type="number"
                min={1}
                value={form.usage_retention_days}
                onChange={(e) => set({ usage_retention_days: e.target.value })}
              />
            </div>
          </div>
        </div>
        <div className="space-y-3">
          <h3 className="text-sm font-medium">Semantic search</h3>
          {status.data && (
            <p className="text-xs text-outline" data-testid="settings-embedding-status">
              {status.data.embedding.ready
                ? `Ready · ${status.data.embedding.model} · ${status.data.embedding.vector_backend}`
                : (status.data.embedding.detail ?? "Not configured")}
              {status.data.embedding.pending_chunks
                ? ` · ${status.data.embedding.pending_chunks} passages waiting`
                : ""}
            </p>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="settings-kb-provider" className="text-sm text-muted-foreground">
              Embedding provider
            </Label>
            <Select
              value={form.provider}
              onValueChange={(v) => set({ provider: v as Form["provider"] })}
              disabled={overridden("EMBEDDING_PROVIDER")}
            >
              <SelectTrigger id="settings-kb-provider" data-testid="settings-kb-provider">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                <SelectItem value="ollama">Ollama</SelectItem>
                <SelectItem value="openai">OpenAI-compatible</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-outline">{PROVIDER_HINT[form.provider]}</p>
          </div>
          {form.provider !== "none" && (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="settings-kb-model" className="text-sm text-muted-foreground">
                    Model
                  </Label>
                  <Input
                    id="settings-kb-model"
                    data-testid="settings-kb-model"
                    value={form.model}
                    disabled={overridden("EMBEDDING_MODEL")}
                    onChange={(e) => set({ model: e.target.value })}
                    placeholder={
                      form.provider === "ollama" ? "nomic-embed-text" : "text-embedding-3-small"
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="settings-kb-dimensions" className="text-sm text-muted-foreground">
                    Dimensions
                  </Label>
                  <Input
                    id="settings-kb-dimensions"
                    type="number"
                    value={form.dimensions}
                    onChange={(e) => set({ dimensions: e.target.value })}
                    placeholder="Model default"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="settings-kb-base-url" className="text-sm text-muted-foreground">
                  Base URL
                </Label>
                <Input
                  id="settings-kb-base-url"
                  data-testid="settings-kb-base-url"
                  value={form.base_url}
                  disabled={overridden("EMBEDDING_URL")}
                  onChange={(e) => set({ base_url: e.target.value })}
                  placeholder={
                    form.provider === "ollama"
                      ? "http://localhost:11434"
                      : "https://api.openai.com/v1"
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="settings-kb-api-key" className="text-sm text-muted-foreground">
                  {form.provider === "ollama" ? "Token (hosted or proxied Ollama)" : "API key"}
                </Label>
                <Input
                  id="settings-kb-api-key"
                  type="password"
                  autoComplete="off"
                  data-testid="settings-kb-api-key"
                  value={form.api_key}
                  disabled={form.clear_key || overridden("EMBEDDING_API_KEY")}
                  onChange={(e) => set({ api_key: e.target.value })}
                  placeholder={s.embedding.api_key_set ? "Saved. Type to replace" : "Not set"}
                />
                {s.embedding.api_key_set && (
                  <label className="flex items-center gap-2 text-xs text-outline">
                    <input
                      type="checkbox"
                      data-testid="settings-kb-api-key-clear"
                      checked={form.clear_key}
                      onChange={(e) => set({ clear_key: e.target.checked, api_key: "" })}
                    />
                    Remove the saved key
                  </label>
                )}
                <p className="text-xs text-outline">
                  Stored encrypted with the key in <code>~/.orc/secret.key</code> and never sent
                  back to the browser. Sent as a bearer token to the base URL.
                </p>
              </div>
              <p className="text-xs text-outline">
                Changing the model re-embeds every passage in the background; keyword search keeps
                working meanwhile.
              </p>
            </>
          )}
        </div>
        {error && (
          <p role="alert" data-testid="settings-knowledge-error" className="text-sm text-error">
            {error}
          </p>
        )}
        <div className="flex items-center gap-3">
          <Button type="submit" data-testid="settings-knowledge-save" disabled={pending}>
            Save knowledge settings
          </Button>
          {saved && (
            <span role="status" className="text-sm text-muted-foreground">
              Saved
            </span>
          )}
        </div>
      </form>
      <ConfirmDialog
        open={removing}
        title="Remove Docling"
        description="Deletes the Docling runtime and models from this machine. Documents it parsed keep their text; reparse them to use the basic parser."
        confirmLabel="Remove"
        isPending={pending}
        onCancel={() => setRemoving(false)}
        onConfirm={async () => {
          setRemoving(false);
          await run(() => api.kb.uninstallDocling());
        }}
      />
    </section>
  );
}

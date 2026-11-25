import {
  PROJECT_SECRET_NAME_REGEX,
  type ProjectSecretCheck,
  type ProjectSecretCheckResult,
  type ProjectSecretMetadata,
} from "@orc/core/project-secrets";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  CircleAlert,
  CircleCheck,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/api/client";
import { ConfirmDialog } from "@/components/ConfirmDialog";
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
import { Textarea } from "@/components/ui/textarea";
import { useProjects } from "@/hooks/useProjects";
import { formatSecretLastUsed } from "@/lib/secret-ui";

type CheckMode = "none" | "http" | "command";

type EditorState = {
  mode: "create" | "rotate";
  name: string;
  value: string;
  description: string;
  checkMode: CheckMode;
  httpUrl: string;
  httpMethod: "GET" | "HEAD" | "POST";
  httpHeader: string;
  httpPrefix: string;
  commandScript: string;
  commandEnvName: string;
};

function emptyEditor(): EditorState {
  return {
    mode: "create",
    name: "",
    value: "",
    description: "",
    checkMode: "none",
    httpUrl: "",
    httpMethod: "GET",
    httpHeader: "Authorization",
    httpPrefix: "Bearer ",
    commandScript: "",
    commandEnvName: "ORC_SECRET_VALUE",
  };
}

function editorForSecret(secret: ProjectSecretMetadata): EditorState {
  const check = secret.check;
  return {
    mode: "rotate",
    name: secret.name,
    value: "",
    description: secret.description ?? "",
    checkMode: check ? check.type : "none",
    httpUrl: check?.type === "http" ? check.url : "",
    httpMethod: check?.type === "http" ? check.method : "GET",
    httpHeader: check?.type === "http" ? check.header_name : "Authorization",
    httpPrefix: check?.type === "http" ? check.value_prefix : "Bearer ",
    commandScript: check?.type === "command" ? check.script : "",
    commandEnvName: check?.type === "command" ? check.env_name : "ORC_SECRET_VALUE",
  };
}

function buildCheck(editor: EditorState): ProjectSecretCheck | null {
  if (editor.checkMode === "http") {
    return {
      type: "http",
      url: editor.httpUrl.trim(),
      method: editor.httpMethod,
      header_name: editor.httpHeader.trim() || "Authorization",
      value_prefix: editor.httpPrefix,
      timeout_seconds: 10,
    };
  }
  if (editor.checkMode === "command") {
    return {
      type: "command",
      script: editor.commandScript.trim(),
      env_name: editor.commandEnvName.trim() || "ORC_SECRET_VALUE",
      timeout_seconds: 15,
    };
  }
  return null;
}

export function ProjectSecretsSettings({
  projectId: fixedProjectId,
  active = true,
  embedded = false,
}: {
  projectId?: string;
  active?: boolean;
  embedded?: boolean;
}) {
  const projectsQuery = useProjects();
  const projects = projectsQuery.data ?? [];
  const [selectedProjectId, setSelectedProjectId] = useState<string>(fixedProjectId ?? "");
  const effectiveProjectId = fixedProjectId ?? (selectedProjectId || projects[0]?.id || "");

  useEffect(() => {
    if (!fixedProjectId && !selectedProjectId && projects[0]?.id) {
      setSelectedProjectId(projects[0].id);
    }
  }, [fixedProjectId, selectedProjectId, projects]);

  const client = useQueryClient();
  const secretsQuery = useQuery({
    queryKey: ["project-secrets", effectiveProjectId],
    queryFn: () => api.projectSecrets.list(effectiveProjectId),
    enabled: active && Boolean(effectiveProjectId),
  });
  const secrets = secretsQuery.data?.secrets ?? [];

  const [editor, setEditor] = useState<EditorState | null>(null);
  const [showValue, setShowValue] = useState(false);
  const [copiedName, setCopiedName] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ProjectSecretMetadata | null>(null);
  const [checkResults, setCheckResults] = useState<Record<string, ProjectSecretCheckResult>>({});
  const [checkingName, setCheckingName] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const saveMutation = useMutation({
    mutationFn: async (draft: EditorState) => {
      const check = buildCheck(draft);
      if (draft.mode === "create") {
        return api.projectSecrets.upsert(effectiveProjectId, {
          name: draft.name.trim(),
          value: draft.value,
          description: draft.description.trim() || null,
          check,
        });
      }
      return api.projectSecrets.rotate(effectiveProjectId, draft.name, {
        ...(draft.value ? { value: draft.value } : {}),
        description: draft.description.trim() || null,
        check,
      });
    },
    onSuccess: () => {
      setEditor(null);
      setShowValue(false);
      setFormError(null);
      void client.invalidateQueries({ queryKey: ["project-secrets", effectiveProjectId] });
    },
    onError: (err) => {
      setFormError(err instanceof Error ? err.message : "Could not save secret.");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (name: string) => api.projectSecrets.delete(effectiveProjectId, name),
    onSuccess: (_data, name) => {
      setDeleting(null);
      setCheckResults((prev) => {
        const next = { ...prev };
        delete next[name];
        return next;
      });
      if (editor?.name === name) setEditor(null);
      void client.invalidateQueries({ queryKey: ["project-secrets", effectiveProjectId] });
    },
  });

  const checkMutation = useMutation({
    mutationFn: (name: string) => api.projectSecrets.check(effectiveProjectId, name),
    onMutate: (name) => setCheckingName(name),
    onSuccess: (result, name) => {
      setCheckResults((prev) => ({ ...prev, [name]: result }));
      void client.invalidateQueries({ queryKey: ["project-secrets", effectiveProjectId] });
    },
    onError: (err, name) => {
      setCheckResults((prev) => ({
        ...prev,
        [name]: {
          ok: false,
          reference: `project/${name}`,
          mode: "stored",
          status: null,
          message: err instanceof Error ? err.message : "Check failed.",
          checked_at: new Date().toISOString(),
        },
      }));
    },
    onSettled: () => setCheckingName(null),
  });

  function copyReference(secret: ProjectSecretMetadata) {
    void navigator.clipboard
      ?.writeText(secret.reference)
      .then(() => {
        setCopiedName(secret.name);
        setTimeout(() => setCopiedName((prev) => (prev === secret.name ? null : prev)), 2000);
      })
      .catch(() => {});
  }

  function submitEditor(event?: React.FormEvent) {
    event?.preventDefault();
    if (!editor) return;
    setFormError(null);
    const trimmedName = editor.name.trim();
    if (!PROJECT_SECRET_NAME_REGEX.test(trimmedName)) {
      setFormError("Secret name must start with a letter or number (letters, numbers, ., _, -).");
      return;
    }
    if (editor.mode === "create" && !editor.value) {
      setFormError("Enter a secret value.");
      return;
    }
    if (editor.checkMode === "http" && !editor.httpUrl.trim()) {
      setFormError("Enter an HTTP(S) validation URL or switch check mode to None.");
      return;
    }
    if (editor.checkMode === "command" && !editor.commandScript.trim()) {
      setFormError("Enter a validation command script or switch check mode to None.");
      return;
    }
    saveMutation.mutate(editor);
  }

  return (
    <section
      aria-label="Project secrets"
      data-testid="project-secrets-settings"
      className={embedded ? "space-y-4 md:col-span-2" : "space-y-5"}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <h2 className="text-base font-medium">Project secrets</h2>
          {effectiveProjectId && (
            <span data-testid="project-secrets-count" className="text-xs text-muted-foreground">
              ({secrets.length})
            </span>
          )}
          <HelpPopover label="Project secrets" testId="project-secrets-help">
            Encrypted at rest with your machine key and referenced as{" "}
            <code>project/&lt;name&gt;</code> in jobs and terminals. Saved values are write-only and
            never shown again.
          </HelpPopover>
        </div>
        {effectiveProjectId && !editor && (
          <Button
            type="button"
            size="sm"
            data-testid="project-secret-add"
            className="min-h-11 sm:min-h-8 [@media(pointer:coarse)]:min-h-11"
            onClick={() => {
              setFormError(null);
              setShowValue(false);
              setEditor(emptyEditor());
            }}
          >
            <Plus size={14} /> Add secret
          </Button>
        )}
      </div>

      {!fixedProjectId && (
        <div className="max-w-xs space-y-1.5">
          <Label htmlFor="project-secrets-project-select">Project</Label>
          {projects.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="project-secrets-no-projects">
              Create a project first to store project-scoped secrets.
            </p>
          ) : (
            <Select
              value={effectiveProjectId}
              onValueChange={(value) => {
                setSelectedProjectId(value);
                setEditor(null);
                setCheckResults({});
              }}
            >
              <SelectTrigger
                id="project-secrets-project-select"
                data-testid="project-secrets-project-select"
                className="min-h-11 sm:min-h-8 [@media(pointer:coarse)]:min-h-11"
              >
                <SelectValue placeholder="Select a project" />
              </SelectTrigger>
              <SelectContent>
                {projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      )}

      {editor && effectiveProjectId && (
        <fieldset
          data-testid="project-secret-editor"
          aria-label={editor.mode === "create" ? "Add project secret" : `Rotate ${editor.name}`}
          onKeyDown={(event) => {
            if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
              event.preventDefault();
              submitEditor();
            }
          }}
          className="space-y-3 rounded-md border border-border bg-surface p-4"
        >
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-medium">
              {editor.mode === "create" ? "Add project secret" : `Rotate ${editor.name}`}
            </h3>
            {editor.name.trim() && (
              <code className="text-xs font-mono text-muted-foreground break-all">
                project/{editor.name.trim()}
              </code>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="project-secret-name">Name</Label>
              <Input
                id="project-secret-name"
                data-testid="project-secret-name-input"
                value={editor.name}
                disabled={editor.mode === "rotate" || saveMutation.isPending}
                placeholder="openai-key"
                maxLength={64}
                className="min-h-11 font-mono text-base sm:min-h-8 sm:text-sm [@media(pointer:coarse)]:min-h-11"
                onChange={(event) => setEditor({ ...editor, name: event.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="project-secret-value">
                {editor.mode === "create" ? "Value *" : "New value (leave blank to keep current)"}
              </Label>
              <div className="flex items-center gap-1">
                <Input
                  id="project-secret-value"
                  data-testid="project-secret-value-input"
                  type={showValue ? "text" : "password"}
                  autoComplete="new-password"
                  value={editor.value}
                  disabled={saveMutation.isPending}
                  placeholder={editor.mode === "rotate" ? "Enter new secret value" : "Secret value"}
                  maxLength={16000}
                  className="min-h-11 min-w-0 flex-1 font-mono text-base sm:min-h-8 sm:text-sm [@media(pointer:coarse)]:min-h-11"
                  onChange={(event) => setEditor({ ...editor, value: event.target.value })}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  data-testid="project-secret-value-toggle"
                  aria-label={showValue ? "Hide secret value" : "Show secret value"}
                  aria-pressed={showValue}
                  className="min-h-11 min-w-11 shrink-0 sm:min-h-8 sm:min-w-8 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
                  onClick={() => setShowValue((prev) => !prev)}
                >
                  {showValue ? <EyeOff size={15} /> : <Eye size={15} />}
                </Button>
              </div>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="project-secret-description">Description (optional)</Label>
            <Input
              id="project-secret-description"
              data-testid="project-secret-description-input"
              value={editor.description}
              disabled={saveMutation.isPending}
              placeholder="Used by CI and review jobs"
              maxLength={500}
              className="min-h-11 text-base sm:min-h-8 sm:text-sm [@media(pointer:coarse)]:min-h-11"
              onChange={(event) => setEditor({ ...editor, description: event.target.value })}
            />
          </div>

          <details
            data-testid="project-secret-check-config"
            className="rounded-md border border-border px-3 py-2"
            open={editor.checkMode !== "none"}
          >
            <summary className="min-h-8 cursor-pointer py-1 text-xs font-medium text-muted-foreground">
              Validation check (optional)
            </summary>
            <div className="mt-2 space-y-3">
              <div className="flex flex-wrap gap-2">
                {(["none", "http", "command"] as const).map((mode) => (
                  <Button
                    key={mode}
                    type="button"
                    size="sm"
                    variant={editor.checkMode === mode ? "secondary" : "outline"}
                    data-testid={`project-secret-check-mode-${mode}`}
                    className="min-h-11 sm:min-h-8 [@media(pointer:coarse)]:min-h-11"
                    onClick={() => setEditor({ ...editor, checkMode: mode })}
                  >
                    {mode === "none" ? "Stored only" : mode === "http" ? "HTTP request" : "Command"}
                  </Button>
                ))}
              </div>
              {editor.checkMode === "http" && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1 sm:col-span-2">
                    <Label htmlFor="project-secret-check-url">URL</Label>
                    <Input
                      id="project-secret-check-url"
                      data-testid="project-secret-check-url"
                      value={editor.httpUrl}
                      placeholder="https://api.example.com/v1/models"
                      className="min-h-11 font-mono text-base sm:min-h-8 sm:text-sm [@media(pointer:coarse)]:min-h-11"
                      onChange={(event) => setEditor({ ...editor, httpUrl: event.target.value })}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="project-secret-check-header">Header name</Label>
                    <Input
                      id="project-secret-check-header"
                      value={editor.httpHeader}
                      placeholder="Authorization"
                      className="min-h-11 font-mono text-base sm:min-h-8 sm:text-sm [@media(pointer:coarse)]:min-h-11"
                      onChange={(event) => setEditor({ ...editor, httpHeader: event.target.value })}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="project-secret-check-prefix">Value prefix</Label>
                    <Input
                      id="project-secret-check-prefix"
                      value={editor.httpPrefix}
                      placeholder="Bearer "
                      className="min-h-11 font-mono text-base sm:min-h-8 sm:text-sm [@media(pointer:coarse)]:min-h-11"
                      onChange={(event) => setEditor({ ...editor, httpPrefix: event.target.value })}
                    />
                  </div>
                </div>
              )}
              {editor.checkMode === "command" && (
                <div className="space-y-2">
                  <div className="space-y-1">
                    <Label htmlFor="project-secret-check-env">Environment variable name</Label>
                    <Input
                      id="project-secret-check-env"
                      value={editor.commandEnvName}
                      placeholder="ORC_SECRET_VALUE"
                      className="min-h-11 font-mono text-base sm:min-h-8 sm:text-sm [@media(pointer:coarse)]:min-h-11"
                      onChange={(event) =>
                        setEditor({ ...editor, commandEnvName: event.target.value })
                      }
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="project-secret-check-script">Validation script</Label>
                    <Textarea
                      id="project-secret-check-script"
                      rows={2}
                      value={editor.commandScript}
                      placeholder='test -n "$ORC_SECRET_VALUE"'
                      className="font-mono text-base sm:text-sm"
                      onChange={(event) =>
                        setEditor({ ...editor, commandScript: event.target.value })
                      }
                    />
                  </div>
                </div>
              )}
            </div>
          </details>

          {formError && (
            <p role="alert" data-testid="project-secret-error" className="text-sm text-error">
              {formError}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              data-testid="project-secret-save"
              className="min-h-11 sm:min-h-8 [@media(pointer:coarse)]:min-h-11"
              disabled={saveMutation.isPending}
              onClick={() => submitEditor()}
            >
              {saveMutation.isPending
                ? "Saving…"
                : editor.mode === "create"
                  ? "Save secret"
                  : "Save rotation"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              data-testid="project-secret-cancel"
              className="min-h-11 sm:min-h-8 [@media(pointer:coarse)]:min-h-11"
              disabled={saveMutation.isPending}
              onClick={() => {
                setEditor(null);
                setShowValue(false);
                setFormError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </fieldset>
      )}

      {secretsQuery.error && (
        <p role="alert" className="text-sm text-error">
          {secretsQuery.error instanceof Error
            ? secretsQuery.error.message
            : "Could not load project secrets."}
        </p>
      )}

      {effectiveProjectId && !secretsQuery.isPending && secrets.length === 0 && !editor && (
        <div
          data-testid="project-secrets-empty"
          className="border-t border-border py-6 text-sm text-muted-foreground"
        >
          No secrets stored for this project yet. Add one here or choose{" "}
          <strong>Save to project secrets</strong> when answering a secret request.
        </div>
      )}

      {secrets.length > 0 && (
        <ul
          data-testid="project-secrets-list"
          className="divide-y divide-border border-y border-border"
        >
          {secrets.map((secret) => {
            const checkResult = checkResults[secret.name];
            const isChecking = checkingName === secret.name;
            return (
              <li
                key={secret.id}
                data-testid={`project-secret-row-${secret.name}`}
                className="min-w-0 py-3"
              >
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <KeyRound
                        size={14}
                        aria-hidden="true"
                        className="shrink-0 text-muted-foreground"
                      />
                      <span className="font-mono text-sm font-medium text-on-surface break-all">
                        {secret.name}
                      </span>
                      <code className="rounded-sm bg-surface px-1.5 py-0.5 font-mono text-xs text-muted-foreground break-all">
                        {secret.reference}
                      </code>
                    </div>
                    {secret.description && (
                      <p className="text-xs text-muted-foreground wrap-anywhere">
                        {secret.description}
                      </p>
                    )}
                    <p
                      data-testid={`project-secret-meta-${secret.name}`}
                      className="text-xs text-muted-foreground"
                    >
                      {formatSecretLastUsed(secret.last_used_at)}
                      {secret.check ? ` · Check: ${secret.check.type}` : ""}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-0.5 sm:gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      data-testid={`project-secret-copy-${secret.name}`}
                      className="min-h-11 px-2 sm:min-h-8 sm:px-2.5 [@media(pointer:coarse)]:min-h-11"
                      onClick={() => copyReference(secret)}
                    >
                      {copiedName === secret.name ? <Check size={14} /> : <Copy size={14} />}
                      {copiedName === secret.name ? "Copied" : "Copy ref"}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      data-testid={`project-secret-check-${secret.name}`}
                      disabled={isChecking}
                      className="min-h-11 px-2 sm:min-h-8 sm:px-2.5 [@media(pointer:coarse)]:min-h-11"
                      onClick={() => checkMutation.mutate(secret.name)}
                    >
                      <ShieldCheck size={14} />
                      {isChecking ? "Checking…" : "Check"}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      data-testid={`project-secret-rotate-${secret.name}`}
                      className="min-h-11 px-2 sm:min-h-8 sm:px-2.5 [@media(pointer:coarse)]:min-h-11"
                      onClick={() => {
                        setFormError(null);
                        setShowValue(false);
                        setEditor(editorForSecret(secret));
                      }}
                    >
                      <RefreshCw size={14} />
                      Rotate
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      data-testid={`project-secret-delete-${secret.name}`}
                      aria-label={`Delete ${secret.name}`}
                      className="min-h-11 px-2 sm:min-h-8 sm:px-2.5 [@media(pointer:coarse)]:min-h-11"
                      onClick={() => setDeleting(secret)}
                    >
                      <Trash2 size={14} />
                      Delete
                    </Button>
                  </div>
                </div>
                {checkResult && (
                  <p
                    role="status"
                    data-testid={`project-secret-check-result-${secret.name}`}
                    className={`mt-2 flex items-center gap-1.5 text-xs ${
                      checkResult.ok ? "text-secondary" : "text-error"
                    }`}
                  >
                    {checkResult.ok ? (
                      <CircleCheck size={13} aria-hidden="true" className="shrink-0" />
                    ) : (
                      <CircleAlert size={13} aria-hidden="true" className="shrink-0" />
                    )}
                    <span className="wrap-anywhere">{checkResult.message}</span>
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {deleting && (
        <ConfirmDialog
          open={Boolean(deleting)}
          title={`Delete secret ${deleting.name}?`}
          description={`Future jobs and launches referencing ${deleting.reference} will fail until a new secret with this name is stored.`}
          confirmLabel="Delete secret"
          variant="destructive"
          isPending={deleteMutation.isPending}
          onConfirm={() => deleteMutation.mutate(deleting.name)}
          onCancel={() => setDeleting(null)}
        />
      )}
    </section>
  );
}

import type { HumanRequest } from "@orc/core/human-requests";
import { PROJECT_SECRET_NAME_REGEX } from "@orc/core/project-secrets";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, ClipboardPaste, Copy, ExternalLink, Eye, EyeOff, Lock } from "lucide-react";
import { type CSSProperties, type ReactNode, useState } from "react";
import { ApiError, api } from "@/api/client";
import { HelpPopover } from "@/components/HelpPopover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { initialSecretReferenceNames, secretAutocompleteHint } from "@/lib/secret-ui";

export type SecretRequestDraft = {
  values: Record<string, string>;
  saveToProject: boolean;
  referenceNames: Record<string, string>;
};

const MASKED_TEXTAREA_STYLE = { WebkitTextSecurity: "disc" } as CSSProperties;

export function SecretRequestForm({
  request,
  actions,
  draft,
  onDraftChange,
}: {
  request: HumanRequest;
  actions?: ReactNode;
  draft?: SecretRequestDraft;
  onDraftChange?: (update: Partial<SecretRequestDraft>) => void;
}) {
  const fields = request.input.fields ?? [];
  const [localDraft, setLocalDraft] = useState<SecretRequestDraft>(() => ({
    values: {},
    saveToProject: Boolean(request.input.save_to_project && request.input.project_id),
    referenceNames: initialSecretReferenceNames(fields),
  }));
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [pasteNotice, setPasteNotice] = useState<string | null>(null);
  const currentDraft = draft ?? localDraft;
  const { values, saveToProject, referenceNames } = currentDraft;
  const updateDraft = (update: Partial<SecretRequestDraft>) =>
    onDraftChange ? onDraftChange(update) : setLocalDraft((prev) => ({ ...prev, ...update }));

  const setFieldValue = (key: string, nextValue: string) =>
    updateDraft({ values: { ...values, [key]: nextValue } });
  const setRefName = (key: string, nextName: string) =>
    updateDraft({ referenceNames: { ...referenceNames, [key]: nextName } });

  const client = useQueryClient();
  const submit = useMutation({
    mutationFn: async () => {
      const submittedValues: Record<string, string> = {};
      const submittedRefs: Record<string, string> = {};
      for (const field of fields) {
        const val = values[field.key] ?? "";
        if (val.length > 0) {
          submittedValues[field.key] = val;
          if (saveToProject && request.input.project_id) {
            submittedRefs[field.key] = (referenceNames[field.key] ?? "").trim();
          }
        }
      }
      updateDraft({ values: {} });
      setRevealed({});
      return api.humanRequests.respond(request.id, request.version, {
        kind: "secret",
        values: submittedValues,
        save_to_project: Boolean(saveToProject && request.input.project_id),
        ...(saveToProject && request.input.project_id ? { reference_names: submittedRefs } : {}),
      });
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ["human-requests"] });
      void client.invalidateQueries({ queryKey: ["project-secrets"] });
    },
  });

  const pending = request.status === "pending" && !submit.isPending;
  const hasAnyValue = fields.some((field) => (values[field.key] ?? "").length > 0);
  const missingRequired = fields.some(
    (field) => field.required && (values[field.key] ?? "").length === 0,
  );
  const invalidRefName =
    saveToProject &&
    Boolean(request.input.project_id) &&
    fields.some((field) => {
      if ((values[field.key] ?? "").length === 0) return false;
      return !PROJECT_SECRET_NAME_REGEX.test((referenceNames[field.key] ?? "").trim());
    });

  async function copyText(id: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId((prev) => (prev === id ? null : prev)), 2000);
    } catch {}
  }

  async function pasteField(key: string) {
    setPasteNotice(null);
    if (!navigator.clipboard?.readText) {
      setPasteNotice("Clipboard read is unavailable here. Paste directly into the field.");
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      if (text) setFieldValue(key, text);
    } catch {
      setPasteNotice("Browser blocked clipboard read. Paste directly into the field.");
    }
  }

  if (request.response?.kind === "secret") {
    const refs = request.response.references ? Object.entries(request.response.references) : [];
    return (
      <div data-testid="secret-receipt" className="space-y-2 text-sm">
        <div className="flex items-center gap-1.5 text-secondary">
          <Lock size={14} aria-hidden="true" className="shrink-0" />
          <span>
            {request.response.stored
              ? refs.length === 1
                ? `Saved as project secret ${refs[0]?.[1]?.replace(/^project\//, "") ?? ""}`
                : "Saved to project secrets"
              : "Delivered to the agent"}
          </span>
        </div>
        {request.response.stored && refs.length > 0 ? (
          <ul className="space-y-1">
            {refs.map(([key, ref]) => (
              <li
                key={key}
                className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
              >
                <span className="font-mono text-on-surface">{key}</span>
                <span>→</span>
                <code
                  data-testid={`secret-receipt-ref-${key}`}
                  className="rounded-sm bg-surface px-1.5 py-0.5 font-mono text-on-surface break-all"
                >
                  {ref}
                </code>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  data-testid={`secret-receipt-copy-${key}`}
                  className="min-h-11 sm:min-h-7 [@media(pointer:coarse)]:min-h-11"
                  onClick={() => void copyText(`ref-${key}`, ref)}
                >
                  {copiedId === `ref-${key}` ? <Check size={13} /> : <Copy size={13} />}
                  {copiedId === `ref-${key}` ? "Copied" : "Copy reference"}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">
            Fields provided:{" "}
            <span className="font-mono">{request.response.delivered_fields.join(", ")}</span>{" "}
            (values hidden)
          </p>
        )}
      </div>
    );
  }

  return (
    <div data-testid="secret-request-form" className="min-w-0 space-y-3">
      {pending && (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (pending && hasAnyValue && !missingRequired && !invalidRefName) submit.mutate();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            {fields.map((field) => {
              const isRevealed = Boolean(revealed[field.key]);
              const inputId = `secret-${request.id}-${field.key}`;
              const helpId = field.description
                ? `secret-help-${request.id}-${field.key}`
                : undefined;
              return (
                <div
                  key={field.key}
                  className={`flex min-w-0 flex-col justify-between gap-1.5 ${field.multiline || fields.length === 1 ? "sm:col-span-2" : ""}`}
                >
                  <div className="min-w-0 space-y-1.5">
                    <label htmlFor={inputId} className="block text-xs font-medium">
                      <span className="flex flex-wrap items-baseline gap-x-2">
                        <span>
                          {field.label}
                          {field.required ? " *" : " (optional)"}
                        </span>
                        <code
                          data-testid={`secret-field-key-${field.key}`}
                          className="break-all font-mono text-xs font-normal text-muted-foreground"
                        >
                          {field.key}
                        </code>
                      </span>
                    </label>
                    {field.description && (
                      <p id={helpId} className="text-xs text-muted-foreground wrap-anywhere">
                        {field.description}
                      </p>
                    )}
                    {field.link && (
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <a
                            href={field.link}
                            target="_blank"
                            rel="noopener noreferrer"
                            data-testid={`secret-link-${field.key}`}
                            className="inline-flex min-h-11 items-center gap-1 rounded-md border border-control-border px-2.5 text-xs font-medium text-on-surface hover:bg-surface sm:min-h-7 [@media(pointer:coarse)]:min-h-11"
                          >
                            Open sign-in <ExternalLink size={12} aria-hidden="true" />
                          </a>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            data-testid={`secret-link-copy-${field.key}`}
                            className="min-h-11 sm:min-h-7 [@media(pointer:coarse)]:min-h-11"
                            onClick={() => void copyText(`link-${field.key}`, field.link ?? "")}
                          >
                            {copiedId === `link-${field.key}` ? (
                              <Check size={12} />
                            ) : (
                              <Copy size={12} />
                            )}
                            {copiedId === `link-${field.key}` ? "Copied link" : "Copy link"}
                          </Button>
                        </div>
                        <p className="break-all font-mono text-xs text-muted-foreground">
                          {field.link}
                        </p>
                      </div>
                    )}
                  </div>
                  <div className="flex min-w-0 items-start gap-1">
                    {field.multiline ? (
                      <Textarea
                        id={inputId}
                        data-testid={`secret-field-${field.key}`}
                        data-masked={isRevealed ? "false" : "true"}
                        value={values[field.key] ?? ""}
                        required={field.required}
                        maxLength={16000}
                        rows={3}
                        autoComplete="off"
                        aria-describedby={helpId}
                        style={isRevealed ? undefined : MASKED_TEXTAREA_STYLE}
                        className="min-h-20 max-h-48 min-w-0 flex-1 resize-y font-mono text-base sm:text-sm"
                        onChange={(event) => setFieldValue(field.key, event.target.value)}
                      />
                    ) : (
                      <Input
                        id={inputId}
                        type={isRevealed ? "text" : "password"}
                        autoComplete={secretAutocompleteHint(field)}
                        data-testid={`secret-field-${field.key}`}
                        value={values[field.key] ?? ""}
                        required={field.required}
                        maxLength={16000}
                        aria-describedby={helpId}
                        className="min-h-11 min-w-0 flex-1 font-mono text-base sm:min-h-8 sm:text-sm [@media(pointer:coarse)]:min-h-11"
                        onChange={(event) => setFieldValue(field.key, event.target.value)}
                      />
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      data-testid={`secret-toggle-${field.key}`}
                      aria-label={isRevealed ? `Hide ${field.label}` : `Show ${field.label}`}
                      aria-pressed={isRevealed}
                      className="min-h-11 min-w-11 shrink-0 sm:min-h-8 sm:min-w-8 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
                      onClick={() =>
                        setRevealed((prev) => ({ ...prev, [field.key]: !prev[field.key] }))
                      }
                    >
                      {isRevealed ? <EyeOff size={15} /> : <Eye size={15} />}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      data-testid={`secret-paste-${field.key}`}
                      aria-label={`Paste ${field.label}`}
                      className="min-h-11 min-w-11 shrink-0 sm:min-h-8 sm:min-w-8 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
                      onClick={() => void pasteField(field.key)}
                    >
                      <ClipboardPaste size={15} />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>

          {request.input.project_id && (
            <div className="space-y-2 border-t border-border pt-2">
              <div className="flex items-center gap-1">
                <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm sm:min-h-8 [@media(pointer:coarse)]:min-h-11">
                  <input
                    type="checkbox"
                    data-testid="secret-save-to-project"
                    checked={saveToProject}
                    className="size-4 accent-primary"
                    onChange={(event) => updateDraft({ saveToProject: event.target.checked })}
                  />
                  <span>Save to project secrets</span>
                </label>
                <HelpPopover label="Save to project secrets" testId="secret-save-help">
                  Stores values encrypted under this project and sends only{" "}
                  <code>project/&lt;name&gt;</code> references to the agent.
                </HelpPopover>
              </div>
              {saveToProject && (
                <div className="grid gap-2 sm:grid-cols-2">
                  {fields.map((field) => {
                    const refId = `secret-ref-${request.id}-${field.key}`;
                    const currentName = referenceNames[field.key] ?? "";
                    const hasValue = (values[field.key] ?? "").length > 0;
                    const valid = !hasValue || PROJECT_SECRET_NAME_REGEX.test(currentName.trim());
                    return (
                      <div key={field.key} className="min-w-0 space-y-1">
                        <label htmlFor={refId} className="block text-xs text-muted-foreground">
                          Reference for{" "}
                          <span className="font-mono text-on-surface">{field.key}</span>
                        </label>
                        <div className="flex items-center gap-1">
                          <span className="shrink-0 font-mono text-xs text-muted-foreground">
                            project/
                          </span>
                          <Input
                            id={refId}
                            data-testid={`secret-ref-name-${field.key}`}
                            value={currentName}
                            maxLength={64}
                            aria-invalid={!valid}
                            className="min-h-11 min-w-0 flex-1 font-mono text-base sm:min-h-8 sm:text-sm [@media(pointer:coarse)]:min-h-11"
                            onChange={(event) => setRefName(field.key, event.target.value)}
                          />
                        </div>
                        {!valid && (
                          <p className="text-xs text-error">
                            Use letters, numbers, dots, underscores, or hyphens.
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {pasteNotice && (
            <p role="status" className="text-xs text-muted-foreground">
              {pasteNotice}
            </p>
          )}
          {submit.error && (
            <p role="alert" data-testid="secret-error" className="text-sm text-error">
              {submit.error instanceof ApiError ? submit.error.message : submit.error.message}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-1">
            <Button
              data-testid="secret-submit"
              type="submit"
              size="sm"
              className="min-h-11 sm:min-h-8 [@media(pointer:coarse)]:min-h-11"
              disabled={!pending || !hasAnyValue || missingRequired || invalidRefName}
            >
              {submit.isPending
                ? "Submitting…"
                : saveToProject && request.input.project_id
                  ? "Save & deliver"
                  : "Deliver to agent"}
            </Button>
            {actions}
            <HelpPopover label="Secret delivery" testId="secret-input-help">
              Values go to the requesting agent once and are never written to transcripts, logs, or
              notifications.
            </HelpPopover>
          </div>
        </form>
      )}
    </div>
  );
}

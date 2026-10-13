import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type PackageFull, type SkillRefContent } from "@/api/client";
import { CodeEditor } from "@/components/CodeEditor";
import { Button } from "@/components/ui/button";
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";

export function AgentPackageFiles({
  name,
  onClose,
  onUse,
  onEdit,
  onExport,
  onSource,
  busy,
  operationError,
}: {
  name: string;
  onClose: () => void;
  onUse?: () => void;
  onEdit?: () => void;
  onExport?: () => void;
  onSource?: () => void;
  busy?: boolean;
  operationError?: string;
}) {
  const [selectedPath, setPath] = useState<string>();
  const manifest = useQuery({
    queryKey: ["agent-package", name],
    queryFn: () => api.agentPackages.get(name) as Promise<PackageFull>,
  });
  const path = selectedPath ?? manifest.data?.manifestFile ?? "apm.yml";
  const file = useQuery({
    enabled: Boolean(manifest.data),
    queryKey: ["agent-package-file", name, path],
    queryFn: () => api.agentPackages.get(name, path) as Promise<SkillRefContent>,
  });
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="w-screen max-w-full sm:w-[720px] sm:max-w-[90vw]">
        <SheetHeader>
          <SheetTitle>{name}</SheetTitle>
        </SheetHeader>
        <SheetBody>
          <div className="mb-5 space-y-3">
            <p className="text-sm text-outline break-words">{manifest.data?.description}</p>
            {manifest.data && (
              <p className="text-xs text-outline">
                {manifest.data.files.filter((file) => /(^|\/)SKILL\.md$/.test(file.name)).length}{" "}
                skills ·{" "}
                {
                  manifest.data.files.filter((file) => file.name.endsWith(".instructions.md"))
                    .length
                }{" "}
                instruction files ·{" "}
                {manifest.data.files.filter((file) => file.name.endsWith(".agent.md")).length} agent
                definitions
              </p>
            )}
            {manifest.data?.warnings.map((warning) => (
              <p role="alert" key={warning} className="text-xs text-destructive break-words">
                {warning}
              </p>
            ))}
            <div className="grid gap-2 grid-cols-2">
              {onUse && (
                <Button data-testid="package-detail-run" onClick={onUse} disabled={busy}>
                  Use package
                </Button>
              )}
              {onEdit && (
                <Button
                  data-testid="package-edit"
                  variant="outline"
                  onClick={onEdit}
                  disabled={busy}
                >
                  Edit configuration
                </Button>
              )}
              {onExport && (
                <Button
                  data-testid="package-export-artifact"
                  variant="outline"
                  onClick={onExport}
                  disabled={busy}
                >
                  {busy ? "Preparing…" : "Export for installation"}
                </Button>
              )}
              {onSource && (
                <Button
                  data-testid="package-export"
                  variant="outline"
                  onClick={onSource}
                  disabled={busy}
                >
                  Download source
                </Button>
              )}
            </div>
            <p className="text-xs text-outline">
              APM builds installation exports (
              {manifest.data?.format === "agent-plugin" ? "portable Agent Plugin" : "Claude plugin"}
              ). Download source preserves the editable manifest and all files.
            </p>
            {operationError && (
              <p role="alert" className="text-sm text-destructive">
                {operationError}
              </p>
            )}
          </div>
          <select
            aria-label="Package file"
            className="sm:hidden mb-4 w-full min-w-0 rounded border border-surface-highest bg-surface-low p-3"
            value={path}
            onChange={(event) => setPath(event.target.value)}
          >
            {[
              manifest.data?.manifestFile ?? "apm.yml",
              ...(manifest.data?.files.map((file) => file.name) ?? []),
            ].map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
          <div className="hidden sm:flex flex-wrap gap-2 mb-4">
            {[
              manifest.data?.manifestFile ?? "apm.yml",
              ...(manifest.data?.files.map((entry) => entry.name) ?? []),
            ].map((entry) => (
              <Button
                key={entry}
                type="button"
                variant="outline"
                data-testid="package-file"
                data-file-name={entry}
                onClick={() => setPath(entry)}
                aria-pressed={path === entry}
              >
                {entry}
              </Button>
            ))}
          </div>
          {manifest.error || file.error ? (
            <p role="alert">{(manifest.error ?? file.error)?.message}</p>
          ) : file.isLoading ? (
            <p>Loading...</p>
          ) : (
            <CodeEditor
              path={path}
              value={file.data?.content ?? ""}
              readOnly
              height={450}
              testId="package-file-content"
            />
          )}
          {file.data?.encoding === "base64" && (
            <p className="text-xs text-outline">Binary asset shown as base64 (read-only).</p>
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}

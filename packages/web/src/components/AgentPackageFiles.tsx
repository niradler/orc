import { useQuery } from "@tanstack/react-query";
import { api, type PackageFull, type SkillRefContent } from "@/api/client";
import { PackageFileTabs } from "@/components/PackageFileTabs";
import { Button } from "@/components/ui/button";
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";

export function AgentPackageFiles({
  name,
  onClose,
  onUse,
  onEdit,
  onDelete,
  onExport,
  onSource,
  busy,
  operationError,
}: {
  name: string;
  onClose: () => void;
  onUse?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  onExport?: () => void;
  onSource?: () => void;
  busy?: boolean;
  operationError?: string;
}) {
  const manifest = useQuery({
    queryKey: ["agent-package", name],
    queryFn: () => api.agentPackages.get(name) as Promise<PackageFull>,
  });
  const files = useQuery({
    enabled: Boolean(manifest.data),
    queryKey: ["agent-package-files", name],
    queryFn: async () => {
      const pkg = manifest.data;
      if (!pkg) return [];
      const supporting = await Promise.all(
        pkg.files.map(async (ref) => {
          const file = (await api.agentPackages.get(name, ref.name)) as SkillRefContent;
          return { path: ref.name, content: file.content, encoding: file.encoding };
        }),
      );
      return [{ path: pkg.manifestFile, content: pkg.content }, ...supporting];
    },
  });
  const contents = manifest.data
    ? [
        {
          label: "skills",
          count: manifest.data.files.filter((file) => /(^|\/)SKILL\.md$/.test(file.name)).length,
        },
        {
          label: "instruction files",
          count: manifest.data.files.filter((file) => file.name.endsWith(".instructions.md"))
            .length,
        },
        {
          label: "agent definitions",
          count: manifest.data.files.filter((file) => file.name.endsWith(".agent.md")).length,
        },
      ]
        .filter((item) => item.count > 0)
        .map((item) => `${item.count} ${item.label}`)
        .join(" · ")
    : "";
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent defaultWidth={960} resizeKey="packages" data-testid="package-detail-sheet">
        <SheetHeader>
          <SheetTitle>{name}</SheetTitle>
        </SheetHeader>
        <SheetBody>
          <div className="mb-5 space-y-3">
            <p className="text-sm text-outline break-words">{manifest.data?.description}</p>
            {manifest.data && (
              <p className="text-xs text-outline">
                {manifest.data.format === "apm" ? "APM package" : "Agent Plugin"}
                {contents ? ` · ${contents}` : ""}
                {manifest.data.files.some((file) => file.name === "mcp.json") ? " · MCP tools" : ""}
              </p>
            )}
            {manifest.data?.warnings.map((warning) => (
              <p role="alert" key={warning} className="text-xs text-destructive break-words">
                {warning}
              </p>
            ))}
            <div
              className="flex flex-wrap items-center gap-1 border-b border-outline-variant pb-3"
              data-testid="package-actions"
            >
              {onUse && (
                <Button size="sm" data-testid="package-detail-run" onClick={onUse} disabled={busy}>
                  Use package
                </Button>
              )}
              {onEdit && (
                <Button
                  size="sm"
                  data-testid="package-edit"
                  variant="ghost"
                  onClick={onEdit}
                  disabled={busy}
                >
                  Edit
                </Button>
              )}
              {onDelete && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive"
                  data-testid="package-detail-delete"
                  onClick={onDelete}
                  disabled={busy}
                >
                  Delete package
                </Button>
              )}
              {onExport && (
                <Button
                  size="sm"
                  data-testid="package-export-artifact"
                  variant="ghost"
                  onClick={onExport}
                  disabled={busy}
                >
                  {busy ? "Preparing…" : "Installation export"}
                </Button>
              )}
              {onSource && (
                <Button
                  size="sm"
                  data-testid="package-export"
                  variant="ghost"
                  onClick={onSource}
                  disabled={busy}
                >
                  Source ZIP
                </Button>
              )}
            </div>
            <details className="text-xs text-outline">
              <summary className="cursor-pointer">About exports</summary>
              <p className="mt-2">
                APM builds installation exports (
                {manifest.data?.format === "agent-plugin"
                  ? "portable Agent Plugin"
                  : "Claude plugin"}
                ). Download source preserves the editable manifest and all files.
              </p>
            </details>
            {operationError && (
              <p role="alert" className="text-sm text-destructive">
                {operationError}
              </p>
            )}
          </div>
          {manifest.error || files.error ? (
            <p role="alert">{(manifest.error ?? files.error)?.message}</p>
          ) : files.isLoading ? (
            <p>Loading files…</p>
          ) : (
            <div className="space-y-2">
              <h4 className="text-sm font-medium">Package files</h4>
              <PackageFileTabs files={files.data ?? []} readOnly testId="package-file-content" />
            </div>
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}

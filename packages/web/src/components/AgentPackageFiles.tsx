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
          {manifest.error || files.error ? (
            <p role="alert">{(manifest.error ?? files.error)?.message}</p>
          ) : files.isLoading ? (
            <p>Loading files…</p>
          ) : (
            <PackageFileTabs files={files.data ?? []} readOnly testId="package-file-content" />
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}

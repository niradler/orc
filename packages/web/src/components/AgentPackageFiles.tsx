import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type PackageFull, type SkillRefContent } from "@/api/client";
import { CodeEditor } from "@/components/CodeEditor";
import { Button } from "@/components/ui/button";
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";

export function AgentPackageFiles({ name, onClose }: { name: string; onClose: () => void }) {
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
      <SheetContent className="sm:max-w-3xl">
        <SheetHeader>
          <SheetTitle>{name}</SheetTitle>
        </SheetHeader>
        <SheetBody>
          <div className="flex flex-wrap gap-2 mb-4">
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

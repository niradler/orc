import { useMemo, useState } from "react";
import type { SkillFileInput } from "@/api/client";
import { CodeEditor } from "@/components/CodeEditor";
import { Button } from "@/components/ui/button";
import { DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { readYamlMapping } from "@/lib/agent-definition";
import { readPrimitiveFolder } from "@/lib/primitive-files";

type PackageInput = { name: string; content: string; files: SkillFileInput[] };

export function AgentPackageEditor({
  pending,
  error,
  onSave,
}: {
  pending: boolean;
  error?: string;
  onSave: (input: PackageInput) => void;
}) {
  const [source, setSource] = useState(
    "name: my-agent-package\nversion: '1.0.0'\ndescription: Shared specialists and workflows\ntargets: [claude, codex]\n",
  );
  const [advanced, setAdvanced] = useState(false);
  const [files, setFiles] = useState<SkillFileInput[]>([]);
  const [folderError, setFolderError] = useState<string>();
  const [loadingFiles, setLoadingFiles] = useState(false);
  const parsed = useMemo(() => {
    try {
      return { value: readYamlMapping(source), error: undefined };
    } catch (failure) {
      return { value: undefined, error: (failure as Error).message };
    }
  }, [source]);
  const fields = parsed.value?.fields;
  const name = typeof fields?.name === "string" ? fields.name : "";

  function changeField(key: string, value: string): void {
    const document = readYamlMapping(source).document;
    document.set(key, value);
    setSource(document.toString());
  }

  return (
    <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>New APM package</DialogTitle>
      </DialogHeader>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSave({ name, content: source, files });
        }}
      >
        <fieldset disabled={pending || loadingFiles} className="space-y-3">
          <p className="text-xs text-outline">
            Start with this editable apm.yml template. Dependencies, targets, and scripts can be
            configured in YAML. Importing a package does not run its scripts.
          </p>
          <Button
            data-testid="package-editor-mode"
            type="button"
            variant="outline"
            disabled={advanced && Boolean(parsed.error)}
            onClick={() => setAdvanced(!advanced)}
          >
            {advanced ? "Edit fields" : "Edit YAML"}
          </Button>
          {advanced ? (
            <>
              <Label htmlFor="package-yaml">apm.yml</Label>
              <CodeEditor
                id="package-yaml"
                testId="package-yaml-input"
                path="apm.yml"
                readOnly={pending}
                height={350}
                value={source}
                onChange={setSource}
              />
            </>
          ) : (
            (
              [
                ["name", "Package name"],
                ["version", "Version"],
                ["description", "Description"],
              ] as const
            ).map(([key, label]) => (
              <div className="space-y-1" key={key}>
                <Label htmlFor={`package-${key}`}>{label}</Label>
                <Input
                  id={`package-${key}`}
                  data-testid={`package-${key}-input`}
                  value={typeof fields?.[key] === "string" ? fields[key] : ""}
                  onChange={(event) => changeField(key, event.target.value)}
                />
              </div>
            ))
          )}
          <Label htmlFor="package-files">Package folder (optional)</Label>
          <Input
            id="package-files"
            data-testid="package-files-input"
            type="file"
            multiple
            {...{ webkitdirectory: "" }}
            onChange={async (event) => {
              const selectedFiles = event.target.files;
              if (!selectedFiles?.length) {
                setFiles([]);
                setFolderError(undefined);
                return;
              }
              setFolderError(undefined);
              setLoadingFiles(true);
              try {
                setFiles(
                  (await readPrimitiveFolder(selectedFiles)).filter(
                    (file) => file.path !== "apm.yml",
                  ),
                );
              } catch (failure) {
                setFolderError((failure as Error).message);
              } finally {
                setLoadingFiles(false);
              }
            }}
          />
          <p className="text-xs text-outline">
            {files.length} bundled files. The manifest above is used as apm.yml.
          </p>
          {files.map((file) => (
            <CodeEditor
              key={file.path}
              path={file.path}
              value={file.content}
              readOnly={pending || loadingFiles || file.encoding === "base64"}
              height={220}
              testId="package-file-input"
              onChange={(content) =>
                setFiles((current) =>
                  current.map((item) => (item.path === file.path ? { ...item, content } : item)),
                )
              }
              label={
                file.encoding === "base64"
                  ? `Binary ${file.path} (base64 preview)`
                  : `Edit ${file.path}`
              }
            />
          ))}
        </fieldset>
        {(error || parsed.error || folderError) && (
          <p data-testid="package-editor-error" role="alert" className="text-destructive">
            {error || parsed.error || folderError}
          </p>
        )}
        <Button
          data-testid="package-submit"
          type="submit"
          disabled={pending || loadingFiles || !name.trim() || Boolean(parsed.error || folderError)}
        >
          {pending ? "Creating..." : "Create package"}
        </Button>
      </form>
    </DialogContent>
  );
}

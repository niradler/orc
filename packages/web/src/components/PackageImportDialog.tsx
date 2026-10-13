import { useMutation } from "@tanstack/react-query";
import { unzipSync } from "fflate";
import { useState } from "react";
import { api, type SkillFileInput } from "@/api/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type PackageFormat, packageFields } from "@/lib/package-draft";
import { readPrimitiveFolder } from "@/lib/primitive-files";

function archiveFiles(bytes: Uint8Array): SkillFileInput[] {
  if (bytes.length > 16 * 1024 * 1024) throw new Error("Archive exceeds 16 MiB");
  let size = 0;
  let count = 0;
  const archive = unzipSync(bytes, {
    filter: (file) => {
      if (file.name.endsWith("/")) return false;
      size += file.originalSize;
      count++;
      if (file.originalSize > 8 * 1024 * 1024 || size > 16 * 1024 * 1024 || count > 513)
        throw new Error("Archive exceeds package file or size limits");
      return true;
    },
  });
  const paths = Object.keys(archive);
  const roots = paths.filter((path) => /(^|\/)(apm\.yml|plugin\.json)$/.test(path));
  const manifest = roots.sort((a, b) => a.split("/").length - b.split("/").length)[0];
  if (!manifest) throw new Error("Choose a source ZIP containing apm.yml or portable plugin.json");
  const prefix = manifest.includes("/") ? manifest.slice(0, manifest.lastIndexOf("/") + 1) : "";
  if (paths.some((path) => !path.startsWith(prefix)))
    throw new Error("Choose an archive containing one package folder");
  return Object.entries(archive).map(([path, data]) => {
    let binary = "";
    for (const byte of data) binary += String.fromCharCode(byte);
    try {
      const content = new TextDecoder("utf8", { fatal: true, ignoreBOM: true }).decode(data);
      if (!content.includes("\0"))
        return { path: path.slice(prefix.length), content, encoding: "utf8" };
    } catch {
      /* preserve binary assets */
    }
    return { path: path.slice(prefix.length), content: btoa(binary), encoding: "base64" };
  });
}

export function PackageImportDialog({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: (name: string) => void;
}) {
  const [tab, setTab] = useState("git");
  const [source, setSource] = useState("");
  const [selection, setSelection] = useState("");
  const [format, setFormat] = useState<"auto" | PackageFormat>("auto");
  const [fileError, setFileError] = useState<string>();
  const [fileBusy, setFileBusy] = useState(false);
  const discover = useMutation({ mutationFn: api.agentPackages.discover });
  const importing = useMutation({
    mutationFn: api.agentPackages.importGit,
    onSuccess: (pkg) => onImported(pkg.name),
  });
  const acquire = useMutation({ mutationFn: api.agentPackages.acquire });
  const acquiredImport = useMutation({
    mutationFn: api.agentPackages.importAcquired,
    onSuccess: (pkg) => onImported(pkg.name),
  });
  const busy =
    discover.isPending ||
    importing.isPending ||
    acquire.isPending ||
    acquiredImport.isPending ||
    fileBusy;
  const candidates = discover.data?.packages ?? acquire.data?.packages;
  const chosen = candidates?.find((pkg) => `${pkg.format}:${pkg.path}` === selection);
  async function findPackages() {
    setSelection("");
    discover.reset();
    acquire.reset();
    importing.reset();
    acquiredImport.reset();
    const value = source.trim();
    if (!value.includes("://") || /^https:\/\/github\.com\//i.test(value)) {
      try {
        await discover.mutateAsync(value);
        return;
      } catch {
        discover.reset();
      }
    }
    acquire.mutate(value);
  }
  async function importFiles(files: SkillFileInput[]) {
    const apm = files.find((file) => file.path === "apm.yml");
    const plugin = files.find((file) => file.path === "plugin.json");
    if (format === "auto" && apm && plugin)
      throw new Error("Both manifests are present. Select a format before importing.");
    const selected = format === "auto" ? (apm ? "apm" : "agent-plugin") : format;
    const manifest = selected === "apm" ? apm : plugin;
    if (!manifest || manifest.encoding === "base64")
      throw new Error("The selected format's manifest is missing");
    const fields = packageFields(manifest.content, selected);
    if (typeof fields.name !== "string") throw new Error("Manifest is missing a package name");
    const pkg = await api.agentPackages.create({
      name: fields.name,
      content: manifest.content,
      format: selected,
      imported: true,
      files: files.filter(
        (file) => file !== manifest && !(selected === "agent-plugin" && file.path === "apm.yml"),
      ),
    });
    onImported(pkg.name);
  }
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="min-w-0 grid-cols-[minmax(0,1fr)] w-[calc(100%_-_1rem)] max-w-xl max-h-[94dvh] overflow-x-hidden overflow-y-auto p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle>Import a package</DialogTitle>
          <DialogDescription>
            Add reusable configuration to your catalog, then choose where to install it.
          </DialogDescription>
        </DialogHeader>
        <div role="tablist" aria-label="Import source" className="flex flex-wrap gap-2">
          {[
            ["git", "Git repository"],
            ["zip", "ZIP file"],
            ["folder", "Folder"],
          ].map(([value, label]) => (
            <Button
              key={value}
              role="tab"
              aria-selected={tab === value}
              data-testid={`package-import-${value}`}
              variant={tab === value ? "default" : "outline"}
              disabled={busy}
              onClick={() => {
                setTab(value as string);
                setFileError(undefined);
              }}
            >
              {label}
            </Button>
          ))}
        </div>
        {tab === "git" ? (
          <>
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                void findPackages();
              }}
            >
              <Label htmlFor="package-git-source">Repository URL</Label>
              <Input
                id="package-git-source"
                data-testid="package-git-source"
                placeholder="https://github.com/owner/repository"
                value={source}
                disabled={busy}
                onChange={(event) => {
                  setSource(event.target.value);
                  discover.reset();
                  acquire.reset();
                  importing.reset();
                  acquiredImport.reset();
                  setSelection("");
                }}
              />
              <p className="text-xs text-outline">
                Paste a GitHub, GitLab, Bitbucket or Azure DevOps repository or package link.
              </p>
              <Button
                type="submit"
                data-testid="package-git-discover"
                disabled={busy || !source.trim()}
              >
                {discover.isPending || acquire.isPending ? "Finding packages…" : "Find packages"}
              </Button>
            </form>
            {candidates && (
              <div className="space-y-2">
                <div className="max-h-[40dvh] space-y-2 overflow-auto">
                  {candidates.map((pkg) => (
                    <label
                      key={`${pkg.format}:${pkg.path}`}
                      className="flex items-start gap-3 rounded border border-surface-highest p-3"
                      data-testid="remote-package"
                    >
                      <input
                        className="mt-1 size-5"
                        type="radio"
                        name="package-import-selection"
                        disabled={busy || pkg.installed}
                        checked={selection === `${pkg.format}:${pkg.path}`}
                        onChange={() => setSelection(`${pkg.format}:${pkg.path}`)}
                      />
                      <span className="min-w-0 break-words">
                        <strong className="block text-sm">
                          {pkg.name}
                          {pkg.installed ? " · already in catalog" : ""}
                        </strong>
                        <span className="block text-xs text-outline">{pkg.description}</span>
                        <span className="block text-xs text-outline">
                          {pkg.format === "apm" ? "APM" : "Plugin"} ·{" "}
                          {pkg.path || "Repository root"}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
                {!candidates.length && <p>No APM or Plugin packages found in this repository.</p>}
                {discover.data?.issues.map((issue) => (
                  <p role="alert" className="text-xs text-destructive break-words" key={issue.path}>
                    {issue.path}: {issue.error}
                  </p>
                ))}
              </div>
            )}
            {candidates && (
              <Button
                data-testid="package-git-import"
                disabled={busy || !chosen}
                onClick={() => {
                  if (!chosen) return;
                  if (discover.data)
                    importing.mutate({
                      source: discover.data.source,
                      commit: discover.data.commit,
                      path: chosen.path,
                      format: chosen.format,
                    });
                  else if (acquire.data)
                    acquiredImport.mutate({ token: acquire.data.token, path: chosen.path });
                }}
              >
                {importing.isPending || acquiredImport.isPending
                  ? "Importing…"
                  : "Import to catalog"}
              </Button>
            )}
          </>
        ) : (
          <div className="space-y-3">
            <Label htmlFor="package-import-format">Package format</Label>
            <select
              id="package-import-format"
              data-testid="package-import-format"
              disabled={busy}
              className="w-full rounded border border-surface-highest bg-surface-low p-3"
              value={format}
              onChange={(event) => setFormat(event.target.value as typeof format)}
            >
              <option value="auto">Detect from manifest</option>
              <option value="apm">APM</option>
              <option value="agent-plugin">Agent Plugin</option>
            </select>
            <Label htmlFor="agent-package-folder">
              {tab === "folder" ? "Package folder" : "Package source ZIP"}
            </Label>
            <Input
              key={tab}
              id="agent-package-folder"
              data-testid={tab === "folder" ? "agent-package-folder" : "package-zip-input"}
              type="file"
              accept={tab === "zip" ? ".zip" : undefined}
              multiple={tab === "folder"}
              {...(tab === "folder" ? { webkitdirectory: "" } : {})}
              disabled={busy}
              onChange={async (event) => {
                const files = event.target.files;
                if (!files?.length) return;
                setFileBusy(true);
                setFileError(undefined);
                try {
                  await importFiles(
                    tab === "folder"
                      ? await readPrimitiveFolder(files)
                      : archiveFiles(new Uint8Array(await (files[0] as File).arrayBuffer())),
                  );
                } catch (failure) {
                  setFileError((failure as Error).message);
                } finally {
                  setFileBusy(false);
                }
              }}
            />
            <p className="text-xs text-outline">
              Original manifests and supporting files are preserved. Import does not launch an agent
              or run package scripts. Use ZIP on phones where folder selection is unavailable.
            </p>
          </div>
        )}
        {(discover.error ||
          importing.error ||
          acquire.error ||
          acquiredImport.error ||
          fileError) && (
          <p role="alert" data-testid="package-import-error" className="text-sm text-destructive">
            {discover.error?.message ??
              importing.error?.message ??
              acquire.error?.message ??
              acquiredImport.error?.message ??
              fileError}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

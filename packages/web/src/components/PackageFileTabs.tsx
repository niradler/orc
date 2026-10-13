import { useState } from "react";
import type { SkillFileInput } from "@/api/client";
import { CodeEditor } from "@/components/CodeEditor";

export function PackageFileTabs({
  files,
  readOnly = false,
  onChange,
  testId,
}: {
  files: SkillFileInput[];
  readOnly?: boolean;
  onChange?: (path: string, content: string) => void;
  testId: string;
}) {
  const [selected, setSelected] = useState(files[0]?.path);
  const [opened, setOpened] = useState<string[]>([files[0]?.path ?? ""]);
  const active = files.some((file) => file.path === selected) ? selected : files[0]?.path;
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-surface-highest">
      <div
        role="tablist"
        aria-label="Package files"
        className="flex overflow-x-auto bg-surface-low"
      >
        {files.map((file) => (
          <button
            key={file.path}
            type="button"
            role="tab"
            aria-selected={active === file.path}
            data-testid="package-file"
            data-file-name={file.path}
            title={file.path}
            className={`shrink-0 border-r border-surface-highest px-4 py-3 text-sm ${active === file.path ? "border-t-2 border-t-primary bg-surface text-on-surface" : "border-t-2 border-t-transparent text-outline hover:text-on-surface"}`}
            onClick={() => {
              setSelected(file.path);
              setOpened((current) =>
                current.includes(file.path) ? current : [...current, file.path],
              );
            }}
            onKeyDown={(event) => {
              const index = files.findIndex((item) => item.path === file.path);
              const next =
                event.key === "ArrowRight"
                  ? index + 1
                  : event.key === "ArrowLeft"
                    ? index - 1
                    : undefined;
              if (next === undefined) return;
              event.preventDefault();
              const tabs =
                event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                  '[role="tab"]',
                );
              const target = tabs?.[(next + files.length) % files.length];
              target?.focus();
              target?.click();
            }}
          >
            {file.path.endsWith("/SKILL.md")
              ? file.path.split("/").slice(-2).join("/")
              : file.path.split("/").pop()}
          </button>
        ))}
      </div>
      {files
        .filter((file) => opened.includes(file.path) || active === file.path)
        .map((file) => (
          <div key={file.path} role="tabpanel" aria-label={file.path} hidden={active !== file.path}>
            <div
              className="truncate border-t border-surface-highest px-4 py-2 text-xs text-outline"
              title={file.path}
            >
              {file.path}
            </div>
            <CodeEditor
              path={file.path}
              value={file.content}
              onChange={onChange ? (content) => onChange(file.path, content) : undefined}
              readOnly={readOnly || file.encoding === "base64"}
              height={420}
              testId={active === file.path ? testId : undefined}
            />
            {file.encoding === "base64" && (
              <p className="px-4 py-2 text-xs text-outline">Binary asset shown as base64.</p>
            )}
          </div>
        ))}
    </div>
  );
}

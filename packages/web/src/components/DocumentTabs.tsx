import { FileText } from "lucide-react";

export function DocumentTabs({
  files,
  selected,
  onSelect,
  testId = "document-file-tab",
  entryTestId,
}: {
  files: string[];
  selected: string;
  onSelect: (path: string) => boolean | undefined;
  testId?: string;
  entryTestId?: string;
}) {
  return (
    <nav aria-label="Document files" className="min-w-0 space-y-2" data-testid="document-tabs">
      <div
        role="tablist"
        aria-label="Open a file"
        className="flex max-w-full gap-1 overflow-x-auto overscroll-x-contain rounded-md border border-surface-highest p-1"
      >
        {files.map((path, index) => (
          <button
            key={path}
            type="button"
            role="tab"
            aria-selected={path === selected}
            data-testid={index === 0 && entryTestId ? entryTestId : testId}
            data-file-name={path}
            title={path}
            tabIndex={path === selected ? 0 : -1}
            onKeyDown={(event) => {
              const keys = ["ArrowRight", "ArrowLeft", "Home", "End"];
              if (!keys.includes(event.key)) return;
              event.preventDefault();
              let next = index;
              if (event.key === "ArrowRight") next = (index + 1) % files.length;
              if (event.key === "ArrowLeft") next = (index + files.length - 1) % files.length;
              if (event.key === "Home") next = 0;
              if (event.key === "End") next = files.length - 1;
              if (onSelect(files[next]) === false) return;
              const tabs =
                event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                  '[role="tab"]',
                );
              tabs?.[next]?.focus();
            }}
            onClick={() => onSelect(path)}
            className={`flex min-h-11 shrink-0 items-center gap-2 rounded px-3 text-sm ${path === selected ? "bg-primary/15 text-primary" : "text-outline hover:bg-surface-highest hover:text-on-surface"}`}
          >
            <FileText size={14} aria-hidden="true" />
            <span className="max-w-[180px] truncate">{path.split("/").pop()}</span>
          </button>
        ))}
      </div>
      <label className="flex min-w-0 items-center gap-2 text-sm text-outline sm:hidden">
        File
        <select
          aria-label="Choose document file"
          data-testid="document-file-picker"
          value={selected}
          onChange={(event) => onSelect(event.target.value)}
          className="min-h-11 min-w-0 flex-1 rounded border border-surface-highest bg-surface px-2 text-on-surface"
        >
          {files.map((path) => (
            <option key={path} value={path}>
              {path}
            </option>
          ))}
        </select>
      </label>
    </nav>
  );
}

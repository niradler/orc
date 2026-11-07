import type { ChatActivity } from "@orc/core/chat";
import {
  Brain,
  ChevronRight,
  CircleAlert,
  Eye,
  FilePen,
  type LucideIcon,
  Search,
  SquareTerminal,
  Wrench,
} from "lucide-react";
import { useMemo, useState } from "react";
import { DiffLines } from "@/components/terminals/FileDiffCard";
import { type ChatTool, type ToolView, toolDetail, toolKey, toolView } from "@/lib/chat-tools";
import { diffLines } from "@/lib/git-diff";

const SEARCH_TOOLS = /grep|glob|search|find|fetch/;
const rowSummary =
  "flex min-h-8 cursor-pointer list-none items-center gap-2 rounded-md px-1.5 hover:bg-surface hover:text-on-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus max-sm:min-h-11 [&::-webkit-details-marker]:hidden";
const bodyClass = "mb-1 ml-6 max-h-80 overflow-auto border-l border-outline-variant pl-3 py-1";
const preClass = "whitespace-pre-wrap wrap-break-word wrap-anywhere font-mono";

function toolIcon(tool: ChatTool, view: ToolView): LucideIcon {
  if (view.kind === "edit") return FilePen;
  if (view.kind === "command") return SquareTerminal;
  if (view.kind === "lookup") return SEARCH_TOOLS.test(toolKey(tool.name)) ? Search : Eye;
  return Wrench;
}

export function DiffStat({ added, removed }: { added: number; removed: number }) {
  return (
    <span
      data-testid="chat-diff-stat"
      role="img"
      aria-label={`${added} addition${added === 1 ? "" : "s"}, ${removed} deletion${removed === 1 ? "" : "s"}`}
      className="shrink-0 font-mono tabular-nums"
    >
      <span aria-hidden="true" className="text-secondary">
        +{added}
      </span>{" "}
      <span aria-hidden="true" className="text-error">
        −{removed}
      </span>
    </span>
  );
}

function ToolState({ tool, live }: { tool: ChatTool; live: boolean }) {
  if (tool.isError)
    return (
      <span className="flex shrink-0 items-center gap-1 text-error">
        <CircleAlert aria-hidden="true" size={12} />
        Failed
      </span>
    );
  return tool.result === undefined ? (
    <span className="shrink-0">{live ? "Running" : "Incomplete"}</span>
  ) : null;
}

function CommandBody({
  tool,
  view,
}: {
  tool: ChatTool;
  view: Extract<ToolView, { kind: "command" }>;
}) {
  const [full, setFull] = useState(false);
  return (
    <>
      <pre data-testid="chat-tool-command" className={`${preClass} text-on-surface`}>
        <span aria-hidden="true" className="select-none text-on-surface-variant">
          ${" "}
        </span>
        {view.command}
      </pre>
      {view.hidden > 0 && (
        <button
          type="button"
          aria-expanded={full}
          onClick={() => setFull((value) => !value)}
          className="mt-1 min-h-8 rounded-md px-1 text-primary hover:bg-surface max-sm:min-h-11"
        >
          {full ? "Show last lines only" : `Show ${view.hidden} earlier lines`}
        </button>
      )}
      {tool.result !== undefined && (
        <pre data-testid="chat-tool-output" className={`${preClass} mt-1`}>
          {(full ? tool.result.replace(/\s+$/, "") : view.tail) || "Completed without output"}
        </pre>
      )}
    </>
  );
}

function EditBody({ tool, view }: { tool: ChatTool; view: Extract<ToolView, { kind: "edit" }> }) {
  return (
    <>
      {view.files.map((file) => (
        <section key={file.path} className="mb-2">
          <p className="mb-1 flex items-center gap-2 font-mono">
            <span className="min-w-0 flex-1 break-all text-on-surface">{file.path}</span>
            <DiffStat added={file.added} removed={file.removed} />
          </p>
          <div
            data-testid="chat-tool-diff"
            className="overflow-x-auto rounded-md border border-outline-variant font-mono"
          >
            <DiffLines lines={diffLines(file.diff)} />
          </div>
        </section>
      ))}
      {tool.isError && tool.result && <pre className={`${preClass} text-error`}>{tool.result}</pre>}
    </>
  );
}

function GenericBody({ tool }: { tool: ChatTool }) {
  return (
    <>
      <p className="mb-1 font-medium">Input</p>
      <pre className={preClass}>{tool.input || "No arguments"}</pre>
      {tool.result !== undefined && (
        <>
          <p className="mt-3 mb-1 font-medium">Result</p>
          <pre className={preClass}>{tool.result || "Completed without output"}</pre>
        </>
      )}
    </>
  );
}

export function ToolRow({ tool, live = false }: { tool: ChatTool; live?: boolean }) {
  const view = useMemo(() => toolView(tool), [tool]);
  const Icon = toolIcon(tool, view);
  const detail = toolDetail(view);
  return (
    <details data-testid="chat-tool" data-kind={view.kind} className="group/tool">
      <summary className={rowSummary}>
        <Icon aria-hidden="true" size={14} className="shrink-0" />
        <span className="shrink-0 text-on-surface">{tool.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono" title={detail || undefined}>
          {detail}
        </span>
        {view.kind === "edit" && (
          <DiffStat
            added={view.files.reduce((sum, file) => sum + file.added, 0)}
            removed={view.files.reduce((sum, file) => sum + file.removed, 0)}
          />
        )}
        <ToolState tool={tool} live={live} />
        <ChevronRight
          aria-hidden="true"
          size={14}
          className="shrink-0 group-open/tool:rotate-90 motion-safe:transition-transform"
        />
      </summary>
      <div className={bodyClass}>
        {view.kind === "edit" ? (
          <EditBody tool={tool} view={view} />
        ) : view.kind === "command" ? (
          <CommandBody tool={tool} view={view} />
        ) : view.kind === "lookup" && !tool.isError ? (
          <pre className={preClass}>{tool.result || "Completed without output"}</pre>
        ) : (
          <GenericBody tool={tool} />
        )}
      </div>
    </details>
  );
}

export function ActivityRow({ item, live = false }: { item: ChatActivity; live?: boolean }) {
  if (item.type === "tool") return <ToolRow tool={item} live={live} />;
  if (item.type === "status")
    return <p className="px-1.5 py-1 wrap-break-word text-on-surface-variant">{item.text}</p>;
  return (
    <details data-testid="chat-thinking" className="group/tool">
      <summary className={rowSummary}>
        <Brain aria-hidden="true" size={14} className="shrink-0" />
        <span className="shrink-0 text-on-surface">Thinking</span>
        <span className="min-w-0 flex-1 truncate">{item.text.trim().split("\n")[0]}</span>
        <ChevronRight
          aria-hidden="true"
          size={14}
          className="shrink-0 group-open/tool:rotate-90 motion-safe:transition-transform"
        />
      </summary>
      <div className={`${bodyClass} whitespace-pre-wrap wrap-break-word`}>{item.text}</div>
    </details>
  );
}

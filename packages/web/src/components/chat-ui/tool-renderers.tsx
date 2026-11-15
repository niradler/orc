import type { ChatActivity, ChatItem } from "@orc/core/chat";
import {
  Brain,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleX,
  ExternalLink,
  Eye,
  FilePen,
  FilePlus,
  GitBranch,
  GitPullRequest,
  Globe,
  Info,
  ListChecks,
  ListTodo,
  LoaderCircle,
  type LucideIcon,
  MessageCircle,
  Plug,
  Search,
  SquareTerminal,
  Wrench,
} from "lucide-react";
import { useMemo, useState } from "react";
import { DiffLines } from "@/components/terminals/FileDiffCard";
import { chatItemActivity } from "@/lib/chat-activity";
import {
  type ChatTool,
  pullRequestLinks,
  resultBranch,
  resultFiles,
  stripInlineImages,
  type ToolFileChange,
  type ToolImage,
  type ToolLink,
  type ToolQuestion,
  type ToolTodoEntry,
  type ToolTodoStatus,
  type ToolView,
  toolDetail,
  toolImages,
  toolView,
} from "@/lib/chat-tools";
import { useDesktopPreview } from "@/lib/desktop-preview-context";
import { diffLines } from "@/lib/git-diff";

const rowSummary =
  "flex min-h-8 cursor-pointer list-none items-center gap-2 rounded-md px-1.5 hover:bg-surface hover:text-on-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus max-sm:min-h-11 [&::-webkit-details-marker]:hidden";
const bodyClass = "mb-1 ml-6 max-h-80 overflow-auto border-l border-outline-variant pl-3 py-1";
const preClass = "whitespace-pre-wrap wrap-break-word wrap-anywhere font-mono";
const quietButton =
  "min-h-8 rounded-md px-1.5 text-primary hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus max-lg:min-h-11";

function toolIcon(view: ToolView): LucideIcon {
  if (view.kind === "read") return Eye;
  if (view.kind === "search") return Search;
  if (view.kind === "edit") return FilePen;
  if (view.kind === "write") return FilePlus;
  if (view.kind === "run") return SquareTerminal;
  if (view.kind === "mcp") return Plug;
  if (view.kind === "browser") return Globe;
  if (view.kind === "todo") return ListChecks;
  if (view.kind === "plan") return ListTodo;
  if (view.kind === "question") return MessageCircle;
  return Wrench;
}

/** The same icon the activity list uses, so the live trail matches the transcript. */
export function activityIcon(item: ChatActivity): LucideIcon {
  if (item.type === "thinking") return Brain;
  if (item.type === "status") return Info;
  if (item.type === "plan") return ListTodo;
  return toolIcon(toolView(item));
}

const STATUS: Record<
  ToolTodoStatus,
  { Icon: LucideIcon; label: string; className: string; visible: boolean }
> = {
  pending: {
    Icon: CircleDashed,
    label: "Pending",
    className: "text-on-surface-variant",
    visible: false,
  },
  in_progress: {
    Icon: LoaderCircle,
    label: "In progress",
    className: "text-progress",
    visible: true,
  },
  completed: { Icon: CircleCheck, label: "Completed", className: "text-success", visible: false },
  failed: { Icon: CircleX, label: "Failed", className: "text-error", visible: true },
};

function Checklist({ entries, label }: { entries: ToolTodoEntry[]; label: string }) {
  return (
    <section
      aria-label={label}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a bounded step list must be keyboard-scrollable.
      tabIndex={0}
      data-testid="chat-checklist"
      className="max-h-64 overflow-y-auto border-l border-outline-variant py-0.5 pr-1 pl-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
    >
      <ol>
        {entries.map((entry) => {
          const status = STATUS[entry.status];
          return (
            <li
              key={entry.id}
              data-testid="chat-plan-entry"
              data-status={entry.status}
              className="flex gap-2 py-1"
            >
              <status.Icon
                aria-hidden="true"
                size={13}
                className={`mt-0.5 shrink-0 ${status.className}`}
              />
              <span className="min-w-0 flex-1 wrap-break-word text-on-surface">
                <span className="sr-only">{status.label}: </span>
                {entry.content}
              </span>
              {status.visible && (
                <span className={`shrink-0 text-xs ${status.className}`}>{status.label}</span>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** The plan activity's checklist card: reported steps only, bounded height. */
export function PlanCard({ plan }: { plan: Extract<ChatActivity, { type: "plan" }> }) {
  const done = plan.entries.filter((entry) => entry.status === "completed").length;
  const failed = plan.entries.filter((entry) => entry.status === "failed").length;
  const title = plan.title ?? "Plan";
  return (
    <section
      data-testid="chat-plan"
      aria-label={`${title}, ${done} of ${plan.entries.length} steps completed`}
      className="mb-2"
    >
      <div className="flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1 px-1.5 py-1 text-xs">
        <ListTodo aria-hidden="true" size={14} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate text-on-surface">{title}</span>
        <span data-testid="chat-plan-progress" className="shrink-0 tabular-nums">
          {done} of {plan.entries.length} steps
        </span>
        {failed > 0 && (
          <span className="flex shrink-0 items-center gap-1 text-error">
            <CircleAlert aria-hidden="true" size={12} />
            {failed} failed
          </span>
        )}
      </div>
      {plan.entries.length ? (
        <Checklist entries={plan.entries} label="Plan steps" />
      ) : (
        <p className="px-1.5 py-1 text-xs">No steps reported.</p>
      )}
    </section>
  );
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

/**
 * A workspace file reached from chat opens through the existing preview, which
 * resolves it inside the session folder. Without that surface the path stays text.
 */
function FilePathLink({ path, line }: { path: string; line?: number }) {
  const preview = useDesktopPreview();
  const target = line ? `${path}:${line}` : path;
  if (!preview)
    return (
      <span title={target} className="min-w-0 truncate font-mono">
        {target}
      </span>
    );
  return (
    <button
      type="button"
      data-testid="chat-file-link"
      data-file={path}
      title={`Open ${target}`}
      onClick={() => void preview.openFile(path, line).catch(() => undefined)}
      className="min-h-8 min-w-0 truncate text-left font-mono text-on-surface underline decoration-outline underline-offset-2 hover:text-on-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus max-lg:min-h-11"
    >
      {target}
    </button>
  );
}

function sizeLabel(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function ToolImageFigure({ image, index }: { image: ToolImage; index: number }) {
  const [full, setFull] = useState(false);
  return (
    <figure data-testid="chat-tool-image" className="my-2">
      <img
        src={image.src}
        alt={`Tool output ${index + 1}`}
        loading="lazy"
        decoding="async"
        className={`w-auto max-w-full rounded border border-outline-variant object-contain ${
          full ? "max-h-[min(70vh,32rem)]" : "max-h-40"
        }`}
      />
      <figcaption className="mt-1 flex items-center gap-2 text-xs">
        <button
          type="button"
          aria-expanded={full}
          onClick={() => setFull((value) => !value)}
          className={quietButton}
        >
          {full ? "Show smaller" : "Show full size"}
        </button>
        <span className="text-on-surface-variant">{sizeLabel(image.bytes)}</span>
      </figcaption>
    </figure>
  );
}

/** Inline images come from the tool result only; a remote URL is never loaded. */
function ToolImages({ tool }: { tool: ChatTool }) {
  const images = useMemo(() => toolImages(tool.result), [tool.result]);
  if (!images.length) return null;
  return (
    <div data-testid="chat-tool-images">
      {images.map((image, index) => (
        <ToolImageFigure key={image.src} image={image} index={index} />
      ))}
    </div>
  );
}

function PullLink({ link }: { link: ToolLink }) {
  return (
    <a
      data-testid="chat-tool-pr-link"
      href={link.href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex min-h-8 items-center gap-1 rounded-md px-1 text-primary underline-offset-2 hover:bg-surface hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus max-lg:min-h-11"
    >
      <GitPullRequest aria-hidden="true" size={12} />
      {link.label}
      <ExternalLink aria-hidden="true" size={11} />
    </a>
  );
}

/** Branch, pull-request and changed-file links a Git command actually printed. */
function ResultLinks({ command, output }: { command: string; output: string }) {
  const branch = resultBranch(command, output);
  const pulls = pullRequestLinks(output);
  const files = resultFiles(command, output);
  if (!branch && !pulls.length && !files.length) return null;
  return (
    <div
      data-testid="chat-tool-links"
      className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"
    >
      {branch && (
        <span
          data-testid="chat-tool-branch"
          title={`Branch ${branch}`}
          className="inline-flex min-w-0 items-center gap-1 font-mono text-on-surface"
        >
          <GitBranch aria-hidden="true" size={12} className="shrink-0" />
          <span className="truncate">{branch}</span>
        </span>
      )}
      {pulls.map((link) => (
        <PullLink key={link.href} link={link} />
      ))}
      {files.length > 0 && (
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-on-surface-variant">Changed files</span>
          {files.map((file) => (
            <FilePathLink key={file} path={file} />
          ))}
        </span>
      )}
    </div>
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

function CommandBody({ tool, view }: { tool: ChatTool; view: Extract<ToolView, { kind: "run" }> }) {
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
          className={quietButton}
        >
          {full ? "Show last lines only" : `Show ${view.hidden} earlier lines`}
        </button>
      )}
      {tool.result !== undefined && (
        <pre data-testid="chat-tool-output" className={`${preClass} mt-1`}>
          {stripInlineImages(full ? tool.result.replace(/\s+$/, "") : view.tail) ||
            "Completed without output"}
        </pre>
      )}
      <ResultLinks command={view.command} output={tool.result ?? ""} />
      <ToolImages tool={tool} />
    </>
  );
}

function FileChangeBody({ files }: { files: ToolFileChange[] }) {
  return (
    <>
      {files.map((file) => (
        <section key={file.path} className="mb-2">
          <p className="mb-1 flex items-center gap-2">
            <FilePathLink path={file.path} />
            {file.created && (
              <span className="shrink-0 text-xs text-on-surface-variant">New file</span>
            )}
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
          <pre className={preClass}>
            {stripInlineImages(tool.result) || "Completed without output"}
          </pre>
        </>
      )}
    </>
  );
}

function QuestionBody({ tool, questions }: { tool: ChatTool; questions: ToolQuestion[] }) {
  return (
    <>
      {questions.map((question, index) => (
        <section key={question.header ?? question.question} className="mb-2">
          <p className="mb-1 text-xs text-on-surface-variant">
            {question.header ?? `Question ${index + 1}`}
          </p>
          <p className="mb-1 wrap-break-word text-on-surface">{question.question}</p>
          {question.options.length > 0 && (
            <ul className="list-inside list-disc text-on-surface-variant">
              {question.options.map((option) => (
                <li key={option} className="wrap-break-word">
                  {option}
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
      {tool.result !== undefined && (
        <pre className={`${preClass} mt-1`}>{tool.result || "Answered"}</pre>
      )}
    </>
  );
}

export function ToolRow({ tool, live = false }: { tool: ChatTool; live?: boolean }) {
  const view = useMemo(() => toolView(tool), [tool]);
  const Icon = toolIcon(view);
  const detail = toolDetail(view);
  return (
    <details data-testid="chat-tool" data-kind={view.kind} className="group/tool">
      <summary className={rowSummary}>
        <Icon aria-hidden="true" size={14} className="shrink-0" />
        <span className="shrink-0 text-on-surface">{tool.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono" title={detail || undefined}>
          {detail}
        </span>
        {(view.kind === "edit" || view.kind === "write") && (
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
        {view.kind === "edit" || view.kind === "write" ? (
          <>
            <FileChangeBody files={view.files} />
            {tool.isError && tool.result && (
              <pre className={`${preClass} text-error`}>{tool.result}</pre>
            )}
          </>
        ) : view.kind === "run" ? (
          <CommandBody tool={tool} view={view} />
        ) : view.kind === "question" ? (
          <QuestionBody tool={tool} questions={view.questions} />
        ) : view.kind === "todo" || view.kind === "plan" ? (
          <>
            <Checklist entries={view.entries} label="Tool checklist" />
            {tool.isError && tool.result && (
              <pre className={`${preClass} text-error`}>{tool.result}</pre>
            )}
            <ToolImages tool={tool} />
          </>
        ) : view.kind === "read" ? (
          <>
            {view.path && (
              <p className="mb-1">
                <FilePathLink path={view.path} line={view.line} />
              </p>
            )}
            <pre data-testid="chat-tool-output" className={preClass}>
              {stripInlineImages(tool.result ?? "") || "Completed without output"}
            </pre>
            <ToolImages tool={tool} />
          </>
        ) : view.kind === "search" ? (
          <>
            <pre data-testid="chat-tool-output" className={preClass}>
              {stripInlineImages(tool.result ?? "") || "Completed without output"}
            </pre>
            <ToolImages tool={tool} />
          </>
        ) : (
          <>
            <GenericBody tool={tool} />
            <ToolImages tool={tool} />
          </>
        )}
      </div>
    </details>
  );
}

/** Stored JSON, rendered as text only; a provider value never reaches the DOM as markup. */
function providerData(data: Record<string, unknown> | undefined): string {
  if (!data) return "{}";
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return "";
  }
}

/** A kind this build does not know: quiet, collapsed, and bounded when opened. */
function ProviderRow({ item }: { item: Extract<ChatItem, { kind: "provider" }> }) {
  return (
    <details data-testid="chat-provider-activity" data-kind={item.provider} className="group/tool">
      <summary className={rowSummary}>
        <Plug aria-hidden="true" size={14} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate font-mono" title={item.provider}>
          {item.provider}
        </span>
        <span className="shrink-0 text-on-surface-variant">Unrecognized</span>
        <ChevronRight
          aria-hidden="true"
          size={14}
          className="shrink-0 group-open/tool:rotate-90 motion-safe:transition-transform"
        />
      </summary>
      <div className={bodyClass}>
        <pre data-testid="chat-provider-data" className={`${preClass} text-xs`}>
          {providerData(item.data)}
        </pre>
      </div>
    </details>
  );
}

export function ActivityRow({ item, live = false }: { item: ChatItem; live?: boolean }) {
  if (item.kind === "provider") return <ProviderRow item={item} />;
  const activity = chatItemActivity(item);
  if (!activity) return null;
  if (activity.type === "tool") return <ToolRow tool={activity} live={live} />;
  if (activity.type === "plan") return <PlanCard plan={activity} />;
  if (activity.type === "status")
    return <p className="px-1.5 py-1 wrap-break-word text-on-surface-variant">{activity.text}</p>;
  return (
    <details data-testid="chat-thinking" className="group/tool">
      <summary className={rowSummary}>
        <Brain aria-hidden="true" size={14} className="shrink-0" />
        <span className="shrink-0 text-on-surface">Thinking</span>
        <span className="min-w-0 flex-1 truncate">{activity.text.trim().split("\n")[0]}</span>
        <ChevronRight
          aria-hidden="true"
          size={14}
          className="shrink-0 group-open/tool:rotate-90 motion-safe:transition-transform"
        />
      </summary>
      <div className={`${bodyClass} whitespace-pre-wrap wrap-break-word`}>{activity.text}</div>
    </details>
  );
}

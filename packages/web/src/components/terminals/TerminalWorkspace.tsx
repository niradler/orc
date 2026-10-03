import { useQuery } from "@tanstack/react-query";
import { Columns2, Rows2, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { api, type Terminal } from "@/api/client";
import {
  closePane,
  type Layout,
  leaves,
  type Pane,
  type PaneKind,
  readLayout,
  updateLayout,
} from "@/lib/workspace-layout";
import { GitPanelBody } from "./GitPanel";

function FilePanel({ terminal }: { terminal: Terminal }) {
  const [path, setPath] = useState("");
  const files = useQuery({
    queryKey: ["checkout-files", terminal.id, path],
    queryFn: () => api.git.files(terminal.id, path),
  });
  const parent = path.split("/").slice(0, -1).join("/");
  return (
    <div data-testid="file-panel" className="flex-1 min-h-0 overflow-auto p-3 space-y-2 text-sm">
      <div className="flex gap-3">
        <button
          type="button"
          data-testid="files-root"
          onClick={() => setPath("")}
          className="text-primary"
        >
          Checkout
        </button>
        {path && (
          <button
            type="button"
            data-testid="files-up"
            onClick={() => setPath(parent)}
            className="text-primary"
          >
            Up
          </button>
        )}
        <button type="button" onClick={() => void files.refetch()} className="ml-auto text-primary">
          Refresh
        </button>
      </div>
      <p className="text-outline break-all">
        {files.data?.root}/{path}
      </p>
      {files.isPending && <p>Loading files…</p>}
      {files.error && <p role="alert">{files.error.message}</p>}
      {files.data?.entries?.map((entry) => (
        <button
          type="button"
          key={entry.path}
          data-testid="file-entry"
          onClick={() => setPath(entry.path)}
          className="block w-full text-left p-1 hover:bg-surface-highest"
        >
          {entry.directory ? "▸ " : ""}
          {entry.name}
        </button>
      ))}
      {files.data?.binary && <p>Binary file; text preview unavailable.</p>}
      {files.data?.content != null && (
        <pre data-testid="file-preview" className="text-xs font-mono whitespace-pre overflow-auto">
          {files.data.content}
        </pre>
      )}
      {files.data?.truncated && (
        <p className="text-outline">Preview limited to 200 KB or 500 directory entries.</p>
      )}
    </div>
  );
}

type WorkspaceProps = {
  selected: Terminal;
  terminals: Terminal[];
  renderTerminal: (id: string) => ReactNode;
};
type TreeProps = WorkspaceProps & {
  node: Layout;
  root: Layout;
  active: string;
  focus: (id: string) => void;
  change: (id: string, update: (node: Layout) => Layout) => void;
  close: (id: string) => void;
};
function WorkspaceTree(props: TreeProps) {
  const { node, root, terminals, active, focus, change, close, renderTerminal } = props;
  if (!("kind" in node)) {
    const horizontal = node.direction === "row";
    const ratio = (next: number) =>
      change(node.id, (old) =>
        "kind" in old ? old : { ...old, ratio: Math.max(20, Math.min(80, next)) },
      );
    return (
      <div
        data-testid="workspace-split"
        className="flex flex-1 min-w-0 min-h-0 overflow-hidden"
        style={{ flexDirection: node.direction }}
      >
        <div className="flex min-w-0 min-h-0" style={{ flex: `${node.ratio} 1 0%` }}>
          <WorkspaceTree {...props} node={node.first} />
        </div>
        {/* biome-ignore lint/a11y/useSemanticElements: movable pane divider has no native equivalent */}
        <div
          role="separator"
          aria-label={horizontal ? "Resize panes horizontally" : "Resize panes vertically"}
          aria-orientation={horizontal ? "vertical" : "horizontal"}
          aria-valuenow={Math.round(node.ratio)}
          aria-valuemin={20}
          aria-valuemax={80}
          tabIndex={0}
          data-testid="workspace-resize"
          className={`shrink-0 bg-surface-highest hover:bg-primary/50 focus-visible:bg-primary/50 touch-none ${horizontal ? "w-2 cursor-col-resize" : "h-2 cursor-row-resize"}`}
          onDoubleClick={() => ratio(50)}
          onKeyDown={(event) => {
            const decrease = horizontal ? "ArrowLeft" : "ArrowUp";
            const increase = horizontal ? "ArrowRight" : "ArrowDown";
            if (event.key !== decrease && event.key !== increase) return;
            event.preventDefault();
            ratio(node.ratio + (event.key === decrease ? -5 : 5));
          }}
          onPointerDown={(event) => {
            event.preventDefault();
            const handle = event.currentTarget;
            const rect = handle.parentElement?.getBoundingClientRect();
            if (!rect) return;
            handle.setPointerCapture(event.pointerId);
            const move = (pointer: PointerEvent) =>
              ratio(
                100 *
                  (horizontal
                    ? (pointer.clientX - rect.left) / rect.width
                    : (pointer.clientY - rect.top) / rect.height),
              );
            const end = () => {
              handle.removeEventListener("pointermove", move);
              handle.removeEventListener("pointerup", end);
              handle.removeEventListener("pointercancel", end);
            };
            handle.addEventListener("pointermove", move);
            handle.addEventListener("pointerup", end);
            handle.addEventListener("pointercancel", end);
          }}
        />
        <div className="flex min-w-0 min-h-0" style={{ flex: `${100 - node.ratio} 1 0%` }}>
          <WorkspaceTree {...props} node={node.second} />
        </div>
      </div>
    );
  }
  const occupied = new Set(
    leaves(root)
      .filter((pane) => pane.id !== node.id && pane.kind === "terminal")
      .map((pane) => pane.terminalId),
  );
  const terminal = terminals.find((terminal) => terminal.id === node.terminalId);
  const setPane = (patch: Partial<Pane>) =>
    change(node.id, (old) => ("kind" in old ? { ...old, ...patch } : old));
  const split = (direction: "row" | "column") => {
    if (leaves(root).length >= 8) return;
    const paneId = crypto.randomUUID();
    change(node.id, (old) => ({
      id: crypto.randomUUID(),
      direction,
      ratio: 50,
      first: old,
      second: {
        id: paneId,
        kind: node.kind === "git" ? "files" : "git",
        terminalId: node.terminalId,
      },
    }));
    focus(paneId);
  };
  return (
    <section
      data-testid="workspace-pane"
      data-kind={node.kind}
      data-active={active === node.id ? "true" : "false"}
      onPointerDownCapture={() => focus(node.id)}
      onFocusCapture={() => focus(node.id)}
      className={`flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden border ${active === node.id ? "border-primary/50" : "border-transparent"}`}
    >
      <header className="flex shrink-0 gap-1 items-center p-1 bg-surface border-b border-surface-highest">
        <select
          data-testid="pane-view"
          aria-label="Pane view"
          value={node.kind}
          onChange={(event) => {
            const kind = event.target.value as PaneKind;
            setPane({
              kind,
              terminalId:
                kind === "terminal" && occupied.has(node.terminalId)
                  ? (terminals.find((terminal) => !occupied.has(terminal.id))?.id ?? null)
                  : node.terminalId,
            });
          }}
          className="bg-surface-highest text-xs p-1 min-w-0"
        >
          <option value="terminal">Terminal</option>
          <option value="git">Git</option>
          <option value="files">Files</option>
        </select>
        <select
          data-testid="pane-terminal"
          aria-label="Pane terminal or checkout"
          value={terminal?.id ?? ""}
          onChange={(event) => setPane({ terminalId: event.target.value || null })}
          className="flex-1 min-w-0 bg-surface text-xs p-1"
        >
          <option value="">Choose terminal</option>
          {terminals.map((terminal) => (
            <option
              key={terminal.id}
              value={terminal.id}
              disabled={node.kind === "terminal" && occupied.has(terminal.id)}
            >
              {terminal.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          data-testid="pane-split-horizontal"
          aria-label="Split side by side"
          title="Split side by side"
          disabled={leaves(root).length >= 8}
          onClick={() => split("row")}
          className="p-1 text-primary disabled:opacity-40"
        >
          <Columns2 size={16} />
        </button>
        <button
          type="button"
          data-testid="pane-split-vertical"
          aria-label="Split top and bottom"
          title="Split top and bottom"
          disabled={leaves(root).length >= 8}
          onClick={() => split("column")}
          className="p-1 text-primary disabled:opacity-40"
        >
          <Rows2 size={16} />
        </button>
        {leaves(root).length > 1 && (
          <button
            type="button"
            data-testid="pane-close"
            aria-label="Close pane (keep terminal running)"
            title="Close pane; terminal keeps running"
            onClick={() => close(node.id)}
            className="p-1 text-outline"
          >
            <X size={16} />
          </button>
        )}
      </header>
      {!terminal ? (
        <p className="p-4 text-sm text-outline">
          Choose a terminal or launch one from New Terminal.
        </p>
      ) : node.kind === "terminal" ? (
        renderTerminal(terminal.id)
      ) : node.kind === "git" ? (
        <GitPanelBody key={terminal.id} terminal={terminal} />
      ) : (
        <FilePanel key={terminal.id} terminal={terminal} />
      )}
    </section>
  );
}

export function TerminalWorkspace(props: WorkspaceProps) {
  const [layout, setLayout] = useState<Layout>(() => {
    try {
      const stored = readLayout(JSON.parse(localStorage.getItem("orc_workspace_layout") ?? "null"));
      if (stored) return stored;
    } catch {}
    return { id: crypto.randomUUID(), kind: "terminal", terminalId: props.selected.id };
  });
  const [active, setActive] = useState(() => leaves(layout)[0]?.id ?? layout.id);
  const previousSelection = useRef<string | null>(null);
  useEffect(() => {
    try {
      localStorage.setItem("orc_workspace_layout", JSON.stringify(layout));
    } catch {}
  }, [layout]);
  useEffect(() => {
    if (previousSelection.current === props.selected.id) return;
    previousSelection.current = props.selected.id;
    setLayout((current) => {
      const pane = leaves(current).find((pane) => pane.id === active) ?? leaves(current)[0];
      if (!pane) return current;
      const occupied = leaves(current).find(
        (other) =>
          other.id !== pane.id &&
          other.kind === "terminal" &&
          other.terminalId === props.selected.id,
      );
      if (pane.kind === "terminal" && occupied) {
        setActive(occupied.id);
        return current;
      }
      return updateLayout(current, pane.id, (node) =>
        "kind" in node ? { ...node, terminalId: props.selected.id } : node,
      );
    });
  }, [props.selected.id, active]);
  return (
    <div data-testid="terminal-workspace" className="flex flex-1 min-h-0 min-w-0">
      <WorkspaceTree
        {...props}
        node={layout}
        root={layout}
        active={active}
        focus={setActive}
        change={(id, update) => setLayout((current) => updateLayout(current, id, update))}
        close={(id) =>
          setLayout((current) => {
            const next = closePane(current, id);
            if (active === id) setActive(leaves(next)[0]?.id ?? next.id);
            return next;
          })
        }
      />
    </div>
  );
}

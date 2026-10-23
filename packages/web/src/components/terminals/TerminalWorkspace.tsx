import { Columns2, Rows2, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { Terminal } from "@/api/client";
import { useBreakpoint } from "@/hooks/useMediaQuery";
import {
  closePane,
  type Layout,
  leaves,
  type Pane,
  type PaneKind,
  readLayout,
  updateLayout,
} from "@/lib/workspace-layout";
import { FilePanel } from "./FilePanel";
import { GitPanelBody } from "./GitPanel";

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
  mobile: boolean;
};
function WorkspaceTree(props: TreeProps) {
  const { node, root, terminals, active, focus, change, close, renderTerminal, mobile } = props;
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
        style={{ flexDirection: mobile ? "column" : node.direction }}
      >
        <div
          className={`${mobile && !leaves(node.first).some((pane) => pane.id === active) ? "hidden" : "flex"} min-w-0 min-h-0`}
          style={{ flex: mobile ? "1 1 0%" : `${node.ratio} 1 0%` }}
        >
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
          className={`${mobile ? "hidden" : ""} shrink-0 bg-border hover:bg-surface focus-visible:bg-focus touch-none ${horizontal ? "w-2 cursor-col-resize" : "h-2 cursor-row-resize"}`}
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
        <div
          className={`${mobile && !leaves(node.second).some((pane) => pane.id === active) ? "hidden" : "flex"} min-w-0 min-h-0`}
          style={{ flex: mobile ? "1 1 0%" : `${100 - node.ratio} 1 0%` }}
        >
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
      className={`flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden border ${active === node.id ? "border-outline-variant" : "border-transparent"}`}
    >
      <header className="flex shrink-0 gap-1 items-center flex-wrap p-1.5 bg-background border-b border-outline-variant">
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
          className="flex-1 lg:flex-none min-h-11 sm:min-h-8 rounded-md border border-control-border bg-background text-base sm:text-sm p-1.5 min-w-0"
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
          className="hidden lg:block flex-1 min-w-0 min-h-11 sm:min-h-8 rounded-md border border-control-border bg-background text-base sm:text-sm p-1.5"
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
          className="min-h-11 min-w-11 sm:min-h-8 sm:min-w-8 inline-flex items-center justify-center rounded-md text-primary hover:bg-surface disabled:opacity-40"
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
          className="min-h-11 min-w-11 sm:min-h-8 sm:min-w-8 inline-flex items-center justify-center rounded-md text-primary hover:bg-surface disabled:opacity-40"
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
            className="min-h-11 min-w-11 sm:min-h-8 sm:min-w-8 inline-flex items-center justify-center rounded-md text-on-surface-variant hover:bg-surface"
          >
            <X size={16} />
          </button>
        )}
      </header>
      {!terminal ? (
        <p className="p-4 text-sm text-on-surface-variant">
          {node.terminalId
            ? "This terminal is unavailable or has been closed. Choose another terminal from the selector."
            : "Choose a terminal or launch one from New terminal."}
        </p>
      ) : node.kind === "terminal" ? (
        renderTerminal(terminal.id)
      ) : node.kind === "git" ? (
        <GitPanelBody key={terminal.id} terminal={terminal} paneId={node.id} />
      ) : (
        <FilePanel key={terminal.id} terminal={terminal} active={active === node.id} />
      )}
    </section>
  );
}

export function TerminalWorkspace(props: WorkspaceProps) {
  const desktop = useBreakpoint("lg");
  const [params, setParams] = useSearchParams();
  const [layout, setLayout] = useState<Layout>(() => {
    try {
      const stored = readLayout(JSON.parse(localStorage.getItem("orc_workspace_layout") ?? "null"));
      if (stored) return stored;
    } catch {}
    return {
      id: crypto.randomUUID(),
      kind: "terminal",
      terminalId: props.selected.id,
    };
  });
  const [active, setActive] = useState(() => leaves(layout)[0]?.id ?? layout.id);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const requestedView = params.get("view");
  const requestedPane = params.get("pane");
  const requestedTerminal = params.get("paneTerminal");
  const requestedFile = params.get("file");
  const filesByPane = useRef(new Map<string, string>());
  useEffect(() => {
    if (requestedView !== "files") return;
    const pane =
      leaves(layoutRef.current).find((pane) => pane.id === requestedPane) ??
      leaves(layoutRef.current)[0];
    if (!pane) return;
    const key = `${pane.id}:${requestedTerminal ?? props.selected.id}`;
    if (requestedFile) filesByPane.current.set(key, requestedFile);
    else filesByPane.current.delete(key);
  }, [requestedView, requestedPane, requestedTerminal, requestedFile, props.selected.id]);
  useEffect(() => {
    const view = requestedView === "files" || requestedView === "git" ? requestedView : "terminal";
    const current = layoutRef.current;
    const panes = leaves(current);
    const target = panes.find((pane) => pane.id === requestedPane) ?? panes[0];
    if (!target) return;
    const terminalId = requestedTerminal ?? props.selected.id;
    const occupied =
      view === "terminal"
        ? panes.find(
            (pane) =>
              pane.id !== target.id && pane.kind === "terminal" && pane.terminalId === terminalId,
          )
        : undefined;
    if (occupied) {
      setActive(occupied.id);
      return;
    }
    setActive(target.id);
    if (target.kind === view && target.terminalId === terminalId) return;
    const next = updateLayout(current, target.id, (node) =>
      "kind" in node ? { ...node, kind: view, terminalId } : node,
    );
    layoutRef.current = next;
    setLayout(next);
  }, [requestedView, requestedPane, requestedTerminal, props.selected.id]);

  function publishPane(next: Layout, paneId: string) {
    const pane = leaves(next).find((pane) => pane.id === paneId);
    if (!pane) return;
    const nextParams = new URLSearchParams(params);
    nextParams.set("view", pane.kind);
    nextParams.set("pane", pane.id);
    if (pane.terminalId) nextParams.set("paneTerminal", pane.terminalId);
    else nextParams.delete("paneTerminal");
    const rememberedFile = filesByPane.current.get(`${pane.id}:${pane.terminalId}`);
    if (pane.kind === "files" && rememberedFile) nextParams.set("file", rememberedFile);
    else nextParams.delete("file");
    if (nextParams.toString() !== params.toString()) setParams(nextParams);
  }
  function focusPane(id: string) {
    if (id === active) return;
    setActive(id);
    publishPane(layoutRef.current, id);
  }
  useEffect(() => {
    try {
      localStorage.setItem("orc_workspace_layout", JSON.stringify(layout));
    } catch {}
  }, [layout]);
  const panes = leaves(layout);
  const activePane = panes.find((pane) => pane.id === active) ?? panes[0];
  return (
    <div data-testid="terminal-workspace" className="flex flex-col flex-1 min-h-0 min-w-0">
      {!desktop && panes.length > 1 && (
        <nav
          aria-label="Workspace panes"
          data-testid="mobile-workspace-panes"
          className="flex shrink-0 gap-1 overflow-x-auto border-b border-outline-variant bg-background px-2 py-1"
        >
          {panes.map((pane, index) => (
            <button
              type="button"
              key={pane.id}
              data-testid="mobile-workspace-pane"
              aria-current={pane.id === activePane.id ? "page" : undefined}
              onClick={() => focusPane(pane.id)}
              className={`min-h-11 shrink-0 rounded-md px-3 text-sm ${pane.id === activePane.id ? "bg-surface-highest text-on-surface" : "text-on-surface-variant hover:bg-surface"}`}
            >
              {pane.kind === "terminal" ? "Terminal" : pane.kind === "files" ? "Files" : "Git"}{" "}
              {index + 1}
            </button>
          ))}
        </nav>
      )}
      <WorkspaceTree
        {...props}
        node={layout}
        root={layout}
        active={activePane.id}
        mobile={!desktop}
        focus={focusPane}
        change={(id, update) => {
          const next = updateLayout(layoutRef.current, id, update);
          layoutRef.current = next;
          setLayout(next);
          const target = leaves(next).find((pane) => pane.id === id);
          publishPane(next, target?.id ?? activePane.id);
        }}
        close={(id) => {
          const next = closePane(layoutRef.current, id);
          layoutRef.current = next;
          setLayout(next);
          const nextActive = active === id ? (leaves(next)[0]?.id ?? next.id) : active;
          setActive(nextActive);
          publishPane(next, nextActive);
        }}
      />
    </div>
  );
}

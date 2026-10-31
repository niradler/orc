import {
  ChevronDown,
  Columns2,
  Ellipsis,
  Files,
  GitBranch,
  PanelsTopLeft,
  PanelTop,
  Rows2,
  TerminalSquare,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { Terminal } from "@/api/client";
import { ActionHelp } from "@/components/ActionHelp";
import { useBreakpoint } from "@/hooks/useMediaQuery";
import { openTerminalPalette } from "@/lib/terminal-palette";
import {
  closePane,
  type Layout,
  leaves,
  type Pane,
  readLayout,
  updateLayout,
} from "@/lib/workspace-layout";
import { FilePanel } from "./FilePanel";
import { GitPanelBody } from "./GitPanel";
import { TerminalCheckout } from "./TerminalCheckout";
import { TerminalPaneLinks } from "./TerminalPaneLinks";
import "./TerminalWorkspace.css";

type WorkspaceProps = {
  selected: Terminal;
  terminals: Terminal[];
  renderTerminal: (id: string) => ReactNode;
  renderActions: (terminal: Terminal, active: boolean) => ReactNode;
  renderOptions: (terminal: Terminal) => ReactNode;
};
type TreeProps = WorkspaceProps & {
  node: Layout;
  root: Layout;
  active: string;
  focus: (id: string) => void;
  change: (id: string, update: (node: Layout) => Layout) => void;
  close: (id: string) => void;
  mobile: boolean;
  zoomed: string | null;
  zoom: (id: string | null) => void;
};
function WorkspaceTree(props: TreeProps) {
  const {
    node,
    root,
    terminals,
    active,
    focus,
    change,
    close,
    renderTerminal,
    mobile,
    zoomed,
    zoom,
  } = props;
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
          className={`${(mobile && !leaves(node.first).some((pane) => pane.id === active)) || (zoomed && !leaves(node.first).some((pane) => pane.id === zoomed)) ? "hidden" : "flex"} min-w-0 min-h-0`}
          style={{ flex: mobile || zoomed ? "1 1 0%" : `${node.ratio} 1 0%` }}
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
          className={`${mobile || zoomed ? "hidden" : ""} shrink-0 bg-border hover:bg-surface focus-visible:bg-focus touch-none ${horizontal ? "w-2 cursor-col-resize" : "h-2 cursor-row-resize"}`}
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
          className={`${(mobile && !leaves(node.second).some((pane) => pane.id === active)) || (zoomed && !leaves(node.second).some((pane) => pane.id === zoomed)) ? "hidden" : "flex"} min-w-0 min-h-0`}
          style={{ flex: mobile || zoomed ? "1 1 0%" : `${100 - node.ratio} 1 0%` }}
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
    zoom(null);
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
      className={`terminal-workspace-pane flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden border ${active === node.id ? "border-outline-variant" : "border-transparent"}`}
    >
      <header className="flex shrink-0 gap-1 items-center p-1.5 bg-background border-b border-outline-variant">
        <fieldset
          data-testid="pane-view"
          data-view={node.kind}
          aria-label="Pane view"
          className="flex items-center rounded-md bg-surface p-0.5"
        >
          {(
            [
              { kind: "terminal", label: "Terminal", icon: TerminalSquare },
              { kind: "files", label: "Files", icon: Files },
              { kind: "git", label: "Git", icon: GitBranch },
            ] as const
          ).map(({ kind, label, icon: Icon }) => (
            <button
              type="button"
              key={kind}
              data-testid={`pane-view-${kind}`}
              aria-label={label}
              aria-pressed={node.kind === kind}
              onClick={() => {
                setPane({
                  kind,
                  terminalId:
                    kind === "terminal" && occupied.has(node.terminalId)
                      ? (terminals.find((terminal) => !occupied.has(terminal.id))?.id ?? null)
                      : node.terminalId,
                });
              }}
              className={`inline-flex items-center justify-center gap-1.5 min-h-11 sm:min-h-8 rounded px-2 text-xs ${node.kind === kind ? "bg-surface-highest text-on-surface" : "text-on-surface-variant hover:text-on-surface"}`}
            >
              <Icon size={14} />
              <span className="pane-view-label">{label}</span>
            </button>
          ))}
        </fieldset>
        <div className="flex-1 min-w-0 flex items-center gap-3 overflow-hidden px-1">
          {terminal && (
            <>
              <span
                className="min-w-0 flex-1 truncate text-xs text-on-surface"
                title={`${terminal.name} · ${terminal.host ?? "Local"} · ${terminal.cwd ?? ""}`}
              >
                <span data-testid="terminal-name">{terminal.name}</span>
                {terminal.host && (
                  <span
                    data-testid="terminal-selected-host"
                    className="ml-2 text-on-surface-variant"
                  >
                    {terminal.host}
                  </span>
                )}
              </span>
              {node.kind !== "git" && (
                <div className="pane-checkout-context min-w-0 max-w-72">
                  <TerminalCheckout terminal={terminal} paneId={node.id} />
                </div>
              )}
              <TerminalPaneLinks terminal={terminal} paneId={node.id} />
            </>
          )}
        </div>
        <button
          type="button"
          data-testid="pane-terminal"
          data-terminal-id={terminal?.id ?? ""}
          aria-label="Find and switch terminal"
          aria-haspopup="dialog"
          title={`Find terminal: ${terminal?.name ?? "None selected"}`}
          className="shrink-0 inline-flex items-center justify-center min-h-11 w-11 sm:min-h-8 sm:w-10 rounded-md text-on-surface-variant hover:bg-surface"
          onClick={() =>
            openTerminalPalette({
              currentId: terminal?.id ?? null,
              select: (id) => {
                const existing = leaves(root).find(
                  (pane) => pane.kind === "terminal" && pane.terminalId === id,
                );
                if (node.kind === "terminal" && existing && existing.id !== node.id) {
                  zoom(null);
                  focus(existing.id);
                  return;
                }
                setPane({ terminalId: id });
              },
            })
          }
        >
          <TerminalSquare size={16} aria-hidden="true" />
          <ChevronDown size={11} aria-hidden="true" />
        </button>
        {terminal && props.renderActions(terminal, active === node.id)}
        <div className="pane-extra-actions items-center gap-1">
          <ActionHelp label="Split side by side">
            <button
              type="button"
              data-testid="pane-split-horizontal"
              aria-label="Split side by side"
              disabled={leaves(root).length >= 8}
              onClick={() => split("row")}
              className="min-h-11 min-w-11 sm:min-h-8 sm:min-w-8 inline-flex items-center justify-center rounded-md text-primary hover:bg-surface disabled:opacity-40"
            >
              <Columns2 size={16} />
            </button>
          </ActionHelp>
          <ActionHelp label="Split top and bottom">
            <button
              type="button"
              data-testid="pane-split-vertical"
              aria-label="Split top and bottom"
              disabled={leaves(root).length >= 8}
              onClick={() => split("column")}
              className="min-h-11 min-w-11 sm:min-h-8 sm:min-w-8 inline-flex items-center justify-center rounded-md text-primary hover:bg-surface disabled:opacity-40"
            >
              <Rows2 size={16} />
            </button>
          </ActionHelp>
          {leaves(root).length > 1 && (
            <ActionHelp label={zoomed ? "Restore split layout" : "Expand pane"}>
              <button
                type="button"
                data-testid="pane-focus"
                aria-label={zoomed ? "Restore split layout" : "Expand pane"}
                aria-pressed={!!zoomed}
                onClick={() => zoom(zoomed ? null : node.id)}
                className="min-h-11 min-w-11 sm:min-h-8 sm:min-w-8 inline-flex items-center justify-center rounded-md text-on-surface-variant hover:bg-surface"
              >
                {zoomed ? <PanelsTopLeft size={15} /> : <PanelTop size={15} />}
              </button>
            </ActionHelp>
          )}
          {leaves(root).length > 1 && (
            <ActionHelp
              label="Close pane (keep terminal running)"
              description="Close pane; terminal keeps running"
            >
              <button
                type="button"
                data-testid="pane-close"
                aria-label="Close pane (keep terminal running)"
                onClick={() => close(node.id)}
                className="min-h-11 min-w-11 sm:min-h-8 sm:min-w-8 inline-flex items-center justify-center rounded-md text-on-surface-variant hover:bg-surface"
              >
                <X size={16} />
              </button>
            </ActionHelp>
          )}
        </div>
        <details
          className="relative"
          onKeyDown={(event) => {
            if (event.key === "Escape") event.currentTarget.removeAttribute("open");
          }}
          onClick={(event) => {
            if ((event.target as HTMLElement).closest("button"))
              event.currentTarget.removeAttribute("open");
          }}
        >
          <summary
            data-testid="pane-actions"
            aria-label="Pane actions"
            title="Pane actions"
            className="list-none flex min-h-11 min-w-11 sm:min-h-8 sm:min-w-8 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11 items-center justify-center rounded-md text-on-surface-variant hover:bg-surface cursor-pointer"
          >
            <Ellipsis size={18} />
          </summary>
          <div className="absolute right-0 top-full z-30 w-60 rounded-md border border-outline-variant bg-surface-high p-2 shadow-lg">
            {terminal && props.renderOptions(terminal)}
            <div className="pane-menu-layout-actions">
              <button
                type="button"
                data-testid="pane-action-split-horizontal"
                disabled={leaves(root).length >= 8}
                onClick={() => split("row")}
                className="w-full text-left min-h-11 px-2 rounded hover:bg-surface"
              >
                Split side by side
              </button>
              <button
                type="button"
                data-testid="pane-action-split-vertical"
                disabled={leaves(root).length >= 8}
                onClick={() => split("column")}
                className="w-full text-left min-h-11 px-2 rounded hover:bg-surface"
              >
                Split top and bottom
              </button>
              {leaves(root).length > 1 && (
                <>
                  <button
                    type="button"
                    data-testid="pane-action-focus"
                    onClick={() => zoom(zoomed ? null : node.id)}
                    className="w-full text-left min-h-11 px-2 rounded hover:bg-surface"
                  >
                    {zoomed ? "Restore split layout" : "Expand pane"}
                  </button>
                  <button
                    type="button"
                    data-testid="pane-action-close"
                    onClick={() => close(node.id)}
                    className="w-full text-left min-h-11 px-2 rounded hover:bg-surface"
                  >
                    Close pane
                  </button>
                </>
              )}
            </div>
          </div>
        </details>
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
        <FilePanel
          key={terminal.id}
          terminal={terminal}
          active={active === node.id}
          paneId={node.id}
        />
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
  const [zoomed, setZoomed] = useState<string | null>(null);
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
    setZoomed((current) => (current && current !== target.id ? null : current));
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
    setLayout((previous) => {
      const latest = leaves(previous).find((pane) => pane.id === target.id);
      if (!latest || (latest.kind === view && latest.terminalId === terminalId)) return previous;
      const next = updateLayout(previous, target.id, (node) =>
        "kind" in node ? { ...node, kind: view, terminalId } : node,
      );
      layoutRef.current = next;
      return next;
    });
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
    if (zoomed) setZoomed(id);
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
        zoomed={panes.some((pane) => pane.id === zoomed) ? zoomed : null}
        zoom={setZoomed}
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
          setZoomed(null);
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

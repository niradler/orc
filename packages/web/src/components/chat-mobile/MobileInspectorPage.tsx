import { ChevronLeft } from "lucide-react";
import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { InspectorChangesHelp } from "@/components/inspector/InspectorChangesHelp";
import { InspectorOverview, useInspectorGit } from "@/components/inspector/InspectorOverview";
import { InspectorTabs } from "@/components/inspector/InspectorTabs";
import type { SessionContext } from "@/components/SessionHome";
import { FilePanel } from "@/components/terminals/FilePanel";
import { GitPanelBody } from "@/components/terminals/GitPanel";
import type { SessionHomeNav } from "@/hooks/useSessionHome";
import { INSPECTOR_PANE_ID, type InspectorTab, inspectorFileParams } from "@/lib/session-home";

/** The phone Inspector page: the same Overview, combined Changes tab (working
 *  tree + the branch's PR review) and Files tabs as the desktop inspector,
 *  full-width and driven by the `inspector` URL param. */
export function MobileInspectorPage({
  context,
  home,
}: {
  context: SessionContext;
  home: SessionHomeNav;
}) {
  const tab: InspectorTab = home.inspector ?? "overview";
  const git = context.gitTerminal;
  const [, setParams] = useSearchParams();
  const root = useRef<HTMLElement>(null);
  const close = () => home.go({ inspector: null });
  // biome-ignore lint/correctness/useExhaustiveDependencies: focus and Escape bind once when the page opens
  useEffect(() => {
    root.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) home.go({ inspector: null });
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.querySelector<HTMLElement>('[data-testid="session-inspector-toggle"]')?.focus();
    };
  }, []);
  const { status } = useInspectorGit(git);
  // The Browser tab is desktop-only; a shared URL that names it falls back here.
  const shown: InspectorTab =
    tab === "browser" ? "overview" : tab === "overview" || git ? tab : "overview";
  return (
    <section
      ref={root}
      tabIndex={-1}
      data-testid="session-inspector"
      aria-label="Inspector"
      className="absolute inset-0 z-30 flex flex-col bg-background outline-none"
    >
      <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border px-2">
        <button
          type="button"
          aria-label="Close inspector"
          onClick={close}
          className="inline-flex size-11 shrink-0 items-center justify-center rounded-md text-on-surface-variant hover:bg-surface hover:text-on-surface"
        >
          <ChevronLeft size={20} />
        </button>
        <div className="min-w-0 flex-1 px-1">
          <h2 className="text-base font-medium leading-tight">Inspector</h2>
          <p className="truncate text-xs text-muted-foreground">
            {git ? (status.data?.root ?? context.cwd ?? "Git checkout") : "Session details"}
          </p>
        </div>
      </header>
      <InspectorTabs
        git={!!git}
        shown={shown}
        onSelect={(next) => home.go({ inspector: next }, { replace: true })}
        className="shrink-0 border-b border-border px-2 py-1.5"
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {shown === "overview" && <InspectorOverview context={context} home={home} />}
        {shown === "diff" && git && (
          <div className="inspector-host flex h-full min-h-0 flex-col">
            <GitPanelBody
              terminal={git}
              paneId={INSPECTOR_PANE_ID}
              persistDraft
              copyPath
              help={<InspectorChangesHelp />}
              onOpenFile={(path) =>
                setParams((current) => inspectorFileParams(current, { terminalId: git.id, path }), {
                  replace: true,
                })
              }
            />
          </div>
        )}
        {shown === "files" && git && (
          <div className="flex h-full min-h-0 flex-col">
            <FilePanel terminal={git} paneId={INSPECTOR_PANE_ID} active />
          </div>
        )}
      </div>
    </section>
  );
}

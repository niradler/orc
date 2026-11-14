import { type ReactNode, useLayoutEffect, useRef } from "react";
import { MobileInspectorPage } from "@/components/chat-mobile/MobileInspectorPage";
import { MobileSessionsPage } from "@/components/chat-mobile/MobileSessionsPage";
import { MobileTerminalPage } from "@/components/chat-mobile/MobileTerminalPage";
import type { SessionContext } from "@/components/SessionHome";
import { type MobilePanelTarget, useMobilePanelGestures } from "@/hooks/useMobilePanelGestures";
import type { SessionHomeNav } from "@/hooks/useSessionHome";

const OFFSCREEN: Record<MobilePanelTarget, string> = {
  sessions: "translateX(100%)",
  inspector: "translateX(-100%)",
  terminal: "translateY(-100%)",
};

function PanelWrapper({
  target,
  dragging,
  register,
  children,
}: {
  target: MobilePanelTarget;
  dragging: boolean;
  register: (target: MobilePanelTarget, node: HTMLDivElement | null) => void;
  children: ReactNode;
}) {
  const local = useRef<HTMLDivElement | null>(null);
  const entered = useRef(false);
  const wasDragged = useRef(false);
  useLayoutEffect(() => {
    const element = local.current;
    if (!element) return;
    if (dragging) {
      // The gesture owns the transform; never replay an entrance over it.
      wasDragged.current = true;
      return;
    }
    if (entered.current || wasDragged.current) return;
    entered.current = true;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // URL-driven open (button, deep link, Back): slide in from the panel's edge.
    element.style.transform = OFFSCREEN[target];
    void element.getBoundingClientRect();
    element.style.transition = "transform 160ms ease-out";
    element.style.transform = "";
    const timer = window.setTimeout(() => {
      element.style.transition = "";
    }, 200);
    return () => window.clearTimeout(timer);
  }, [dragging, target]);
  return (
    <div
      ref={(node) => {
        local.current = node;
        register(target, node);
      }}
      data-testid={`mobile-panel-${target}`}
      className="absolute inset-0 z-30 will-change-transform"
    >
      {children}
    </div>
  );
}

/** Phone chat frame: the conversation stays mounted underneath while Sessions,
 *  Inspector and Terminal pages slide over it, driven by touch or the URL.
 *  Disabled (tablet/desktop) it passes the column through untouched. */
export function MobileChatShell({
  enabled,
  home,
  context,
  children,
}: {
  enabled: boolean;
  home: SessionHomeNav;
  context: SessionContext;
  children: ReactNode;
}) {
  const openPanel: MobilePanelTarget | null = home.drawer
    ? "terminal"
    : home.inspector
      ? "inspector"
      : home.listOpen
        ? "sessions"
        : null;
  const { frameRef, registerPanel, dragTarget } = useMobilePanelGestures({
    enabled,
    openPanel,
    onOpen: (target) =>
      home.go({
        listOpen: target === "sessions",
        inspector: target === "inspector" ? "overview" : null,
        drawer: target === "terminal",
      }),
    onClose: () => home.go({ listOpen: false, inspector: null, drawer: false }),
  });
  const mounted = (target: MobilePanelTarget) =>
    enabled && (openPanel === target || dragTarget === target);
  // One stable DOM shape for every breakpoint: crossing md must never remount
  // the conversation, composer or an open settings dialog.
  return (
    <div
      ref={frameRef}
      data-testid="mobile-chat-frame"
      className="relative flex min-h-0 min-w-0 flex-1"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col" inert={enabled && openPanel !== null}>
        {children}
      </div>
      {mounted("sessions") && (
        <PanelWrapper
          target="sessions"
          dragging={dragTarget === "sessions"}
          register={registerPanel}
        >
          <MobileSessionsPage home={home} />
        </PanelWrapper>
      )}
      {mounted("inspector") && (
        <PanelWrapper
          target="inspector"
          dragging={dragTarget === "inspector"}
          register={registerPanel}
        >
          <MobileInspectorPage context={context} home={home} />
        </PanelWrapper>
      )}
      {mounted("terminal") && (
        <PanelWrapper
          target="terminal"
          dragging={dragTarget === "terminal"}
          register={registerPanel}
        >
          <MobileTerminalPage context={context} home={home} />
        </PanelWrapper>
      )}
    </div>
  );
}

import type { OrcNotification } from "@orc/core/notifications";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bell,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  MoreHorizontal,
  X,
} from "lucide-react";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api } from "@/api/client";
import { RequestCard, type RequestDraft } from "@/components/RequestCard";
import { Button } from "@/components/ui/button";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useActiveLiveSessionsSummary } from "@/hooks/useActiveLiveSessions";
import { CHAT_THREAD_PARAM, useChat } from "@/hooks/useChat";
import { useHumanRequests } from "@/hooks/useHumanRequests";
import { useBreakpoint } from "@/hooks/useMediaQuery";
import { useProjects } from "@/hooks/useProjects";
import { useResourceFallback } from "@/hooks/useResourceFallback";
import { desktopBridge } from "@/lib/desktop-bridge";
import { NotificationFeed, notificationInView } from "@/lib/notification-feed";
import {
  getNotificationPrefs,
  playNeedsYouSound,
  unlockNotificationSound,
} from "@/lib/notification-sound";
import { formatRelative } from "@/lib/relative-time";
import { sessionPath } from "@/lib/session-links";
import { cn } from "@/lib/utils";

export const FOCUS_NOTIFICATIONS_EVENT = "orc-focus-notifications";
export const NOTIFICATIONS_SHORTCUT = "Alt+N";
const PAGE_SIZE = 50;
const GROUP_MODE_KEY = "orc_notifications_group_mode";
const labels: Record<string, string> = {
  "human.request": "Human request",
  "agent.question": "Question",
  "agent.approval": "Approval",
  "agent.finished": "Agent finished",
  "agent.failed": "Agent failed",
  "job.finished": "Job finished",
  "job.failed": "Job failed",
};

type Center = {
  unread: number;
  /** Increments once per delivered notification burst; the bell jumps on each. */
  pulse: number;
  expanded: boolean;
  anchor: HTMLElement | null;
  show: (anchor: HTMLElement) => void;
  close: () => void;
  phone: boolean;
  items: OrcNotification[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
  showRead: boolean;
  toggleShowRead: () => void;
  needsYou: boolean;
  toggleNeedsYou: () => void;
  selected: string | null;
  setSelected: (id: string | null) => void;
  drafts: Record<string, RequestDraft>;
  onDraft: (id: string, update: Partial<RequestDraft>) => void;
  busy: boolean;
  mutationError: string | null;
  setRead: (id: string, read: boolean) => void;
  dismiss: (id: string) => void;
  markAllRead: () => void;
  markAllBusy: boolean;
  hasNextPage: boolean;
  fetchingNextPage: boolean;
  fetchNextPage: () => void;
  openItem: (item: OrcNotification) => void;
};
const CenterContext = createContext<Center | null>(null);

export function useNotificationCenter(): Center {
  const center = useContext(CenterContext);
  if (!center) throw new Error("useNotificationCenter must be used inside AgentNotifications");
  return center;
}

/** Default scope and the chat's assigned identity do not navigate away from the open menu. */
function menuPlace({ pathname, search }: { pathname: string; search: string }): string {
  const params = new URLSearchParams(search);
  params.delete("project");
  params.delete(CHAT_THREAD_PARAM);
  return `${pathname}?${params}`;
}

/** Phone navigation target for the bell: a full page, never a modal. */
export function notificationsPath(search: string): string {
  const params = new URLSearchParams(search);
  params.delete("chat");
  params.delete(CHAT_THREAD_PARAM);
  params.delete("notifications");
  return `/notifications?${params}`;
}

export function AgentNotifications({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const phone = !useBreakpoint("md");
  const { tabs, activeKey, projectScope } = useChat();
  const requests = useHumanRequests();
  const summary = useActiveLiveSessionsSummary();
  const viewParams = new URLSearchParams(location.search);
  const viewedSessionId =
    location.pathname === "/chat"
      ? (viewParams.get("sessionLive") ??
        viewParams.get("sessionView") ??
        tabs.find((tab) => tab.key === activeKey)?.thread?.sourceId ??
        null)
      : null;
  const viewedSession = useQuery({
    queryKey: ["sessions", "live-one", viewedSessionId],
    queryFn: () => api.sessions.liveOne(viewedSessionId as string),
    enabled: !!viewedSessionId,
    retry: false,
  }).data;
  const sessions = useMemo(
    () =>
      viewedSession ? [viewedSession, ...(summary.data?.sessions ?? [])] : summary.data?.sessions,
    [viewedSession, summary.data],
  );
  const [expanded, setExpanded] = useState(false);
  const [showRead, setShowRead] = useState(false);
  const [needsYou, setNeedsYou] = useState(false);
  const menuLocation = useRef(location);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, RequestDraft>>({});
  const [pulse, setPulse] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const feed = useRef(new NotificationFeed());
  // Completion IDs already settled for the open view; the inbox refetch catches up.
  const acknowledged = useRef(new Set<string>());
  const acknowledge = useRef<(items: readonly OrcNotification[]) => void>(() => {});
  const delivery = useRef({
    location,
    tabs,
    activeKey,
    requests: requests.data,
    sessions,
  });
  delivery.current = {
    location,
    tabs,
    activeKey,
    requests: requests.data,
    sessions,
  };
  const notificationProject = projectScope === "all" ? undefined : projectScope;
  const query = useInfiniteQuery({
    queryKey: ["notifications", { showRead, project: notificationProject ?? "all" }],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      api.notifications.list({
        limit: PAGE_SIZE,
        offset: pageParam,
        unread: !showRead,
        ...(notificationProject ? { project_id: notificationProject } : {}),
      }),
    getNextPageParam: (last, _pages, offset) => (last.has_more ? offset + PAGE_SIZE : undefined),
    refetchInterval: useResourceFallback(),
  });
  const items = useMemo(
    () => [
      ...new Map(
        (query.data?.pages.flatMap((page) => page.notifications) ?? []).map((item) => [
          item.id,
          item,
        ]),
      ).values(),
    ],
    [query.data],
  );
  const unread = query.data?.pages[0]?.unread ?? 0;
  useEffect(() => {
    document.title = unread ? `(${unread}) Notifications · ORC` : "ORC";
  }, [unread]);
  const refresh = () => client.invalidateQueries({ queryKey: ["notifications"] });
  const update = useMutation({
    mutationFn: ({ id, ...change }: { id: string; read?: boolean; dismissed?: boolean }) =>
      api.notifications.update(id, change),
    onSuccess: () => {
      void refresh();
    },
  });
  const markAll = useMutation({
    mutationFn: api.notifications.markAllRead,
    onSuccess: () => {
      void refresh();
    },
  });
  acknowledge.current = (settled) => {
    for (const item of settled)
      update.mutate(
        { id: item.id, read: true, dismissed: true },
        { onError: () => acknowledged.current.delete(item.id) },
      );
  };
  const show = (element: HTMLElement) => {
    setAnchor(element);
    setExpanded(true);
  };
  const onDraft = (id: string, updateDraft: Partial<RequestDraft>) =>
    setDrafts((current) => ({
      ...current,
      [id]: {
        ...(current[id] ?? { answer: "", selected: [], editingAnswer: true }),
        ...updateDraft,
      },
    }));

  useEffect(() => {
    const latest = query.data?.pages[0]?.notifications;
    if (!latest) return;
    feed.current.update(latest, Date.now());
  }, [query.data]);

  const activeThreadId = tabs.find((tab) => tab.key === activeKey)?.thread?.id ?? null;
  const activeThreadSourceId = tabs.find((tab) => tab.key === activeKey)?.thread?.sourceId ?? null;
  // A completion for the chat or session already on screen is settled instead of
  // waiting unread in the bell; the visible conversation is the acknowledgement.
  useEffect(() => {
    if (document.visibilityState === "hidden" || !document.hasFocus()) return;
    const view = {
      active: true,
      pathname: location.pathname,
      search: location.search,
      chatThreadId: activeThreadId,
      threadSourceId: activeThreadSourceId,
      sessions,
      requests: requests.data,
    };
    const settled = items.filter(
      (item) =>
        item.level === "done" &&
        !item.read_at &&
        !item.dismissed_at &&
        !acknowledged.current.has(item.id) &&
        notificationInView(item, view),
    );
    if (!settled.length) return;
    for (const item of settled) acknowledged.current.add(item.id);
    acknowledge.current(settled);
  }, [
    items,
    location.pathname,
    location.search,
    activeThreadId,
    activeThreadSourceId,
    sessions,
    requests.data,
  ]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const state = delivery.current;
      const incoming = feed.current.flush(Date.now(), (item) => {
        if (document.visibilityState === "hidden" || !document.hasFocus()) return false;
        return notificationInView(item, {
          active: true,
          pathname: state.location.pathname,
          search: state.location.search,
          chatThreadId: state.tabs.find((tab) => tab.key === state.activeKey)?.thread?.id ?? null,
          threadSourceId:
            state.tabs.find((tab) => tab.key === state.activeKey)?.thread?.sourceId ?? null,
          sessions: state.sessions,
          requests: state.requests ?? undefined,
        });
      });
      if (!incoming.length) return;
      setPulse((current) => current + 1);
      setAnnouncement(
        incoming.length > 1 ? `${incoming.length} new notifications` : (incoming[0]?.title ?? ""),
      );
      const prefs = getNotificationPrefs();
      if (
        prefs.sound &&
        incoming.some(
          (item) =>
            item.level === "needs-you" &&
            (!item.project_id || !prefs.mutedProjects.includes(item.project_id)),
        )
      )
        playNeedsYouSound(prefs.volume);
      for (const item of incoming)
        desktopBridge()?.notify?.({
          title: item.title,
          body: item.body || labels[item.type] || "Update",
          level: item.level,
          path: item.path,
          id: item.id,
        });
    }, 250);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const openFromKeyboard = () => {
      const button = document.querySelector<HTMLButtonElement>('[data-testid="notification-bell"]');
      button?.click();
    };
    const keydown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        !event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.code !== "KeyN"
      )
        return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest('[data-testid="terminal-viewport"]')
      )
        return;
      event.preventDefault();
      openFromKeyboard();
    };
    window.addEventListener("keydown", keydown);
    window.addEventListener(FOCUS_NOTIFICATIONS_EVENT, openFromKeyboard);
    return () => {
      window.removeEventListener("keydown", keydown);
      window.removeEventListener(FOCUS_NOTIFICATIONS_EVENT, openFromKeyboard);
    };
  }, []);

  useEffect(() => {
    const unlock = () => unlockNotificationSound();
    document.addEventListener("pointerdown", unlock, { capture: true });
    document.addEventListener("keydown", unlock, { capture: true });
    return () => {
      document.removeEventListener("pointerdown", unlock, { capture: true });
      document.removeEventListener("keydown", unlock, { capture: true });
    };
  }, []);
  // A desktop OS notification click reports its ORC notification id; acknowledge it
  // (same as clicking in-app) so it stops counting as outstanding, then navigate.
  const acknowledgeRef = useRef<(id: string) => void>(() => {});
  acknowledgeRef.current = (id: string) => update.mutate({ id, read: true });
  useEffect(
    () =>
      desktopBridge()?.onOpen((path, id) => {
        if (id) acknowledgeRef.current(id);
        if (path.startsWith("/") && !path.startsWith("//") && !path.includes("\\")) navigate(path);
      }),
    [navigate],
  );
  useEffect(() => {
    if (menuPlace(menuLocation.current) !== menuPlace(location)) setExpanded(false);
    menuLocation.current = location;
  }, [location]);
  const linkParams = new URLSearchParams(location.search);
  const notificationLink =
    location.pathname === "/activity" && linkParams.get("notifications") === "open";
  const linkedRequest = linkParams.get("request");
  useEffect(() => {
    if (!notificationLink) return;
    if (linkedRequest) setSelected(linkedRequest);
    // Phones review notifications on their own page, not in an anchored popover.
    if (phone) {
      navigate(notificationsPath(window.location.search), { replace: true });
      return;
    }
    const timer = window.setTimeout(() => {
      const button = document.querySelector<HTMLButtonElement>('[data-testid="notification-bell"]');
      if (button) {
        setAnchor(button);
        setExpanded(true);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [notificationLink, linkedRequest, phone, navigate]);

  const openItem = (item: OrcNotification) => {
    if (!item.read_at) update.mutate({ id: item.id, read: true });
    if (item.type === "human.request") {
      setSelected(item.source_id);
      if (phone) {
        if (location.pathname !== "/notifications") {
          // Parse the path as a URL: URLSearchParams alone would treat
          // "/notifications?project=…" as one query key and drop the scope.
          const target = new URL(notificationsPath(location.search), window.location.origin);
          target.searchParams.set("request", item.source_id);
          navigate(target.pathname + target.search);
        }
        return;
      }
      const button = document.querySelector<HTMLButtonElement>('[data-testid="notification-bell"]');
      if (button) show(button);
    } else {
      setExpanded(false);
      navigate(sessionPath(item.path));
    }
  };

  const center: Center = {
    unread,
    pulse,
    expanded,
    anchor,
    show,
    close: () => setExpanded(false),
    phone,
    items,
    loading: query.isPending,
    error: query.error?.message ?? null,
    refresh,
    showRead,
    toggleShowRead: () => setShowRead((current) => !current),
    needsYou,
    toggleNeedsYou: () => setNeedsYou((current) => !current),
    selected,
    setSelected,
    drafts,
    onDraft,
    busy: update.isPending,
    mutationError: update.error?.message ?? markAll.error?.message ?? null,
    setRead: (id, read) => update.mutate({ id, read }),
    dismiss: (id) => update.mutate({ id, dismissed: true }),
    markAllRead: () => {
      setSelected(null);
      // Only what the scoped inbox shows, so another project's unread items survive.
      markAll.mutate(notificationProject);
    },
    markAllBusy: markAll.isPending,
    hasNextPage: query.hasNextPage,
    fetchingNextPage: query.isFetchingNextPage,
    fetchNextPage: () => void query.fetchNextPage(),
    openItem,
  };

  return (
    <CenterContext.Provider value={center}>
      <Popover open={expanded} onOpenChange={setExpanded} modal>
        {children}
        <PopoverAnchor virtualRef={{ current: anchor }} />
        <PopoverContent
          align="end"
          data-testid="notification-menu"
          aria-label="Notifications"
          className="z-[70] w-[min(30rem,calc(100vw-2rem))] max-h-[min(75dvh,var(--radix-popover-content-available-height))] p-0"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            anchor?.focus();
          }}
        >
          <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-surface-high px-3 py-2">
            <h2 className="min-w-0 flex-1 text-sm font-medium">Notifications</h2>
            <Button
              size="sm"
              variant="ghost"
              data-testid="notifications-mark-all-read"
              disabled={!unread || markAll.isPending}
              onClick={center.markAllRead}
            >
              <CheckCheck /> Mark all read
            </Button>
            <Button
              size="icon"
              variant="ghost"
              aria-label="Close notifications"
              onClick={() => setExpanded(false)}
            >
              <X />
            </Button>
          </div>
          <NotificationListBody />
        </PopoverContent>
      </Popover>
      <div data-testid="agent-notification-live" aria-live="polite" className="sr-only">
        {announcement}
      </div>
    </CenterContext.Provider>
  );
}

/**
 * One notification inbox logic for every surface: the desktop popover and the
 * phone full page share filters, session grouping and project sections.
 * `onOpenRequest` expands a human request inline (page); without it the request
 * opens through the center's responsive `openItem` (popover on desktop).
 */
export function NotificationListBody({ onOpenRequest }: { onOpenRequest?: (id: string) => void }) {
  const center = useNotificationCenter();
  const projects = useProjects();
  const selectedDetails = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<"latest" | "project">(() => {
    try {
      return localStorage.getItem(GROUP_MODE_KEY) === "project" ? "project" : "latest";
    } catch {
      return "latest";
    }
  });
  const changeMode = (next: "latest" | "project") => {
    setMode(next);
    try {
      localStorage.setItem(GROUP_MODE_KEY, next);
    } catch {
      // The mode still applies for this visit when storage is unavailable.
    }
  };
  const shown = center.needsYou
    ? center.items.filter((item) => item.requires_action)
    : center.items;
  // Updates from one session/request collapse into a quiet summary row.
  const groups = useMemo(() => {
    const map = new Map<string, OrcNotification[]>();
    for (const item of shown) {
      const list = map.get(item.source_id);
      if (list) list.push(item);
      else map.set(item.source_id, [item]);
    }
    return [...map.values()];
  }, [shown]);
  const sections = useMemo(() => {
    if (mode === "latest") return [{ id: "all", name: null as string | null, groups }];
    const map = new Map<string, { id: string; name: string; groups: OrcNotification[][] }>();
    for (const group of groups) {
      const pid = group[0].project_id ?? "none";
      const name =
        pid === "none"
          ? "No project"
          : (projects.data?.find((project) => project.id === pid)?.name ?? "Unknown project");
      const section = map.get(pid) ?? { id: pid, name, groups: [] };
      section.groups.push(group);
      map.set(pid, section);
    }
    return [...map.values()];
  }, [mode, groups, projects.data]);
  useEffect(() => {
    if (center.selected) selectedDetails.current?.scrollIntoView({ block: "nearest" });
  }, [center.selected]);
  // When a read filter removes the selected row, its card remounts in the stable
  // fallback slot; return focus to the answer so an in-progress draft keeps typing.
  useEffect(() => {
    if (!center.selected) return;
    if (shown.some((item) => item.type === "human.request" && item.source_id === center.selected))
      return;
    if (document.activeElement && document.activeElement !== document.body) return;
    document
      .querySelector<HTMLInputElement>(
        `[data-testid="attention-request-${center.selected}"] [data-testid="attention-answer"]`,
      )
      ?.focus();
  }, [center.selected, shown]);
  const chip =
    "max-md:min-h-11 pointer-coarse:min-h-11 rounded-md aria-pressed:bg-surface-highest aria-pressed:text-on-surface";
  return (
    <>
      <div className="flex flex-wrap items-center gap-1 border-b border-border px-3 py-1.5">
        <Button
          size="sm"
          variant="ghost"
          data-testid="notifications-show-read"
          aria-pressed={center.showRead}
          className={chip}
          onClick={center.toggleShowRead}
        >
          {center.showRead && <Check />} Show read
        </Button>
        <Button
          size="sm"
          variant="ghost"
          data-testid="notifications-needs-you"
          aria-pressed={center.needsYou}
          className={chip}
          onClick={center.toggleNeedsYou}
        >
          {center.needsYou && <Check />} Needs you
        </Button>
        {/* biome-ignore lint/a11y/useSemanticElements: a toggle-button group is not a form fieldset */}
        <div
          role="group"
          aria-label="Group notifications"
          className="ml-auto flex items-center gap-1"
        >
          <Button
            size="sm"
            variant="ghost"
            data-testid="notifications-mode-latest"
            aria-pressed={mode === "latest"}
            className={chip}
            onClick={() => changeMode("latest")}
          >
            Latest
          </Button>
          <Button
            size="sm"
            variant="ghost"
            data-testid="notifications-mode-project"
            aria-pressed={mode === "project"}
            className={chip}
            onClick={() => changeMode("project")}
          >
            By project
          </Button>
        </div>
      </div>
      <div className="@container/attention px-3">
        {center.loading && (
          <p role="status" className="py-4 text-sm text-outline">
            Loading notifications…
          </p>
        )}
        {center.error && (
          <p role="alert" className="py-3 text-sm text-error">
            {center.error}{" "}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                center.refresh();
              }}
            >
              Retry
            </Button>
          </p>
        )}
        {!center.loading && !center.error && shown.length === 0 && !center.selected && (
          <p data-testid="notifications-empty" className="py-5 text-sm text-outline">
            {center.needsYou
              ? "Nothing needs you right now."
              : center.showRead
                ? "No notifications."
                : "No unread notifications."}
          </p>
        )}
        {sections.map((section) => (
          <section key={section.id} aria-label={section.name ?? "Latest notifications"}>
            {section.name && (
              <h2 className="sticky top-0 z-10 -mx-3 flex items-center gap-2 border-b border-border bg-background px-3 py-2 text-xs font-medium text-outline">
                <span className="truncate">{section.name}</span>
                <span>{section.groups.reduce((count, group) => count + group.length, 0)}</span>
              </h2>
            )}
            {section.groups.map((group) => (
              <NotificationGroup
                key={group[0].source_id}
                items={group}
                onOpenRequest={onOpenRequest}
              />
            ))}
          </section>
        ))}
        {center.selected &&
          !shown.some(
            (item) => item.type === "human.request" && item.source_id === center.selected,
          ) && (
            <div ref={selectedDetails} className="py-2">
              <RequestDetails
                key={center.selected}
                id={center.selected}
                summary="Linked request"
                expanded
                onToggle={() => center.setSelected(null)}
                onNavigate={() => {
                  center.setSelected(null);
                  center.close();
                }}
                drafts={center.drafts}
                onDraft={center.onDraft}
              />
            </div>
          )}
        {center.hasNextPage && (
          <Button
            variant="ghost"
            size="sm"
            className="my-2 w-full max-md:min-h-11"
            disabled={center.fetchingNextPage}
            onClick={center.fetchNextPage}
          >
            <ChevronDown /> Load more
          </Button>
        )}
        {center.mutationError && (
          <p role="alert" className="py-2 text-sm text-error">
            {center.mutationError}
          </p>
        )}
      </div>
    </>
  );
}

/** A session/source with several updates collapses to one quiet summary row. */
function NotificationGroup({
  items,
  onOpenRequest,
}: {
  items: OrcNotification[];
  onOpenRequest?: (id: string) => void;
}) {
  const center = useNotificationCenter();
  const [open, setOpen] = useState(false);
  const latest = items[0];
  const selectedHere = items.some(
    (item) => item.type === "human.request" && item.source_id === center.selected,
  );
  if (items.length === 1) return <NotificationRow item={latest} onOpenRequest={onOpenRequest} />;
  const expanded = open || selectedHere;
  const unread = items.filter((item) => !item.read_at).length;
  const urgent = items.some((item) => item.requires_action);
  return (
    <div
      data-testid="notification-group"
      data-source-id={latest.source_id}
      className="border-b border-border py-2 last:border-b-0"
    >
      <button
        type="button"
        data-testid="notification-group-toggle"
        aria-expanded={expanded}
        onClick={() => setOpen((current) => !current)}
        className="flex min-h-11 w-full min-w-0 items-start gap-1 rounded px-1 py-1 text-left focus-visible:outline-2 focus-visible:outline-focus"
      >
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 text-xs text-outline">
            {unread > 0 && (
              <span
                role="img"
                aria-label={`${unread} unread`}
                className="size-1.5 shrink-0 rounded-full bg-primary"
              />
            )}
            <span className="truncate">{items.length} updates</span>
            {urgent && <span className="shrink-0 text-warning">Needs you</span>}
            <time
              className="ml-auto shrink-0"
              dateTime={new Date(latest.created_at).toISOString()}
              title={new Date(latest.created_at).toLocaleString()}
            >
              {formatRelative(latest.created_at)}
            </time>
          </span>
          <span
            className={cn(
              "mt-0.5 block line-clamp-2 text-sm leading-5 wrap-break-word",
              unread > 0 && "font-medium",
            )}
          >
            {latest.title}
          </span>
        </span>
        <ChevronRight
          aria-hidden="true"
          size={14}
          className={cn(
            "mt-1 shrink-0 text-outline motion-safe:transition-transform",
            expanded && "rotate-90",
          )}
        />
      </button>
      {expanded && (
        <div className="ml-1.5 border-l border-border pl-2">
          {items.map((item) => (
            <NotificationRow key={item.id} item={item} onOpenRequest={onOpenRequest} />
          ))}
        </div>
      )}
    </div>
  );
}

function NotificationRow({
  item,
  onOpenRequest,
}: {
  item: OrcNotification;
  onOpenRequest?: (id: string) => void;
}) {
  const center = useNotificationCenter();
  const isRequest = item.type === "human.request";
  const expandedHere = isRequest && center.selected === item.source_id;
  return (
    <div
      data-testid="notification-item"
      data-notification-id={item.id}
      data-type={item.type}
      data-source-id={item.source_id}
      className="border-b border-border py-2 last:border-b-0"
    >
      <div className="flex items-start gap-1">
        {isRequest && !expandedHere ? (
          // Requests keep the shared review card so answering works identically
          // in the popover and on the page.
          <div className="min-w-0 flex-1">
            <RequestDetails
              id={item.source_id}
              summary={item.title}
              expanded={false}
              onToggle={() =>
                onOpenRequest ? onOpenRequest(item.source_id) : center.openItem(item)
              }
              onNavigate={() => {
                center.setSelected(null);
                center.close();
              }}
              drafts={center.drafts}
              onDraft={center.onDraft}
            />
          </div>
        ) : (
          <button
            type="button"
            data-testid="notification-open"
            onClick={() => center.openItem(item)}
            className="min-h-11 min-w-0 flex-1 rounded px-1 py-1 text-left focus-visible:outline-2 focus-visible:outline-focus"
          >
            <span className="flex items-center gap-2 text-xs text-outline">
              {!item.read_at && (
                <span
                  role="img"
                  aria-label="Unread"
                  className="size-1.5 shrink-0 rounded-full bg-primary"
                />
              )}
              <span className="truncate">{labels[item.type] ?? "Update"}</span>
              {item.requires_action && <span className="shrink-0 text-warning">Needs you</span>}
              <time
                className="ml-auto shrink-0"
                dateTime={new Date(item.created_at).toISOString()}
                title={`${new Date(item.created_at).toLocaleString()} · expires ${new Date(item.expires_at).toLocaleString()}`}
              >
                {formatRelative(item.created_at)}
              </time>
            </span>
            <span
              className={cn(
                "mt-0.5 block line-clamp-2 text-sm leading-5 wrap-break-word",
                !item.read_at && "font-medium",
              )}
            >
              {item.title}
            </span>
            {item.body && (
              <span className="mt-0.5 block line-clamp-1 text-xs text-outline">{item.body}</span>
            )}
          </button>
        )}
        <NotificationRowActions item={item} />
      </div>
      {expandedHere && (
        <div className="px-1 pt-1">
          <RequestDetails
            key={item.source_id}
            id={item.source_id}
            summary="Linked request"
            expanded
            onToggle={() => center.setSelected(null)}
            onNavigate={() => {
              center.setSelected(null);
              center.close();
            }}
            drafts={center.drafts}
            onDraft={center.onDraft}
          />
        </div>
      )}
    </div>
  );
}

/** Desktop keeps direct icon actions; phones get one named row menu (44px target). */
function NotificationRowActions({ item }: { item: OrcNotification }) {
  const center = useNotificationCenter();
  const [open, setOpen] = useState(false);
  const act = (run: () => void) => {
    if (center.selected === item.source_id) center.setSelected(null);
    run();
  };
  if (!center.phone)
    return (
      <div className="flex shrink-0">
        <Button
          size="icon"
          variant="ghost"
          data-testid="notification-mark-read"
          aria-label={item.read_at ? "Mark unread" : "Mark read"}
          disabled={center.busy}
          onClick={() => act(() => center.setRead(item.id, !item.read_at))}
        >
          <Check className="size-4" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          data-testid="notification-dismiss"
          aria-label="Dismiss notification"
          disabled={center.busy}
          onClick={() => act(() => center.dismiss(item.id))}
        >
          <X className="size-4" />
        </Button>
      </div>
    );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          data-testid="notification-actions"
          aria-label={`Actions for ${item.title}`}
          className="min-h-11 min-w-11 shrink-0"
        >
          <MoreHorizontal className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-44 p-1" aria-label={`Actions for ${item.title}`}>
        <button
          type="button"
          data-testid="notification-mark-read"
          className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-on-surface-variant hover:bg-surface hover:text-on-surface"
          onClick={() => {
            setOpen(false);
            act(() => center.setRead(item.id, !item.read_at));
          }}
        >
          <Check className="size-4" />
          {item.read_at ? "Mark unread" : "Mark read"}
        </button>
        <button
          type="button"
          data-testid="notification-dismiss"
          className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-on-surface-variant hover:bg-surface hover:text-on-surface"
          onClick={() => {
            setOpen(false);
            act(() => center.dismiss(item.id));
          }}
        >
          <X className="size-4" />
          Dismiss
        </button>
      </PopoverContent>
    </Popover>
  );
}

function RequestDetails({
  id,
  summary,
  expanded,
  onToggle,
  drafts,
  onDraft,
  onNavigate,
}: {
  id: string;
  summary: string;
  expanded: boolean;
  onToggle: () => void;
  drafts: Record<string, RequestDraft>;
  onDraft: (id: string, update: Partial<RequestDraft>) => void;
  onNavigate: () => void;
}) {
  const requests = useHumanRequests();
  const cached = requests.data?.find((request) => request.id === id);
  const request = useQuery({
    queryKey: ["human-requests", id],
    queryFn: () => api.humanRequests.view(id),
    refetchInterval: useResourceFallback(),
    enabled: expanded,
  });
  const value =
    request.data &&
    (request.data.version > (cached?.version ?? 0) ||
      (request.data.version === cached?.version && request.dataUpdatedAt > requests.dataUpdatedAt))
      ? request.data
      : cached;
  if (!expanded && !value)
    return (
      <Button variant="ghost" size="sm" onClick={onToggle}>
        {summary} · Review request
      </Button>
    );
  if (request.isPending && !value) return <p role="status">Loading request…</p>;
  if (request.error || !value)
    return <p role="alert">{request.error?.message ?? "Request is no longer available."}</p>;
  return (
    <RequestCard
      request={value}
      expanded={expanded}
      onToggle={onToggle}
      onNavigate={onNavigate}
      draft={drafts[id]}
      onDraftChange={(update) =>
        onDraft(id, {
          ...(!drafts[id] ? { editingAnswer: value.input.choices.length === 0 } : {}),
          ...update,
        })
      }
    />
  );
}

export function AgentNotificationBell() {
  const center = useContext(CenterContext);
  const navigate = useNavigate();
  const id = useId();
  if (!center) return null;
  return (
    <Button
      id={id}
      data-testid="notification-bell"
      variant="ghost"
      size="icon"
      className="relative min-h-11 min-w-11 lg:min-h-8 lg:min-w-8"
      aria-label={`Notifications: ${center.unread} unread`}
      aria-haspopup={center.phone ? undefined : "dialog"}
      aria-expanded={center.phone ? undefined : center.expanded && center.anchor?.id === id}
      onClick={(event) => {
        // Phones get a full page; desktop keeps the anchored popover.
        if (center.phone) navigate(notificationsPath(window.location.search));
        else center.show(event.currentTarget);
      }}
    >
      {/* Remounting on each pulse restarts the jump animation for every burst. */}
      <span
        key={center.pulse}
        data-testid="notification-bell-icon"
        data-pulse={center.pulse}
        className={cn(
          "inline-flex origin-top",
          center.pulse > 0 && "motion-safe:animate-bell-jump",
        )}
      >
        <Bell className="size-4" />
      </span>
      {center.unread > 0 && (
        <span
          data-testid="notification-unread"
          className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-primary px-1 text-[10px] text-primary-foreground"
        >
          {center.unread > 99 ? "99+" : center.unread}
        </span>
      )}
    </Button>
  );
}

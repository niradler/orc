import type { OrcNotification } from "@orc/core/notifications";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, Check, CheckCheck, ChevronDown, ExternalLink, X } from "lucide-react";
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
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { activeLiveSessionsQuery } from "@/hooks/useActiveLiveSessions";
import { useChat } from "@/hooks/useChat";
import { useHumanRequests } from "@/hooks/useHumanRequests";
import { desktopBridge } from "@/lib/desktop-bridge";
import {
  mergeNotificationToasts,
  NotificationFeed,
  type NotificationToastEntry,
} from "@/lib/notification-feed";
import {
  getNotificationPrefs,
  playNeedsYouSound,
  unlockNotificationSound,
} from "@/lib/notification-sound";
import { cn } from "@/lib/utils";

export const FOCUS_NOTIFICATIONS_EVENT = "orc-focus-notifications";
export const NOTIFICATIONS_SHORTCUT = "Alt+N";
const PAGE_SIZE = 50;
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
  expanded: boolean;
  anchor: HTMLElement | null;
  show: (anchor: HTMLElement) => void;
};
const CenterContext = createContext<Center | null>(null);

/** Adding the default project scope to the URL does not leave the page the menu was opened on. */
function menuPlace({ pathname, search }: { pathname: string; search: string }): string {
  const params = new URLSearchParams(search);
  params.delete("project");
  return `${pathname}?${params}`;
}

export function AgentNotifications({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const { tabs, activeKey } = useChat();
  const requests = useHumanRequests();
  const sessions = useQuery(activeLiveSessionsQuery);
  const [expanded, setExpanded] = useState(false);
  const [showRead, setShowRead] = useState(false);
  const menuLocation = useRef(location);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const selectedDetails = useRef<HTMLDivElement>(null);
  const [drafts, setDrafts] = useState<Record<string, RequestDraft>>({});
  const [toasts, setToasts] = useState<NotificationToastEntry[]>([]);
  const [announcement, setAnnouncement] = useState("");
  const feed = useRef(new NotificationFeed());
  const delivery = useRef({
    location,
    tabs,
    activeKey,
    requests: requests.data,
    sessions: sessions.data?.sessions,
  });
  delivery.current = {
    location,
    tabs,
    activeKey,
    requests: requests.data,
    sessions: sessions.data?.sessions,
  };
  const query = useInfiniteQuery({
    queryKey: ["notifications", { showRead }],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      api.notifications.list({ limit: PAGE_SIZE, offset: pageParam, unread: !showRead }),
    getNextPageParam: (last, _pages, offset) => (last.has_more ? offset + PAGE_SIZE : undefined),
    refetchInterval: 15_000,
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
  const show = (element: HTMLElement) => {
    setAnchor(element);
    setExpanded(true);
  };

  useEffect(() => {
    const latest = query.data?.pages[0]?.notifications;
    if (!latest) return;
    feed.current.update(latest, Date.now());
    const current = new Map(latest.map((item) => [item.id, item]));
    setToasts((toasts) =>
      toasts.flatMap((toast) => {
        const items = toast.items.flatMap((previous) => {
          const item = current.get(previous.id);
          if (
            !item ||
            item.read_at !== null ||
            item.dismissed_at !== null ||
            item.expires_at <= Date.now() ||
            (previous.requires_action && !item.requires_action)
          )
            return [];
          return [item];
        });
        return items.length ? [{ ...toast, items }] : [];
      }),
    );
  }, [query.data]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const state = delivery.current;
      const incoming = feed.current.flush(Date.now(), (item) => {
        if (document.visibilityState === "hidden" || !document.hasFocus()) return false;
        const params = new URLSearchParams(state.location.search);
        const target = new URL(item.path, window.location.origin);
        const threadId = state.tabs.find((tab) => tab.key === state.activeKey)?.thread?.id;
        const request =
          item.type === "human.request"
            ? state.requests?.find((request) => request.id === item.source_id)
            : undefined;
        const targetThread =
          target.searchParams.get("chatThread") ?? request?.input.origin.chat_thread_id;
        if (params.get("chat") && targetThread && targetThread === threadId) return true;
        if (state.location.pathname !== "/sessions") return false;
        const sessionId = params.get("session");
        if (target.pathname === "/sessions" && target.searchParams.get("session") === sessionId)
          return true;
        const session = state.sessions?.find((session) => session.id === sessionId);
        const origin = request?.input.origin;
        return (
          !!session &&
          !!origin &&
          session.agent.replace(/-cli$/, "") === origin.backend.replace(/-cli$/, "") &&
          session.host === (origin.execution_host ?? null) &&
          session.session_id === (origin.native_session_id ?? origin.session_id)
        );
      });
      if (!incoming.length) return;
      setToasts((current) => mergeNotificationToasts(current, incoming));
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
        desktopBridge()?.notify({
          title: item.title,
          body: item.body || labels[item.type] || "Update",
          level: item.level,
          path: item.path,
        });
    }, 250);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const openFromKeyboard = () => {
      const button =
        document.querySelector<HTMLButtonElement>(
          '[data-testid="mobile-chat-sheet"] [data-testid="notification-bell"]',
        ) ?? document.querySelector<HTMLButtonElement>('[data-testid="notification-bell"]');
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
  useEffect(
    () =>
      desktopBridge()?.onOpen((path) => {
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
    setSelected(linkedRequest);
    const timer = window.setTimeout(() => {
      const button =
        document.querySelector<HTMLButtonElement>(
          '[data-testid="mobile-chat-sheet"] [data-testid="notification-bell"]',
        ) ?? document.querySelector<HTMLButtonElement>('[data-testid="notification-bell"]');
      if (button) {
        setAnchor(button);
        setExpanded(true);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [notificationLink, linkedRequest]);

  const open = (item: OrcNotification) => {
    if (!item.read_at) update.mutate({ id: item.id, read: true });
    setToasts((current) =>
      current.filter((toast) => !toast.items.some((entry) => entry.id === item.id)),
    );
    if (item.type === "human.request") {
      setSelected(item.source_id);
      const button =
        document.querySelector<HTMLButtonElement>(
          '[data-testid="mobile-chat-sheet"] [data-testid="notification-bell"]',
        ) ?? document.querySelector<HTMLButtonElement>('[data-testid="notification-bell"]');
      if (button) show(button);
    } else {
      setExpanded(false);
      navigate(item.path);
    }
  };

  useEffect(() => {
    if (expanded && selected) selectedDetails.current?.scrollIntoView({ block: "nearest" });
  }, [expanded, selected]);

  return (
    <CenterContext.Provider value={{ unread, expanded, anchor, show }}>
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
              onClick={() => {
                setSelected(null);
                markAll.mutate();
              }}
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
          <div className="flex items-center border-b border-border px-3 py-1">
            <Button
              size="sm"
              variant="ghost"
              data-testid="notifications-show-read"
              aria-pressed={showRead}
              onClick={() => setShowRead((current) => !current)}
            >
              {showRead && <Check />} Show read
            </Button>
          </div>
          <div className="@container/attention px-3">
            {query.isPending && (
              <p role="status" className="py-4 text-sm text-outline">
                Loading notifications…
              </p>
            )}
            {query.error && (
              <p role="alert" className="py-3 text-sm text-error">
                {query.error.message}{" "}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    void refresh();
                  }}
                >
                  Retry
                </Button>
              </p>
            )}
            {!query.isPending && !query.error && items.length === 0 && !selected && (
              <p data-testid="notifications-empty" className="py-5 text-sm text-outline">
                {showRead ? "No notifications." : "No unread notifications."}
              </p>
            )}
            {items.map((item) => (
              <div
                key={item.id}
                data-testid="notification-item"
                data-notification-id={item.id}
                data-type={item.type}
                data-source-id={item.source_id}
                className="border-b border-border py-2 last:border-b-0"
              >
                <div className="flex items-start gap-1">
                  {item.type === "human.request" && (
                    <div className="min-w-0 flex-1 px-1 py-2 text-xs text-outline">
                      {!item.read_at && (
                        <span className="mr-2 inline-block size-1.5 rounded-full bg-primary" />
                      )}
                      Human request{" "}
                      <span
                        className="ml-2"
                        title={`Expires ${new Date(item.expires_at).toLocaleString()}`}
                      >
                        {new Date(item.created_at).toLocaleDateString()}
                      </span>
                    </div>
                  )}
                  <button
                    type="button"
                    data-testid="notification-open"
                    onClick={() =>
                      selected === item.source_id && item.type === "human.request"
                        ? setSelected(null)
                        : open(item)
                    }
                    className={cn(
                      "min-h-11 min-w-0 flex-1 rounded px-1 py-1 text-left focus-visible:outline-2 focus-visible:outline-focus",
                      item.type === "human.request" && "hidden",
                    )}
                    aria-expanded={
                      item.type === "human.request" ? selected === item.source_id : undefined
                    }
                  >
                    <span className="flex items-center gap-2 text-xs text-outline">
                      {!item.read_at && (
                        <span
                          role="img"
                          aria-label="Unread"
                          className="size-1.5 shrink-0 rounded-full bg-primary"
                        />
                      )}
                      <span>{labels[item.type] ?? "Update"}</span>
                      {item.requires_action && <span className="text-warning">Needs you</span>}
                      <time
                        className="ml-auto shrink-0"
                        dateTime={new Date(item.created_at).toISOString()}
                      >
                        {new Date(item.created_at).toLocaleDateString()}
                      </time>
                    </span>
                    <span
                      className={cn("mt-1 block truncate text-sm", !item.read_at && "font-medium")}
                    >
                      {item.title}
                    </span>
                    {item.body && (
                      <span className="mt-0.5 block line-clamp-2 text-xs text-outline">
                        {item.body}
                      </span>
                    )}
                  </button>
                  <Button
                    size="icon"
                    variant="ghost"
                    data-testid="notification-mark-read"
                    aria-label={item.read_at ? "Mark unread" : "Mark read"}
                    disabled={update.isPending}
                    onClick={() => {
                      if (selected === item.source_id) setSelected(null);
                      update.mutate({ id: item.id, read: !item.read_at });
                    }}
                  >
                    <Check className="size-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    data-testid="notification-dismiss"
                    aria-label="Dismiss notification"
                    disabled={update.isPending}
                    onClick={() => {
                      if (selected === item.source_id) setSelected(null);
                      update.mutate({ id: item.id, dismissed: true });
                    }}
                  >
                    <X className="size-4" />
                  </Button>
                </div>
                <p className="px-1 text-[11px] text-outline">
                  Expires {new Date(item.expires_at).toLocaleDateString()}
                </p>
                {item.type === "human.request" && selected !== item.source_id && (
                  <RequestDetails
                    id={item.source_id}
                    summary={item.title}
                    onNavigate={() => setExpanded(false)}
                    expanded={false}
                    onToggle={() => open(item)}
                    drafts={drafts}
                    onDraft={(id, update) =>
                      setDrafts((current) => ({
                        ...current,
                        [id]: {
                          ...(current[id] ?? { answer: "", selected: [], editingAnswer: true }),
                          ...update,
                        },
                      }))
                    }
                  />
                )}
              </div>
            ))}
            {selected && (
              <div ref={selectedDetails} className="py-2">
                <RequestDetails
                  key={selected}
                  id={selected}
                  summary="Linked request"
                  expanded
                  onToggle={() => setSelected(null)}
                  onNavigate={() => setExpanded(false)}
                  drafts={drafts}
                  onDraft={(id, update) =>
                    setDrafts((current) => ({
                      ...current,
                      [id]: {
                        ...(current[id] ?? { answer: "", selected: [], editingAnswer: true }),
                        ...update,
                      },
                    }))
                  }
                />
              </div>
            )}
            {query.hasNextPage && (
              <Button
                variant="ghost"
                size="sm"
                className="my-2 w-full"
                disabled={query.isFetchingNextPage}
                onClick={() => {
                  void query.fetchNextPage();
                }}
              >
                <ChevronDown /> Load more
              </Button>
            )}
            {(update.error || markAll.error) && (
              <p role="alert" className="py-2 text-sm text-error">
                {update.error?.message ?? markAll.error?.message}
              </p>
            )}
          </div>
        </PopoverContent>
      </Popover>
      <div data-testid="agent-notification-live" aria-live="polite" className="sr-only">
        {announcement}
      </div>
      {toasts.length > 0 && (
        <section
          data-testid="agent-toasts"
          aria-label="New notifications"
          className="pointer-events-none fixed bottom-4 right-4 z-40 hidden w-[min(24rem,calc(100vw-2rem))] flex-col gap-2 md:flex"
        >
          {toasts.map((entry) => (
            <NotificationToast
              key={entry.id}
              entry={entry}
              onOpen={() => {
                const item = entry.items[0];
                if (entry.items.length === 1 && item) open(item);
                else {
                  setSelected(null);
                  const button = document.querySelector<HTMLButtonElement>(
                    '[data-testid="notification-bell"]',
                  );
                  if (button) show(button);
                  setToasts((current) => current.filter((toast) => toast.id !== entry.id));
                }
              }}
              onDismiss={() =>
                setToasts((current) => current.filter((toast) => toast.id !== entry.id))
              }
            />
          ))}
        </section>
      )}
    </CenterContext.Provider>
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
    refetchInterval: 15000,
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
        {summary} — Review request
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
      aria-haspopup="dialog"
      aria-expanded={center.expanded && center.anchor?.id === id}
      onClick={(event) => center.show(event.currentTarget)}
    >
      <Bell className="size-4" />
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

function NotificationToast({
  entry,
  onOpen,
  onDismiss,
}: {
  entry: NotificationToastEntry;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const item = entry.items[0];
  const title = entry.items.length > 1 ? `${entry.items.length} updates finished` : item?.title;
  const body =
    entry.items.length > 1
      ? entry.items
          .slice(0, 3)
          .map((item) => item.title)
          .join(" · ")
      : item?.body;
  const [paused, setPaused] = useState(false);
  const remaining = useRef(6000);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    if (item?.level !== "done" || paused) return;
    const started = Date.now();
    const timer = window.setTimeout(() => dismiss.current(), remaining.current);
    return () => {
      window.clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (Date.now() - started));
    };
  }, [item?.level, paused]);
  return (
    <article
      data-testid="agent-toast"
      data-level={item?.level}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setPaused(false);
      }}
      className="pointer-events-auto rounded-lg border border-control-border bg-surface-high p-3 shadow-lg"
    >
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 truncate text-sm font-medium">{title}</p>
        <Button variant="ghost" size="icon" aria-label="Dismiss notification" onClick={onDismiss}>
          <X />
        </Button>
      </div>
      {body && <p className="mt-1 line-clamp-2 text-xs text-outline">{body}</p>}
      <Button
        data-testid="agent-toast-open"
        size="sm"
        variant="ghost"
        className="mt-2"
        onClick={onOpen}
      >
        <ExternalLink />
        {entry.items.length > 1
          ? "Open notifications"
          : item?.requires_action
            ? "Review notification"
            : "Open"}
      </Button>
    </article>
  );
}

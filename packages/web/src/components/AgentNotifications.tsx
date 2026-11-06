import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, Check, ExternalLink, X } from "lucide-react";
import {
  createContext,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api } from "@/api/client";
import { StateBadge } from "@/components/StateBadge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { activeLiveSessionsQuery } from "@/hooks/useActiveLiveSessions";
import { useAttentionChatWaits } from "@/hooks/useAttentionChatWaits";
import { CHAT_THREAD_PARAM, useChat } from "@/hooks/useChat";
import { useHumanRequests } from "@/hooks/useHumanRequests";
import { useBreakpoint } from "@/hooks/useMediaQuery";
import { notifySubjects } from "@/lib/agent-notification-subjects";
import {
  type AgentNotification,
  AgentNotifier,
  addNotifications,
  DONE_TOAST_MS,
  type NotificationLevel,
  type NotifySubject,
  type NotifyTarget,
  notificationAnnouncement,
  notificationHeading,
  retireNotifications,
  shouldPlaySound,
} from "@/lib/agent-notifications";
import { desktopBridge } from "@/lib/desktop-bridge";
import {
  getNotificationPrefs,
  playNeedsYouSound,
  unlockNotificationSound,
} from "@/lib/notification-sound";
import { cn } from "@/lib/utils";
import { workspaceDestination } from "@/lib/workspace-navigation";

export const FOCUS_NOTIFICATIONS_EVENT = "orc-focus-notifications";
export const NOTIFICATIONS_SHORTCUT = "Alt+N";
const FLUSH_MS = 250;
const MAX_LISTED = 3;
const NONE: never[] = [];
const NotificationsContext = createContext<{
  toasts: AgentNotification[];
  attentionCount: number;
  dismiss: (id: string) => void;
  open: (id: string, target: NotifyTarget) => void;
} | null>(null);

function isShortcut(event: globalThis.KeyboardEvent) {
  return (
    event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.code === "KeyN"
  );
}

function targetPath(target: NotifyTarget, pathname: string, search: string): string {
  const params = new URLSearchParams(search);
  if (target.kind === "attention") return "/attention?project=all";
  if (target.kind === "chat") {
    params.set("chat", "open");
    params.set(CHAT_THREAD_PARAM, target.threadId);
    return `${pathname}?${params}`;
  }
  if (target.kind === "session")
    return `/sessions?session=${encodeURIComponent(target.id)}&project=all`;
  return "/attention?project=all";
}

function notificationTarget(notification: AgentNotification): NotifyTarget {
  if (notification.level === "needs-you") return { kind: "attention" };
  return notification.subjects[0].target;
}

/** Watches every agent the user is not looking at and raises toasts, sound and desktop alerts. */
export function AgentNotifications({ children }: { children: ReactNode }) {
  const desktop = useBreakpoint("md");
  const { tabs, activeKey } = useChat();
  const requests = useHumanRequests();
  const waits = useAttentionChatWaits();
  const sessions = useQuery(activeLiveSessionsQuery);
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const [toasts, setToasts] = useState<AgentNotification[]>([]);
  const [announcement, setAnnouncement] = useState("");
  const notifier = useRef(new AgentNotifier());
  const stack = useRef<HTMLElement>(null);

  const ready =
    requests.status !== "pending" && waits.status !== "pending" && sessions.status !== "pending";
  const waitList = waits.all.length ? waits.all : NONE;
  const subjects = useMemo(
    () =>
      notifySubjects({
        tabs,
        waits: waitList,
        requests: requests.data ?? [],
        sessions: sessions.data?.sessions ?? [],
      }),
    [tabs, waitList, requests.data, sessions.data],
  );
  const attentionCount = subjects.filter(
    (subject) => subject.state === "needs-you" || subject.state === "failed",
  ).length;

  const params = new URLSearchParams(search);
  const chatShown = !!params.get("chat");
  const activeThread = tabs.find((tab) => tab.key === activeKey)?.thread?.id ?? null;
  const viewedSession = pathname === "/sessions" ? params.get("session") : null;
  const inView = useCallback(
    (subject: NotifySubject, level?: NotificationLevel) => {
      if (document.visibilityState === "hidden" || !document.hasFocus()) return false;
      if (level === "needs-you" && pathname === "/attention") return true;
      if (subject.target.kind === "chat" && chatShown && subject.target.threadId === activeThread)
        return true;
      return !!viewedSession && !!subject.liveIds?.includes(viewedSession);
    },
    [pathname, chatShown, activeThread, viewedSession],
  );
  const inViewRef = useRef(inView);
  inViewRef.current = inView;
  const locationRef = useRef({ pathname, search });
  locationRef.current = { pathname, search };

  useEffect(() => {
    if (ready) notifier.current.update(subjects, Date.now());
  }, [ready, subjects]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const incoming = notifier.current.flush(Date.now(), (subject, level) =>
        inViewRef.current(subject, level),
      );
      if (!incoming.length) return;
      setToasts((current) => addNotifications(current, incoming));
      setAnnouncement(incoming.map(notificationAnnouncement).join(". "));
      const prefs = getNotificationPrefs();
      if (incoming.some((notification) => shouldPlaySound(notification, prefs)))
        playNeedsYouSound(prefs.volume);
      const bridge = desktopBridge();
      if (bridge)
        for (const notification of incoming)
          bridge.notify({
            title: notificationHeading(notification),
            body: notificationAnnouncement(notification),
            level: notification.level,
            path: targetPath(
              notificationTarget(notification),
              locationRef.current.pathname,
              locationRef.current.search,
            ),
          });
    }, FLUSH_MS);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const currentSubjects = new Map(subjects.map((subject) => [subject.key, subject]));
    setToasts((current) =>
      retireNotifications(current, currentSubjects, (subject) => inView(subject, "needs-you")),
    );
  }, [subjects, inView]);

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
        if (path.startsWith("/") && !path.startsWith("//")) navigate(path);
      }),
    [navigate],
  );

  useEffect(() => {
    const focus = () => {
      if (!desktop) {
        const bell =
          document.querySelector<HTMLButtonElement>(
            '[data-testid="mobile-chat-sheet"] [data-testid="notification-bell"]',
          ) ?? document.querySelector<HTMLButtonElement>('[data-testid="notification-bell"]');
        bell?.click();
        return;
      }
      const first = stack.current?.querySelector<HTMLElement>("[data-toast-focus]");
      if (first) first.focus();
      else
        navigate(
          workspaceDestination(
            "/attention",
            new URLSearchParams(locationRef.current.search).get("project") ?? "all",
            locationRef.current.search,
          ),
        );
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || !isShortcut(event)) return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest('[data-testid="terminal-viewport"]')
      )
        return;
      event.preventDefault();
      focus();
    };
    const onRequest = () => window.setTimeout(focus, 0);
    window.addEventListener("keydown", onKey);
    window.addEventListener(FOCUS_NOTIFICATIONS_EVENT, onRequest);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(FOCUS_NOTIFICATIONS_EVENT, onRequest);
    };
  }, [navigate, desktop]);

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);
  const open = (id: string, target: NotifyTarget) => {
    dismiss(id);
    navigate(targetPath(target, pathname, search));
  };

  return (
    <NotificationsContext.Provider value={{ toasts, attentionCount, dismiss, open }}>
      {children}
      <div data-testid="agent-notification-live" aria-live="polite" className="sr-only">
        {announcement}
      </div>
      {desktop && toasts.length > 0 && (
        <section
          ref={stack}
          data-testid="agent-toasts"
          aria-label={`Agent notifications (${NOTIFICATIONS_SHORTCUT})`}
          className="pointer-events-none fixed right-4 bottom-4 z-40 flex w-[min(24rem,calc(100%-1.5rem))] flex-col gap-2"
        >
          {toasts.map((toast) => (
            <AgentToast
              key={toast.id}
              toast={toast}
              onDismiss={() => dismiss(toast.id)}
              onOpen={(target) => open(toast.id, target)}
            />
          ))}
        </section>
      )}
    </NotificationsContext.Provider>
  );
}

export function AgentNotificationBell() {
  const notifications = useContext(NotificationsContext);
  const [expanded, setExpanded] = useState(false);
  if (!notifications) return null;
  const { toasts, attentionCount, dismiss, open } = notifications;
  const pending = toasts
    .filter((toast) => toast.level === "needs-you")
    .reduce((total, toast) => total + toast.subjects.length, 0);
  const done = toasts
    .filter((toast) => toast.level === "done")
    .reduce((total, toast) => total + toast.subjects.length, 0);
  const count = Math.max(attentionCount, pending) + done;
  return (
    <Popover open={expanded} onOpenChange={setExpanded}>
      <PopoverTrigger asChild>
        <Button
          data-testid="notification-bell"
          variant="ghost"
          size="icon"
          className="relative min-h-11 min-w-11 md:hidden"
          aria-label={`Notifications: ${count} unread`}
        >
          <Bell className="size-4" />
          {count > 0 && (
            <span
              data-testid="notification-unread"
              className="absolute right-0.5 top-0.5 min-w-4 rounded-full bg-primary px-1 text-[10px] text-primary-foreground"
            >
              {count}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label="Agent notifications"
        data-testid="notification-menu"
        className="z-[60] w-[min(24rem,calc(100vw-2rem))] space-y-2"
      >
        <h2 className="text-sm font-medium">Notifications</h2>
        {toasts.length === 0 && <p className="text-sm text-outline">No new notifications.</p>}
        {toasts.map((toast) => (
          <AgentToast
            key={toast.id}
            toast={toast}
            autoDismiss={false}
            onDismiss={() => dismiss(toast.id)}
            onOpen={(target) => {
              setExpanded(false);
              open(toast.id, target);
            }}
          />
        ))}
        <Button
          data-testid="notification-open-attention"
          variant="ghost"
          size="sm"
          className="w-full justify-start"
          onClick={() => {
            setExpanded(false);
            open("", { kind: "attention" });
          }}
        >
          <ExternalLink className="size-4" /> Open Attention
          {attentionCount > 0 ? ` (${attentionCount})` : ""}
        </Button>
      </PopoverContent>
    </Popover>
  );
}

function AgentToast({
  toast,
  autoDismiss = true,
  onDismiss,
  onOpen,
}: {
  toast: AgentNotification;
  autoDismiss?: boolean;
  onDismiss: () => void;
  onOpen: (target: NotifyTarget) => void;
}) {
  const [paused, setPaused] = useState(false);
  const remaining = useRef(DONE_TOAST_MS);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  useEffect(() => {
    if (!autoDismiss || toast.level !== "done" || paused) return;
    const started = Date.now();
    const timer = window.setTimeout(() => dismissRef.current(), remaining.current);
    return () => {
      window.clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (Date.now() - started));
    };
  }, [toast.level, paused, autoDismiss]);

  const [subject] = toast.subjects;
  const single = toast.subjects.length === 1;
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    onDismiss();
  };
  return (
    <article
      data-testid="agent-toast"
      data-level={toast.level}
      aria-label={notificationAnnouncement(toast)}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setPaused(false);
      }}
      onKeyDown={onKeyDown}
      className={cn(
        "pointer-events-auto text-on-surface",
        autoDismiss
          ? "rounded-lg border border-control-border bg-surface-high p-3 shadow-lg motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-150"
          : "border-b border-border py-2",
        autoDismiss && toast.level === "needs-you" && "border-l-2 border-l-warning",
      )}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2 text-xs text-outline">
            <StateBadge
              state={single ? subject.state : toast.level === "done" ? "done" : "needs-you"}
              testId="agent-toast-state"
            />
            {single && <span className="truncate">{subject.agent}</span>}
          </div>
          <p data-testid="agent-toast-title" className="mt-1 truncate text-sm font-medium">
            {notificationHeading(toast)}
          </p>
          {single && subject.detail && (
            <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{subject.detail}</p>
          )}
        </div>
        <Button
          data-testid="agent-toast-dismiss"
          data-toast-focus={toast.level === "done" ? "" : undefined}
          variant="ghost"
          size="icon"
          className="-mt-1 -mr-1 size-8 min-h-11 min-w-11 md:min-h-8 md:min-w-8 shrink-0 text-outline"
          aria-label="Dismiss notification"
          onClick={onDismiss}
        >
          <X className="size-4" />
        </Button>
      </div>
      {!single && (
        <ul className="mt-2 space-y-0.5">
          {toast.subjects.slice(0, MAX_LISTED).map((item) => (
            <li key={item.key}>
              <button
                type="button"
                data-testid="agent-toast-subject"
                className="flex min-h-11 md:min-h-0 w-full min-w-0 items-center gap-2 rounded px-1 py-1 text-left text-xs hover:bg-surface-highest focus-visible:outline-2 focus-visible:outline-focus"
                onClick={() =>
                  onOpen(toast.level === "needs-you" ? { kind: "attention" } : item.target)
                }
              >
                <StateBadge state={item.state} compact testId="agent-toast-subject-state" />
                <span className="truncate text-on-surface">{item.title}</span>
                <span className="ml-auto shrink-0 text-outline">{item.agent}</span>
              </button>
            </li>
          ))}
          {toast.subjects.length > MAX_LISTED && (
            <li className="px-1 text-xs text-outline">
              +{toast.subjects.length - MAX_LISTED} more
            </li>
          )}
        </ul>
      )}
      {(toast.level === "needs-you" || single) && (
        <ToastActions toast={toast} onDone={onDismiss} onOpen={onOpen} />
      )}
    </article>
  );
}

function ToastActions({
  toast,
  onDone,
  onOpen,
}: {
  toast: AgentNotification;
  onDone: () => void;
  onOpen: (target: NotifyTarget) => void;
}) {
  const client = useQueryClient();
  const single = toast.subjects.length === 1 ? toast.subjects[0] : null;
  const approval = single?.approval;
  const respond = useMutation({
    mutationFn: (approved: boolean) => {
      if (!approval) throw new Error("No approval request");
      return api.humanRequests.respond(approval.id, approval.version, {
        kind: "approval",
        approved,
      });
    },
    onSuccess: onDone,
    onSettled: () => client.invalidateQueries({ queryKey: ["human-requests"] }),
  });
  const target = notificationTarget(toast);
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {approval && (
        <>
          <Button
            data-testid="agent-toast-approve"
            data-toast-focus=""
            size="sm"
            disabled={respond.isPending}
            onClick={() => respond.mutate(true)}
          >
            <Check className="size-4" /> Approve
          </Button>
          <Button
            data-testid="agent-toast-deny"
            size="sm"
            variant="outline"
            disabled={respond.isPending}
            onClick={() => respond.mutate(false)}
          >
            <X className="size-4" /> Deny
          </Button>
        </>
      )}
      <Button
        data-testid="agent-toast-open"
        data-toast-focus={approval ? undefined : ""}
        size="sm"
        variant={approval ? "ghost" : "outline"}
        onClick={() => onOpen(target)}
      >
        <ExternalLink className="size-4" />
        {toast.level === "needs-you" ? "Open Attention" : "Open"}
      </Button>
      {respond.isError && (
        <p role="alert" className="w-full text-xs text-error">
          {respond.error instanceof Error ? respond.error.message : "Could not send the answer."}
        </p>
      )}
    </div>
  );
}

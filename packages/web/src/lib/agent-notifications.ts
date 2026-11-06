import { AGENT_STATES, type AgentState } from "./agent-state";

export type NotificationLevel = "needs-you" | "done";
export const SETTLE_MS = 1000;
export const DONE_TOAST_MS = 6000;
export const MAX_TOASTS = 4;

export type NotifyTarget =
  | { kind: "chat"; threadId: string }
  | { kind: "session"; id: string }
  | { kind: "attention" };

export interface NotifySubject {
  key: string;
  state: AgentState;
  title: string;
  agent: string;
  projectId: string | null;
  target: NotifyTarget;
  /** Live session ids that show this subject on /sessions. */
  liveIds?: string[];
  detail?: string;
  approval?: { id: string; version: number };
}

export interface AgentNotification {
  id: string;
  level: NotificationLevel;
  subjects: NotifySubject[];
  createdAt: number;
}

export interface NotificationPrefs {
  sound: boolean;
  volume: number;
  mutedProjects: string[];
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  sound: true,
  volume: 0.6,
  mutedProjects: [],
};

const ACTIVE: ReadonlySet<AgentState> = new Set(["needs-you", "failed"]);

export function notificationLevel(
  from: AgentState | null | undefined,
  to: AgentState | null,
): NotificationLevel | null {
  if (!to || from === to) return null;
  if (ACTIVE.has(to)) return "needs-you";
  if (to === "done" || (to === "idle" && from === "working")) return "done";
  return null;
}

type Pending = { from: AgentState | null | undefined; to: AgentState | null; since: number };

/** Notifies once per settled state change; the first snapshot is the baseline. */
export class AgentNotifier {
  private settled = new Map<string, AgentState>();
  private pending = new Map<string, Pending>();
  private current = new Map<string, NotifySubject>();
  private started = false;
  private sequence = 0;

  constructor(private readonly settleMs = SETTLE_MS) {}

  update(subjects: readonly NotifySubject[], now: number): void {
    const next = new Map(subjects.map((subject) => [subject.key, subject]));
    this.current = next;
    if (!this.started) {
      this.started = true;
      for (const subject of subjects) this.settled.set(subject.key, subject.state);
      return;
    }
    for (const key of new Set([...this.settled.keys(), ...this.pending.keys(), ...next.keys()])) {
      const state = next.get(key)?.state ?? null;
      const settled = this.settled.get(key);
      if (state === (settled ?? null)) {
        this.pending.delete(key);
        continue;
      }
      if (this.pending.get(key)?.to === state) continue;
      this.pending.set(key, { from: settled, to: state, since: now });
    }
  }

  flush(
    now: number,
    inView: (subject: NotifySubject, level: NotificationLevel) => boolean,
  ): AgentNotification[] {
    const due: Record<NotificationLevel, NotifySubject[]> = { "needs-you": [], done: [] };
    for (const [key, change] of this.pending) {
      if (now - change.since < this.settleMs) continue;
      this.pending.delete(key);
      if (!change.to) {
        this.settled.delete(key);
        continue;
      }
      this.settled.set(key, change.to);
      const level = notificationLevel(change.from, change.to);
      const subject = this.current.get(key);
      if (level && subject && !inView(subject, level))
        due[level].push(level === "done" ? { ...subject, state: "done" } : subject);
    }
    return (["needs-you", "done"] as const)
      .filter((level) => due[level].length > 0)
      .map((level) => ({
        id: `notification-${++this.sequence}`,
        level,
        subjects: due[level],
        createdAt: now,
      }));
  }
}

const unique = (subjects: NotifySubject[]) => [
  ...new Map(subjects.map((subject) => [subject.key, subject])).values(),
];

/** Done toasts collapse into one; newest first, oldest Done dropped first past the cap. */
export function addNotifications(
  toasts: readonly AgentNotification[],
  incoming: readonly AgentNotification[],
): AgentNotification[] {
  let result = [...toasts];
  for (const notification of incoming) {
    if (notification.level === "done") {
      const previous = result.filter((toast) => toast.level === "done");
      result = result.filter((toast) => toast.level !== "done");
      result.unshift({
        ...notification,
        subjects: unique([
          ...notification.subjects,
          ...previous.flatMap((toast) => toast.subjects),
        ]),
      });
    } else result.unshift(notification);
  }
  while (result.length > MAX_TOASTS) {
    const done = result.findIndex((toast) => toast.level === "done");
    result.splice(done >= 0 ? done : result.length - 1, 1);
  }
  return result;
}

/** Needs-you toasts leave once their sessions no longer need the user or come into view. */
export function retireNotifications(
  toasts: readonly AgentNotification[],
  states: ReadonlyMap<string, AgentState>,
  inView: (subject: NotifySubject) => boolean,
): AgentNotification[] {
  let changed = false;
  const result = toasts.flatMap((toast) => {
    if (toast.level !== "needs-you") return [toast];
    const subjects = toast.subjects.flatMap((subject) => {
      const state = states.get(subject.key);
      if (!state || !ACTIVE.has(state) || inView(subject)) return [];
      return [states.get(subject.key) === subject.state ? subject : { ...subject, state }];
    });
    if (
      subjects.length === toast.subjects.length &&
      subjects.every((subject, index) => subject === toast.subjects[index])
    )
      return [toast];
    changed = true;
    return subjects.length ? [{ ...toast, subjects }] : [];
  });
  return changed ? result : (toasts as AgentNotification[]);
}

export function notificationHeading(notification: AgentNotification): string {
  const count = notification.subjects.length;
  if (count > 1)
    return notification.level === "done"
      ? `${count} sessions finished`
      : `${count} sessions need you`;
  const [subject] = notification.subjects;
  return subject.title;
}

export function notificationAnnouncement(notification: AgentNotification): string {
  if (notification.subjects.length > 1) return notificationHeading(notification);
  const [subject] = notification.subjects;
  return `${AGENT_STATES[subject.state].label}: ${subject.agent} · ${subject.title}`;
}

export function shouldPlaySound(
  notification: AgentNotification,
  prefs: NotificationPrefs,
): boolean {
  return (
    notification.level === "needs-you" &&
    prefs.sound &&
    prefs.volume > 0 &&
    notification.subjects.some(
      (subject) => !subject.projectId || !prefs.mutedProjects.includes(subject.projectId),
    )
  );
}

export function parseNotificationPrefs(raw: string | null): NotificationPrefs {
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    if (!value || typeof value !== "object") return DEFAULT_NOTIFICATION_PREFS;
    const record = value as Record<string, unknown>;
    const volume = typeof record.volume === "number" ? record.volume : NaN;
    return {
      sound: typeof record.sound === "boolean" ? record.sound : DEFAULT_NOTIFICATION_PREFS.sound,
      volume: Number.isFinite(volume)
        ? Math.min(1, Math.max(0, volume))
        : DEFAULT_NOTIFICATION_PREFS.volume,
      mutedProjects: Array.isArray(record.mutedProjects)
        ? record.mutedProjects.filter((id): id is string => typeof id === "string")
        : [],
    };
  } catch {
    return DEFAULT_NOTIFICATION_PREFS;
  }
}

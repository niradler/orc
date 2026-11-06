import { PUSH_TOPICS, type PushDevice, type PushTopic } from "@orc/core/push";
import { Bell, BellOff, Send, Trash2, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useProjects } from "@/hooks/useProjects";
import {
  useDisablePush,
  useEnablePush,
  usePushDevices,
  useRemovePushDevice,
  useTestPush,
  useThisPushDevice,
  useUpdatePushTopics,
} from "@/hooks/usePush";
import {
  playNeedsYouSound,
  setNotificationPrefs,
  unlockNotificationSound,
  useNotificationPrefs,
} from "@/lib/notification-sound";
import { type PushSupport, pushSupport } from "@/lib/pwa";

const TOPIC_LABELS: Record<PushTopic, string> = {
  attention: "Attention needed (approvals and questions from agents)",
  chat: "Chat replies and chat approvals",
};

const UNSUPPORTED_REASONS: Record<Exclude<PushSupport, "supported">, string> = {
  insecure: "Notifications need HTTPS. Open ORC through an https:// address to enable them.",
  "install-required":
    "On iPhone and iPad, add ORC to the Home Screen (Share → Add to Home Screen), then open it from there.",
  unsupported: "This browser does not support push notifications.",
};

function errorText(...errors: (Error | null)[]): string | undefined {
  return errors.find(Boolean)?.message;
}

function formatTime(timestamp: number | null): string {
  return timestamp ? new Date(timestamp).toLocaleString() : "never";
}

function TopicToggles({ device }: { device: PushDevice }) {
  const update = useUpdatePushTopics();
  const toggle = (topic: PushTopic, enabled: boolean) => {
    const topics = enabled
      ? [...device.topics, topic]
      : device.topics.filter((current) => current !== topic);
    update.mutate({ id: device.id, topics });
  };
  return (
    <fieldset className="space-y-2" disabled={update.isPending}>
      <legend className="mb-1 text-sm font-medium">Notify this device about</legend>
      {PUSH_TOPICS.map((topic) => (
        <label key={topic} className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            data-testid={`push-topic-${topic}`}
            checked={device.topics.includes(topic)}
            onChange={(event) => toggle(topic, event.target.checked)}
          />
          {TOPIC_LABELS[topic]}
        </label>
      ))}
    </fieldset>
  );
}

function SoundSettings() {
  const prefs = useNotificationPrefs();
  const projects = useProjects({ status: "active" });
  const toggleProject = (id: string, muted: boolean) =>
    setNotificationPrefs({
      mutedProjects: muted
        ? [...prefs.mutedProjects, id]
        : prefs.mutedProjects.filter((current) => current !== id),
    });
  const preview = () => {
    unlockNotificationSound();
    window.setTimeout(() => playNeedsYouSound(prefs.volume), 50);
  };
  return (
    <div className="mt-6 space-y-3" data-testid="notification-sound-settings">
      <div>
        <h3 className="text-sm font-medium">Sound</h3>
        <p className="text-sm text-muted-foreground">
          A short chime plays in this browser when an agent needs you. Finished sessions stay
          silent; every alert also shows a toast.
        </p>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          data-testid="notification-sound-enabled"
          checked={prefs.sound}
          onChange={(event) => setNotificationPrefs({ sound: event.target.checked })}
        />
        Play a sound when an agent needs you
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor="notification-volume" className="text-sm">
          Volume
        </label>
        <input
          id="notification-volume"
          type="range"
          min={0}
          max={100}
          step={5}
          data-testid="notification-sound-volume"
          disabled={!prefs.sound}
          value={Math.round(prefs.volume * 100)}
          onChange={(event) => setNotificationPrefs({ volume: Number(event.target.value) / 100 })}
          className="w-40 accent-primary"
        />
        <span className="w-10 text-sm tabular-nums text-outline">
          {Math.round(prefs.volume * 100)}%
        </span>
        <Button
          variant="outline"
          size="sm"
          data-testid="notification-sound-test"
          disabled={!prefs.sound || prefs.volume === 0}
          onClick={preview}
        >
          <Volume2 className="size-4" />
          Play test sound
        </Button>
      </div>
      {(projects.data?.length ?? 0) > 0 && (
        <fieldset className="space-y-1.5" disabled={!prefs.sound}>
          <legend className="mb-1 text-sm font-medium">Mute projects</legend>
          {projects.data?.map((project) => (
            <label key={project.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                data-testid={`notification-mute-${project.id}`}
                checked={prefs.mutedProjects.includes(project.id)}
                onChange={(event) => toggleProject(project.id, event.target.checked)}
              />
              <span className="truncate">{project.name}</span>
            </label>
          ))}
        </fieldset>
      )}
    </div>
  );
}

export function NotificationSettings() {
  const support = pushSupport();
  const thisDevice = useThisPushDevice();
  const devices = usePushDevices();
  const enable = useEnablePush();
  const disable = useDisablePush();
  const remove = useRemovePushDevice();
  const test = useTestPush();
  const current = thisDevice.data ?? null;
  const others = (devices.data ?? []).filter((device) => device.id !== current?.id);
  const error = errorText(enable.error, disable.error, remove.error, test.error);

  return (
    <section aria-labelledby="notifications-title">
      <h2 id="notifications-title" className="mb-1 text-base font-medium">
        Notifications
      </h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Get a push notification on this device when an agent needs your approval or answer, or a
        chat reply is ready. Notifications are skipped while ORC is open and focused.
      </p>
      <Separator className="mb-4" />
      {support !== "supported" ? (
        <p data-testid="push-unsupported" className="text-sm text-muted-foreground">
          {UNSUPPORTED_REASONS[support]}
        </p>
      ) : (
        <div className="space-y-4">
          {current ? (
            <>
              <TopicToggles device={current} />
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  data-testid="push-test"
                  disabled={test.isPending}
                  onClick={() => test.mutate(current.id)}
                >
                  <Send className="mr-2 size-4" />
                  Send test notification
                </Button>
                <Button
                  variant="outline"
                  data-testid="push-disable"
                  disabled={disable.isPending}
                  onClick={() => disable.mutate(current.id)}
                >
                  <BellOff className="mr-2 size-4" />
                  Turn off on this device
                </Button>
              </div>
            </>
          ) : (
            <Button
              data-testid="push-enable"
              disabled={enable.isPending || thisDevice.isLoading}
              onClick={() => enable.mutate()}
            >
              <Bell className="mr-2 size-4" />
              {enable.isPending ? "Enabling…" : "Enable notifications on this device"}
            </Button>
          )}
          {test.data && (
            <p role="status" className="text-sm text-muted-foreground">
              {test.data.sent
                ? "Test sent. Switch away from ORC to see it."
                : "Test not delivered."}
            </p>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-error">
          {error}
        </p>
      )}
      <SoundSettings />
      {others.length > 0 && (
        <div className="mt-6">
          <h3 className="mb-2 text-sm font-medium">Other devices</h3>
          <ul className="space-y-2" data-testid="push-devices">
            {others.map((device) => (
              <li key={device.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="min-w-0">
                  <span className="block truncate">{device.label}</span>
                  <span className="block text-xs text-muted-foreground">
                    Last delivered {formatTime(device.last_success_at)}
                    {device.failure_count > 0 && ` · ${device.failure_count} failed`}
                  </span>
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${device.label}`}
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(device.id)}
                >
                  <Trash2 className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

import { ArrowLeft, CheckCheck } from "lucide-react";
import { useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { NotificationListBody, useNotificationCenter } from "@/components/AgentNotifications";
import { Button } from "@/components/ui/button";
import { ViewHeader } from "@/components/ViewHeader";

/**
 * Full-page notification center. On phones the bell navigates here instead of
 * opening a modal popover; desktop keeps the popover and can also share this URL.
 */
export default function Notifications() {
  const center = useNotificationCenter();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const linkedRequest = searchParams.get("request");
  const setSelected = center.setSelected;
  useEffect(() => {
    if (linkedRequest) setSelected(linkedRequest);
  }, [linkedRequest, setSelected]);
  const back = () => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) navigate(-1);
    else navigate("/activity");
  };
  const openRequest = (id: string) => {
    center.setSelected(id);
    const item = center.items.find(
      (entry) => entry.type === "human.request" && entry.source_id === id,
    );
    if (item && !item.read_at) center.setRead(item.id, true);
  };
  return (
    <div
      data-testid="notifications-page"
      className="flex h-full min-h-0 w-full min-w-0 flex-col bg-background"
    >
      {center.phone ? (
        <header className="flex min-h-12 shrink-0 items-center gap-1 border-b border-border px-2">
          <Button
            variant="ghost"
            size="icon"
            data-testid="notifications-back"
            aria-label="Back"
            className="min-h-11 min-w-11"
            onClick={back}
          >
            <ArrowLeft />
          </Button>
          <h1 className="min-w-0 truncate font-headline text-base font-medium text-on-surface">
            Notifications
          </h1>
          {center.unread > 0 && (
            <span className="shrink-0 text-sm text-outline">{center.unread} unread</span>
          )}
          <div className="min-w-0 flex-1" />
          <Button
            variant="ghost"
            size="icon"
            data-testid="notifications-mark-all-read"
            aria-label="Mark all read"
            title="Mark all read"
            className="min-h-11 min-w-11"
            disabled={!center.unread || center.markAllBusy}
            onClick={center.markAllRead}
          >
            <CheckCheck />
          </Button>
        </header>
      ) : (
        <div className="shrink-0 px-6 pt-6">
          <ViewHeader
            title="Notifications"
            meta={`${center.unread} unread`}
            action={
              <Button
                size="sm"
                variant="ghost"
                data-testid="notifications-mark-all-read"
                disabled={!center.unread || center.markAllBusy}
                onClick={center.markAllRead}
              >
                <CheckCheck /> Mark all read
              </Button>
            }
          />
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)]">
        <NotificationListBody onOpenRequest={openRequest} />
      </div>
    </div>
  );
}

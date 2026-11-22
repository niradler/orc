import { RotateCw } from "lucide-react";
import { HelpPopover } from "@/components/HelpPopover";
import { Button } from "@/components/ui/button";
import { useHealth } from "@/hooks/useHealth";
import { useRestartServer } from "@/hooks/useRestartServer";

export function ServerSettings() {
  const { data: health } = useHealth();
  const restart = useRestartServer();
  return (
    <section aria-labelledby="server-title">
      <div className="mb-1 flex items-center gap-1">
        <h2 id="server-title" className="text-base font-medium">
          Server maintenance
        </h2>
        <HelpPopover label="server restart" testId="settings-restart-help">
          Restarting reloads the server and its host state, keeps your settings and reconnects this
          dashboard automatically.
        </HelpPopover>
      </div>
      <p className="mb-4 text-sm text-muted-foreground">
        Closes active terminals and may interrupt running work.
      </p>
      <Button
        variant="outline"
        data-testid="settings-restart"
        disabled={!health?.restart_supported || restart.isPending}
        onClick={() => restart.mutate()}
      >
        <RotateCw className={restart.isPending ? "mr-2 size-4 animate-spin" : "mr-2 size-4"} />
        {restart.isPending ? "Restarting and reconnecting…" : "Restart ORC server"}
      </Button>
      {health && !health.restart_supported && (
        <p className="mt-2 text-sm text-muted-foreground">
          This server does not support restart from the dashboard.
        </p>
      )}
      {restart.isPending && (
        <p
          role="status"
          data-testid="settings-restart-status"
          className="mt-2 text-sm text-muted-foreground"
        >
          Waiting for ORC to restart…
        </p>
      )}
      {restart.isSuccess && (
        <p
          role="status"
          data-testid="settings-restart-status"
          className="mt-2 text-sm text-muted-foreground"
        >
          ORC restarted. Reconnected.
        </p>
      )}
      {restart.isError && (
        <p role="alert" data-testid="settings-restart-error" className="mt-2 text-sm text-error">
          {restart.error.message}
        </p>
      )}
    </section>
  );
}

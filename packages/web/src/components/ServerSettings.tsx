import { RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useHealth } from "@/hooks/useHealth";
import { useRestartServer } from "@/hooks/useRestartServer";

export function ServerSettings() {
  const { data: health } = useHealth();
  const restart = useRestartServer();
  return (
    <section aria-labelledby="server-title">
      <h2 id="server-title" className="mb-1 text-base font-medium">
        ORC server
      </h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Restart ORC to reload server and host information. This closes active terminals and may
        interrupt running work. Your settings are kept, and this dashboard reconnects automatically.
        Switching hosts applies to new actions without a restart.
      </p>
      <Separator className="mb-4" />
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

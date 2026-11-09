import { ChevronDown } from "lucide-react";
import { useState } from "react";
import type { CreateTerminalInput } from "@/api/client";
import { NewTerminalMenu } from "@/components/terminals/NewTerminalMenu";
import { WorktreeManager } from "@/components/terminals/WorktreeManager";
import { useChat } from "@/hooks/useChat";
import { useSessionHome } from "@/hooks/useSessionHome";
import { useSsh } from "@/hooks/useSsh";
import { useTerminals } from "@/lib/terminals";

export function SessionLaunchMenu({ worktrees = false }: { worktrees?: boolean }) {
  const { create, info } = useTerminals();
  const { data: ssh } = useSsh();
  const home = useSessionHome();
  const chat = useChat();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function launch(input: CreateTerminalInput): Promise<boolean> {
    if (pending) return false;
    setPending(true);
    setError(null);
    try {
      const terminal = await create(input);
      chat.newTab({ fresh: true });
      home.go({ terminalId: terminal.id, liveId: null, listOpen: false });
      setOpen(false);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not launch terminal.");
      return false;
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="flex min-w-0 items-center gap-1" data-testid="session-launch-menu">
      <NewTerminalMenu
        triggerIcon={<ChevronDown size={15} />}
        open={open}
        onOpenChange={setOpen}
        launchers={info?.launchers ?? []}
        host={ssh?.host ?? null}
        pending={pending}
        error={error}
        onCreate={launch}
        compact
        iconOnly
      />
      {worktrees && (
        <WorktreeManager
          launchers={info?.launchers ?? []}
          host={ssh?.host ?? null}
          onCreate={launch}
        />
      )}
      {error && !open && (
        <p role="alert" className="text-xs text-error">
          {error}
        </p>
      )}
    </div>
  );
}

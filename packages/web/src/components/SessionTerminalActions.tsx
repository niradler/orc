import { useState } from "react";
import type { Terminal } from "@/api/client";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { RenameTerminal } from "@/components/terminals/RenameTerminal";
import { TerminalActions } from "@/components/terminals/TerminalActions";
import { useChat } from "@/hooks/useChat";
import { useSessionHome } from "@/hooks/useSessionHome";
import { useSsh } from "@/hooks/useSsh";
import { useTerminals } from "@/lib/terminals";

export function SessionTerminalActions({ terminal }: { terminal: Terminal }) {
  const { create, remove, info } = useTerminals();
  const { data: ssh } = useSsh();
  const chat = useChat();
  const home = useSessionHome();
  const [renaming, setRenaming] = useState(false);
  const [closing, setClosing] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const canDuplicate =
    !!info && (terminal.host ? ssh?.supported === true : info.launchers.includes(terminal.kind));
  async function duplicate(): Promise<void> {
    if (!canDuplicate || pending) return;
    setPending(true);
    setError("");
    try {
      const next = await create({
        kind: terminal.kind,
        ...(terminal.cwd ? { cwd: terminal.cwd } : {}),
        host: terminal.host,
        name: `${terminal.name.slice(0, 113)} (copy)`,
      });
      chat.newTab({ fresh: true });
      home.go({ terminalId: next.id });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not duplicate terminal.");
    } finally {
      setPending(false);
    }
  }
  async function close(): Promise<void> {
    setPending(true);
    setError("");
    try {
      await remove(terminal.id);
      setClosing(false);
      home.go({ terminalId: null });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not close terminal.");
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <TerminalActions
        terminal={terminal}
        pending={pending}
        canDuplicate={canDuplicate}
        onRename={() => setRenaming(true)}
        onClose={() => setClosing(true)}
        onDuplicate={() => void duplicate()}
      />
      {renaming && <RenameTerminal terminal={terminal} onClose={() => setRenaming(false)} />}
      <ConfirmDialog
        open={closing}
        onCancel={() => {
          if (!pending) setClosing(false);
        }}
        isPending={pending}
        title="Close terminal?"
        description={`Stop ${terminal.name} and its running process? Closing a workspace pane leaves it running.`}
        confirmLabel="Close terminal"
        onConfirm={() => void close()}
      />
      {error && (
        <p role="alert" className="text-xs text-error">
          {error}
        </p>
      )}
    </>
  );
}

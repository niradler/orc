import type { SessionLineage as Lineage } from "@orc/core/session-messages";
import { GitBranch } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/api/client";
import { HelpPopover } from "@/components/HelpPopover";
import { useChat } from "@/hooks/useChat";
import { useSessionLineage } from "@/hooks/useSessions";

type Node = NonNullable<Lineage["parent"]>;

function NodeLink({ node, onOpen }: { node: Node; onOpen: (node: Node) => void }) {
  return (
    <button
      type="button"
      data-testid={`session-lineage-${node.kind}-${node.id}`}
      onClick={() => onOpen(node)}
      className="min-h-11 min-w-0 max-w-full truncate px-1 text-left underline underline-offset-2 hover:text-on-surface"
    >
      {node.title}
      <span className="ml-1 text-outline">({node.status})</span>
    </button>
  );
}

export function SessionLineage({ sessionId }: { sessionId: string | null }) {
  const { data } = useSessionLineage(sessionId);
  const chat = useChat();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parent = data?.parent ?? null;
  const children = Array.isArray(data?.children) ? data.children : [];
  if (!parent && !children.length) return null;

  async function openNode(node: Node): Promise<void> {
    setError(null);
    if (node.kind === "session") {
      navigate(`/sessions?session=${encodeURIComponent(node.id)}&project=all`);
      return;
    }
    try {
      chat.openThread(await api.chat.get(node.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The session could not be opened.");
    }
  }

  return (
    <section
      data-testid="session-lineage"
      className="mx-auto mb-2 flex w-full min-w-0 max-w-3xl flex-wrap items-center gap-x-2 text-xs text-on-surface-variant"
    >
      <GitBranch aria-hidden="true" size={14} className="shrink-0" />
      {parent && (
        <span className="flex min-w-0 flex-1 items-center">
          <span className="shrink-0 whitespace-nowrap">Started by</span>
          <NodeLink node={parent} onOpen={(node) => void openNode(node)} />
        </span>
      )}
      {children.length > 0 && (
        <button
          type="button"
          data-testid="session-lineage-toggle"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="min-h-11 shrink-0 whitespace-nowrap px-1 underline underline-offset-2 hover:text-on-surface"
        >
          Started {children.length} session{children.length === 1 ? "" : "s"}
        </button>
      )}
      <HelpPopover label="About delegated sessions">
        Agents start sessions with session_start, or delegate through tasks. A child reports its
        result back to the session that started it.
      </HelpPopover>
      {open && (
        <ul className="w-full pl-5">
          {children.map((child) => (
            <li key={child.id}>
              <NodeLink node={child} onOpen={(node) => void openNode(node)} />
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="w-full text-error">
          {error}
        </p>
      )}
    </section>
  );
}

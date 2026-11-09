import { createContext, type ReactNode, useContext, useMemo } from "react";

type Member = { terminals: Set<string>; focus: (id: string) => void };
const Group = createContext<{
  register: (owner: symbol, member: Member) => () => void;
  focus: (id: string, except?: symbol) => boolean;
} | null>(null);

/** Parallel workspaces share PTYs, so selecting an open PTY focuses its existing pane. */
export function TerminalWorkspaceGroup({ children }: { children: ReactNode }) {
  const group = useMemo(() => {
    const members = new Map<symbol, Member>();
    return {
      register(owner: symbol, member: Member) {
        members.set(owner, member);
        return () => {
          members.delete(owner);
        };
      },
      focus(id: string, except?: symbol) {
        for (const [owner, member] of members) {
          if (owner !== except && member.terminals.has(id)) {
            member.focus(id);
            return true;
          }
        }
        return false;
      },
    };
  }, []);
  return <Group.Provider value={group}>{children}</Group.Provider>;
}

export function useTerminalWorkspaceGroup() {
  return useContext(Group);
}

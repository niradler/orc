import { createContext, type ReactNode, useContext, useMemo } from "react";

type SelectedProject = {
  projectId: string;
  setProjectId: (id: string) => void;
};

const SelectedProjectContext = createContext<SelectedProject | null>(null);

/** The project scope chosen in the header; opening a folder-scoped session can adopt it. */
export function SelectedProjectProvider({
  projectId,
  setProjectId,
  children,
}: SelectedProject & { children: ReactNode }) {
  // A stable value keeps adoption effects from re-running on every render.
  const value = useMemo(() => ({ projectId, setProjectId }), [projectId, setProjectId]);
  return (
    <SelectedProjectContext.Provider value={value}>{children}</SelectedProjectContext.Provider>
  );
}

export function useSelectedProject(): SelectedProject {
  const value = useContext(SelectedProjectContext);
  if (!value) throw new Error("useSelectedProject must be used inside SelectedProjectProvider");
  return value;
}

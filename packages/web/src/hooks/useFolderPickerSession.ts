import { useCallback, useState } from "react";
import type { HostDirectoryListing } from "@/api/client";

function initialSession(initial: string) {
  return {
    request: { path: initial } as { path: string; historyIndex?: number },
    history: { paths: [] as string[], index: -1 },
    lastGood: undefined as HostDirectoryListing | undefined,
    selected: null as string | null,
    editingAddress: false,
    address: initial,
  };
}

export function useFolderPickerSession(initial = "") {
  const [state, setState] = useState(() => initialSession(initial));
  const reset = useCallback((path: string) => setState(initialSession(path)), []);
  return { state, setState, reset };
}

export type FolderPickerSession = ReturnType<typeof useFolderPickerSession>;

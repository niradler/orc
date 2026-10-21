import { useState } from "react";

/** Selection is scoped to currently displayed records, never an implicit server-wide set. */
export function useListSelection(visibleIds: string[], scope: string) {
  const [state, setState] = useState<{ scope: string; ids: string[] }>({ scope, ids: [] });
  const selectedIds =
    state.scope === scope ? state.ids.filter((id) => visibleIds.includes(id)) : [];
  if (state.scope !== scope || selectedIds.length !== state.ids.length) {
    setState({ scope, ids: selectedIds });
  }
  function select(ids: string[]): void {
    setState({ scope, ids: ids.filter((id) => visibleIds.includes(id)) });
  }
  function toggle(id: string): void {
    select(
      selectedIds.includes(id)
        ? selectedIds.filter((selected) => selected !== id)
        : [...selectedIds, id],
    );
  }
  return {
    selectedIds,
    allSelected: visibleIds.length > 0 && selectedIds.length === visibleIds.length,
    someSelected: selectedIds.length > 0 && selectedIds.length < visibleIds.length,
    select,
    toggle,
    selectAll: () => select(visibleIds),
    clear: () => select([]),
  };
}

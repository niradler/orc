export function isFilterToggleKey(name: string): boolean {
  return name === "/" || name === "f";
}

export function isRefreshKey(name: string): boolean {
  return name === "r";
}

export function isOpenDetailKey(name: string): boolean {
  return name === "return";
}

export function handleFilterInputKey(
  name: string,
  setFilterActive: (active: boolean) => void,
): boolean {
  if (name === "escape" || name === "return") {
    setFilterActive(false);
  }
  return true;
}

export function handleDetailEscapeKey(name: string, onExit: () => void): boolean {
  if (name === "escape") {
    onExit();
    return true;
  }
  return false;
}

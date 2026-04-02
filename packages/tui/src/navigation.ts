export function canSwitchRoutes(commandPaletteActive: boolean, navigationLocked: boolean): boolean {
  return !commandPaletteActive && !navigationLocked;
}

export function canHandleCommandInput(
  commandPaletteActive: boolean,
  navigationLocked: boolean,
): boolean {
  return commandPaletteActive || !navigationLocked;
}

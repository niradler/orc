export type TerminalKeyAction = "copy" | "copy-and-clear" | "select-all" | "swallow" | "pass";

export interface TerminalKeyInput {
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const withUserAgentData = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform =
    withUserAgentData.userAgentData?.platform || navigator.platform || navigator.userAgent;
  return /mac|iphone|ipad|ipod/i.test(platform);
}

export function resolveTerminalKey(
  key: TerminalKeyInput,
  mac: boolean,
  hasSelection: boolean,
): TerminalKeyAction {
  if (key.altKey) return "pass";
  if (mac) {
    if (!key.metaKey || key.ctrlKey) return "pass";
    if (key.code === "KeyA") return "select-all";
    if (key.code === "KeyC") return hasSelection ? "copy" : "swallow";
    return "pass";
  }
  if (!key.ctrlKey || key.metaKey) return "pass";
  if (key.code === "KeyA" && key.shiftKey) return "select-all";
  if (key.code === "KeyC" && key.shiftKey) return hasSelection ? "copy" : "swallow";
  if (key.code === "KeyC") return hasSelection ? "copy-and-clear" : "pass";
  return "pass";
}

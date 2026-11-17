/** Shared clipboard write with the same fallback and message as message Copy. */
export const CLIPBOARD_ERROR = "Clipboard access failed. Allow clipboard access and try again.";

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.append(area);
      try {
        area.select();
        if (!document.execCommand("copy")) throw new Error("Clipboard copy was rejected.");
      } finally {
        area.remove();
      }
    }
    return true;
  } catch {
    return false;
  }
}

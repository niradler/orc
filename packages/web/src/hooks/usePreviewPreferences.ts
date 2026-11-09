import type { PreviewPreferences } from "@orc/core/desktop-preview";
import { useEffect, useState } from "react";
import { desktopBridge } from "@/lib/desktop-bridge";

export function usePreviewPreferences() {
  const bridge = desktopBridge()?.preview;
  const [settings, setSettings] = useState<PreviewPreferences | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!bridge) return;
    let active = true;
    const unsubscribe = bridge.onPreferences((value) => {
      setSettings(value);
      setError(null);
    });
    void bridge
      .preferences()
      .then((value) => {
        if (active) setSettings(value);
      })
      .catch(() => {
        if (active)
          setError("Browser preferences could not be loaded. Reset them in Settings → Browser.");
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [bridge]);
  async function save(value: PreviewPreferences): Promise<void> {
    if (!bridge || busy) return;
    setBusy(true);
    setError(null);
    try {
      setSettings(await bridge.setPreferences(value));
    } catch {
      setError("Browser preferences could not be saved. Your previous settings remain active.");
    } finally {
      setBusy(false);
    }
  }
  return { settings, error, busy, save };
}

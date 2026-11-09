import { createContext, useContext } from "react";

export interface DesktopPreviewContextValue {
  browserControl: {
    enabled: boolean;
    available: boolean;
    setEnabled(enabled: boolean): void;
  };
  openLink(href: string, baseFile?: string): Promise<boolean>;
  openFile(path: string, line?: number): Promise<void>;
  toggle(): void;
}
export const DesktopPreviewContext = createContext<DesktopPreviewContextValue | null>(null);
export function useDesktopPreview(): DesktopPreviewContextValue | null {
  return useContext(DesktopPreviewContext);
}

import type { BrowserAction, PreviewBrowserState, PreviewProfile } from "@orc/core/desktop-preview";
import { createContext, useContext } from "react";

/** A file opened from a chat link, an attachment or the native picker, shown
 *  as a tab beside the browser. The Files inspector tab browses the checkout. */
export type PreviewFileTab = {
  id: string;
  path: string;
  kind: "text" | "image";
  editable: boolean;
  localToken?: string;
  host: string | null;
  text: string;
  original: string;
  saving: boolean;
  error: string | null;
  line: number | null;
};

export type PreviewRecording = {
  path: string | null;
  saving: boolean;
  name: string;
  url: string;
};

/** Browser state and actions for the inspector's desktop-only Browser tab. */
export interface DesktopBrowserPaneValue {
  state: PreviewBrowserState | null;
  address: string;
  setAddress(value: string): void;
  files: PreviewFileTab[];
  activeFileId: string | null;
  loading: boolean;
  error: string | null;
  /** Agent preview delivery can be unavailable for this session/host. */
  deliveryError: string | null;
  profiles: PreviewProfile[];
  profileId: string | null;
  displayBusy: boolean;
  recording: PreviewRecording | null;
  dialogText: string;
  setDialogText(value: string): void;
  dismissError(): void;
  open(url: string): void;
  navigate(action: "back" | "forward" | "reload"): void;
  changeTab(action: "tab_select" | "tab_close", tabId: string): void;
  newTab(): void;
  display(command: BrowserAction): void;
  selectProfile(id: string | null): void;
  showFile(id: string): void;
  closeFile(id: string): void;
  reloadFile(id: string): void;
  saveFile(id: string): void;
  editFile(id: string, text: string): void;
  pick(): void;
  external(url: string): void;
  externalFile(path: string, host: string | null): void;
  openRecording(): void;
  acceptDialog(accept: boolean): void;
  attachSurface(element: HTMLDivElement | null): void;
}

export interface DesktopPreviewContextValue {
  browserControl: {
    enabled: boolean;
    globallyEnabled: boolean;
    pending: boolean;
    setEnabled(enabled: boolean): void;
  };
  browser: DesktopBrowserPaneValue;
  openLink(href: string, baseFile?: string): Promise<boolean>;
  openFile(path: string, line?: number): Promise<void>;
  /** Registers a listener that opens the inspector's Browser tab. */
  subscribeOpen(listener: () => void): () => void;
}
export const DesktopPreviewContext = createContext<DesktopPreviewContextValue | null>(null);
export function useDesktopPreview(): DesktopPreviewContextValue | null {
  return useContext(DesktopPreviewContext);
}

import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  FolderOpen,
  Globe,
  LoaderCircle,
  RefreshCw,
  Save,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { getApiUrl } from "@/api/client";
import { CodeEditor } from "@/components/CodeEditor";
import {
  DesktopPreviewContext,
  type PreviewFileTab,
  useDesktopPreview,
} from "@/lib/desktop-preview-context";

const button =
  "inline-flex h-8 min-w-8 shrink-0 items-center justify-center gap-1 rounded px-2 text-xs hover:bg-surface-highest disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-focus max-sm:min-h-11";

function Tab({
  active,
  title,
  onSelect,
  children,
}: {
  active: boolean;
  title: string;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={active}
      className={button + (active ? " bg-surface-highest" : "")}
      onClick={onSelect}
    >
      {children}
    </button>
  );
}

function FilePane({ tab }: { tab: PreviewFileTab }) {
  const preview = useDesktopPreview();
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (!preview) return null;
  const browser = preview.browser;
  const external =
    !!tab.localToken ||
    !!tab.host ||
    ["127.0.0.1", "localhost", "[::1]"].includes(new URL(getApiUrl(), location.href).hostname);
  return (
    <>
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
        <span title={tab.path} className="min-w-0 flex-1 truncate text-xs text-on-surface-variant">
          {tab.path}
        </span>
        <button
          type="button"
          className={button}
          aria-label="Reload file"
          title="Reload file"
          disabled={tab.saving}
          onClick={() => browser.reloadFile(tab.id)}
        >
          <RefreshCw size={14} />
        </button>
        {tab.kind === "text" && (
          <button
            type="button"
            data-testid="preview-save"
            className={button}
            disabled={!tab.editable || tab.saving || tab.text === tab.original}
            onClick={() => browser.saveFile(tab.id)}
          >
            <Save size={14} />
            {tab.saving ? "Saving…" : "Save"}
          </button>
        )}
        <button
          type="button"
          className={button}
          aria-label="Open file in VS Code"
          title={
            external
              ? "Open file in VS Code"
              : "External editor is unavailable for this remote API host"
          }
          disabled={!external}
          onClick={() => browser.externalFile(tab.path, tab.host)}
        >
          <ExternalLink size={14} />
        </button>
      </div>
      {tab.error && (
        <div role="alert" className="shrink-0 px-3 py-2 text-xs text-error">
          {tab.error}
          {tab.kind === "text" ? " Your draft is preserved." : ""}
        </div>
      )}
      {tab.kind === "image" ? (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-3">
          {failedSrc === tab.text ? (
            <p role="alert" className="text-xs text-error">
              Image cannot be decoded by this desktop.
            </p>
          ) : (
            <img
              data-testid="preview-image"
              src={tab.text}
              alt={tab.path.split(/[\\/]/).pop()}
              className="max-w-full max-h-full object-contain"
              onError={() => setFailedSrc(tab.text)}
            />
          )}
        </div>
      ) : (
        <DesktopPreviewContext.Provider
          value={{ ...preview, openLink: (href) => preview.openLink(href, tab.path) }}
        >
          <div className="min-h-0 flex-1 overflow-hidden" data-testid="preview-file-editor">
            <CodeEditor
              key={tab.id}
              path={tab.path}
              value={tab.text}
              {...(tab.line ? { line: tab.line } : {})}
              initialMode={tab.line || tab.text !== tab.original ? "edit" : "read"}
              readOnly={!tab.editable || tab.saving}
              onChange={(value) => browser.editFile(tab.id, value)}
              onSave={() => browser.saveFile(tab.id)}
              height="100%"
              compact
              previewLinks
              testId="preview-editor-input"
            />
          </div>
        </DesktopPreviewContext.Provider>
      )}
    </>
  );
}

/** The desktop-only inspector tab: browser tabs, address bar, display and
 *  recording settings, plus the files opened from chat links and attachments. */
export function InspectorBrowser(): ReactNode {
  const preview = useDesktopPreview();
  const panel = useRef<HTMLDivElement>(null);
  const state = preview?.browser.state ?? null;
  const dialog = state?.dialog ?? null;
  const dialogSession = dialog && state ? state.session_id : null;
  const activeFileId = preview?.browser.activeFileId ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: switching from a file tab back to the Browser tab must re-run the focus check
  useEffect(() => {
    if (!dialogSession) return;
    const previous = document.activeElement;
    const frame = requestAnimationFrame(() =>
      panel.current
        ?.querySelector<HTMLElement>(
          '[data-testid="preview-page-dialog"] input, [data-testid="preview-page-dialog"] button',
        )
        ?.focus(),
    );
    return () => {
      cancelAnimationFrame(frame);
      if (previous instanceof HTMLElement && previous !== document.body && previous.isConnected)
        previous.focus();
    };
  }, [dialogSession, activeFileId]);
  if (!preview) return null;
  const browser = preview.browser;
  const selected = browser.files.find((file) => file.id === browser.activeFileId) ?? null;
  return (
    <div
      ref={panel}
      data-testid="inspector-browser"
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2 max-sm:h-12">
        <nav aria-label="Preview tabs" className="flex min-w-0 flex-1 overflow-x-auto">
          <Tab active={!selected} title="Browser" onSelect={() => browser.showFile("browser")}>
            <Globe size={14} />
            Browser
          </Tab>
          {browser.files.map((tab) => (
            <div key={tab.id} className="flex shrink-0 items-center">
              <Tab
                active={selected?.id === tab.id}
                title={tab.path}
                onSelect={() => browser.showFile(tab.id)}
              >
                {tab.path.split(/[\\/]/).pop()}
                {tab.text !== tab.original ? " ●" : ""}
              </Tab>
              <button
                type="button"
                className={button}
                aria-label={`Close ${tab.path}`}
                disabled={tab.saving}
                onClick={() => browser.closeFile(tab.id)}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </nav>
        <button
          type="button"
          className={button}
          data-testid="desktop-preview-pick"
          aria-label="Open file"
          title="Open file"
          onClick={() => browser.pick()}
        >
          <FolderOpen size={14} />
        </button>
      </div>
      {browser.error && (
        <div role="alert" className="flex shrink-0 items-start gap-2 px-3 py-1 text-xs text-error">
          <span className="min-w-0 flex-1 break-words py-1">{browser.error}</span>
          <button
            type="button"
            className={button}
            aria-label="Dismiss preview error"
            data-testid="preview-error-dismiss"
            onClick={() => browser.dismissError()}
          >
            <X size={12} />
          </button>
        </div>
      )}
      {browser.deliveryError && (
        <div role="alert" className="shrink-0 break-words px-3 py-2 text-xs text-error">
          Agent preview delivery unavailable: {browser.deliveryError}
        </div>
      )}
      {browser.loading && (
        <p role="status" className="flex items-center gap-2 px-3 py-2 text-xs">
          <LoaderCircle className="animate-spin" size={13} />
          Opening file…
        </p>
      )}
      {selected ? (
        <FilePane key={selected.id} tab={selected} />
      ) : (
        <>
          {dialog && (
            <div
              role="alertdialog"
              aria-label="Browser page dialog"
              className="border-b border-border p-4"
              data-testid="preview-page-dialog"
              onKeyDown={(event) => {
                if (
                  event.key === "Escape" ||
                  (event.key === "Enter" && event.target instanceof HTMLInputElement)
                ) {
                  event.preventDefault();
                  browser.acceptDialog(event.key === "Enter");
                } else if (event.key === "Tab") {
                  const controls = [
                    ...event.currentTarget.querySelectorAll<HTMLElement>("input,button"),
                  ];
                  const index = controls.indexOf(document.activeElement as HTMLElement),
                    next =
                      controls[
                        (index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length
                      ];
                  if (next) {
                    event.preventDefault();
                    next.focus();
                  }
                }
              }}
            >
              <p className="text-xs text-muted-foreground">Message from this browser page</p>
              <p className="my-2 break-words text-sm">{dialog.message}</p>
              {dialog.type === "prompt" && (
                <input
                  aria-label="Page prompt response"
                  data-testid="preview-page-prompt"
                  className="form-control form-control-single"
                  value={browser.dialogText}
                  onChange={(event) => browser.setDialogText(event.target.value)}
                />
              )}
              <div className="mt-2 flex gap-2">
                {[false, true].map((accept) => (
                  <button
                    key={String(accept)}
                    type="button"
                    className={button}
                    data-testid={accept ? "preview-dialog-accept" : "preview-dialog-dismiss"}
                    onClick={() => browser.acceptDialog(accept)}
                  >
                    {accept ? "Accept" : "Dismiss"}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="flex items-center gap-1 border-b border-border px-2 py-1">
            <nav className="flex min-w-0 flex-1 overflow-x-auto" aria-label="Browser tabs">
              {state?.tabs?.map((tab, index) => (
                <div key={tab.tab_id} className="flex shrink-0 items-center">
                  <button
                    type="button"
                    className={button}
                    title={tab.url}
                    aria-pressed={tab.tab_id === state.tab_id}
                    data-testid="preview-browser-page-tab"
                    onClick={() => browser.changeTab("tab_select", tab.tab_id)}
                  >
                    {index + 1} ·{" "}
                    {(URL.canParse(tab.url) && new URL(tab.url).hostname) || tab.url || "New tab"}
                  </button>
                  <button
                    type="button"
                    className={button}
                    aria-label={`Close browser tab ${index + 1}`}
                    onClick={() => browser.changeTab("tab_close", tab.tab_id)}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </nav>
            <button
              type="button"
              className={button}
              aria-label="New browser tab"
              data-testid="preview-browser-new-tab"
              onClick={() => browser.newTab()}
            >
              +
            </button>
          </div>
          <form
            className="flex shrink-0 items-center gap-1 border-b border-border p-2"
            onSubmit={(event) => {
              event.preventDefault();
              browser.open(browser.address.trim());
            }}
          >
            <button
              type="button"
              className={button}
              aria-label="Back"
              disabled={!state?.back}
              onClick={() => browser.navigate("back")}
            >
              <ArrowLeft size={14} />
            </button>
            <button
              type="button"
              className={button}
              aria-label="Forward"
              disabled={!state?.forward}
              onClick={() => browser.navigate("forward")}
            >
              <ArrowRight size={14} />
            </button>
            <button
              type="button"
              className={button}
              aria-label="Reload page"
              disabled={!state}
              onClick={() => browser.navigate("reload")}
            >
              <RefreshCw size={14} />
            </button>
            <input
              aria-label="Preview URL"
              value={browser.address}
              onChange={(event) => browser.setAddress(event.target.value)}
              placeholder="https://example.com"
              className="min-w-0 flex-1 rounded border border-input bg-background px-2 h-8 text-xs"
            />
            <button type="submit" className={button}>
              Go
            </button>
            <button
              type="button"
              className={button}
              aria-label="Open in system browser"
              title="Open in system browser"
              disabled={!state}
              onClick={() => browser.external(state?.url ?? "")}
            >
              <ExternalLink size={14} />
            </button>
          </form>
          <details
            className="shrink-0 border-b border-border px-3 py-1 text-xs"
            data-testid="preview-display-settings"
          >
            <summary className="cursor-pointer">Browser profile, display & recording</summary>
            <div className="flex flex-wrap items-center gap-2 py-2">
              <select
                aria-label="Browser profile"
                data-testid="preview-browser-profile"
                className="form-control h-8 min-w-0 max-w-48 text-xs"
                disabled={browser.profilesPending}
                value={browser.profileId ?? ""}
                onChange={(event) => browser.selectProfile(event.target.value || null)}
              >
                <option value="">Temporary · this chat</option>
                {browser.profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </select>
              <select
                aria-label="Browser color scheme"
                className="form-control h-8 text-xs"
                disabled={!state || browser.displayBusy}
                value={state?.color_scheme ?? "system"}
                onChange={(event) =>
                  browser.display({
                    action: "appearance",
                    color_scheme: event.target.value as "system" | "light" | "dark",
                  })
                }
              >
                <option value="system">System appearance</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
              <select
                aria-label="Browser viewport"
                className="form-control h-8 text-xs"
                defaultValue=""
                disabled={!state || browser.displayBusy}
                onChange={(event) => {
                  if (event.target.value === "fill") {
                    browser.display({ action: "resize_reset" });
                    return;
                  }
                  const [width, height] = event.target.value.split("x").map(Number);
                  if (width && height)
                    browser.display({
                      action: "resize",
                      width,
                      height,
                      device_scale_factor: 1,
                      mobile: width < 600,
                    });
                }}
              >
                <option value="" disabled>
                  Viewport size
                </option>
                <option value="1280x720">Desktop 1280 × 720</option>
                <option value="fill">Fit panel</option>
                <option value="768x1024">Tablet 768 × 1024</option>
                <option value="390x844">Phone 390 × 844</option>
              </select>
              <button
                type="button"
                className={button}
                data-testid="preview-record-start"
                disabled={!state || browser.displayBusy || state.recording_available}
                onClick={() => browser.display({ action: "recording_start", max_seconds: 60 })}
              >
                Record browser
              </button>
              <button
                type="button"
                className={button}
                data-testid="preview-record-stop"
                disabled={!state?.recording_available || browser.displayBusy}
                onClick={() => browser.display({ action: "recording_stop" })}
              >
                Save recording
              </button>
              {state?.recording && <span role="status">Recording · up to 60 seconds</span>}
              {browser.recording && (
                <button
                  type="button"
                  className={button}
                  data-testid="preview-recording-view"
                  onClick={() => browser.openRecording()}
                >
                  View {browser.recording.name.endsWith(".webm") ? "recording" : "download"}
                  {browser.recording.saving
                    ? " · saving…"
                    : browser.recording.path
                      ? " · saved"
                      : " · save failed"}
                </button>
              )}
            </div>
            {state?.downloads?.map((download) => (
              <div key={download.id} className="flex items-center gap-2 py-1">
                <span className="min-w-0 truncate">
                  {download.name} · {download.status} · {Math.ceil(download.bytes / 1024)} KB
                </span>
                {download.status === "completed" && (
                  <button
                    type="button"
                    className={button}
                    disabled={browser.displayBusy}
                    onClick={() =>
                      browser.display({ action: "download", download_id: download.id })
                    }
                  >
                    Save to workspace
                  </button>
                )}
              </div>
            ))}
          </details>
          <div
            role="status"
            className={`shrink-0 px-3 text-xs ${state?.error ? "text-error" : "text-muted-foreground"}`}
          >
            {state?.error ?? (state?.loading ? "Loading…" : "")}
          </div>
          <div
            ref={browser.attachSurface}
            data-testid="desktop-preview-browser-surface"
            className="flex min-h-0 flex-1 items-center justify-center text-sm text-on-surface-variant"
          >
            {state ? null : "Open a chat link or enter a URL"}
          </div>
        </>
      )}
    </div>
  );
}

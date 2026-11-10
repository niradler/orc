// The ORC look-and-feel kit for HTML scratchpads (issue #157): dashboard theme tokens plus a
// small set of component classes, injected into every HTML pad's iframe (preview and chat
// artifact) the same way the bridge script is injected. A pad uses the kit by writing markup
// with `orc-*` classes and no custom <style>; the kit follows the dashboard's current theme and
// each pad pins the kit version it was written for, so old pads do not shift when the kit
// changes. The token blocks must stay byte-identical with the dashboard's `:root` /
// `:root.dark` rules in `packages/web/src/index.css` — `tests/unit/orc-kit.test.ts` enforces it.
// Copy the blocks from index.css when a token changes and bump ORC_KIT_VERSION (keeping the
// previous CSS bundled as a retired version entry).

import type { Theme } from "./theme";

export const ORC_KIT_META_NAME = "orc-kit";
export const ORC_KIT_VERSION = 1;

const ORC_KIT_1_CSS = `
:root {
  --background: 250 250 250;
  --surface: 255 255 255;
  --surface-low: 250 250 250;
  --surface-high: 243 243 245;
  --surface-highest: 233 234 237;
  --surface-bright: 222 224 228;
  --foreground: 37 38 42;
  --muted-foreground: 98 102 110;
  --border: 222 224 228;
  --primary: 37 38 42;
  --primary-foreground: 255 255 255;
  --success: 70 102 83;
  --warning: 121 95 48;
  --error: 155 69 77;
  --progress: 49 87 151;
  --focus: 80 101 133;
  --control-border: 133 137 145;
  --error-container: 250 224 228;
  color-scheme: light;
}
:root.dark {
  --background: 0 0 0;
  --surface: 20 20 20;
  --surface-low: 0 0 0;
  --surface-high: 28 28 28;
  --surface-highest: 36 36 36;
  --surface-bright: 82 82 82;
  --foreground: 229 229 229;
  --muted-foreground: 163 163 163;
  --border: 38 38 38;
  --primary: 222 222 222;
  --primary-foreground: 0 0 0;
  --success: 133 193 157;
  --warning: 214 182 117;
  --error: 226 145 154;
  --error-container: 49 20 25;
  --progress: 138 180 248;
  --focus: 196 196 196;
  --control-border: 113 113 113;
  color-scheme: dark;
}
* {
  box-sizing: border-box;
  border-color: rgb(var(--border));
}
body {
  margin: 0;
  padding: 16px;
  background: rgb(var(--background));
  color: rgb(var(--foreground));
  font: 14px/1.5 "IBM Plex Sans", "Segoe UI", system-ui, sans-serif;
}
h1 { margin: 0; font-size: 22px; font-weight: 500; }
h2 { margin: 0; font-size: 16px; font-weight: 500; }
h3 { margin: 0; font-size: 14px; font-weight: 500; }
p { margin: 0; }
a { color: rgb(var(--progress)); text-decoration-thickness: 1px; text-underline-offset: 2px; }
code, pre, kbd {
  font-family: "IBM Plex Mono", Consolas, monospace;
  font-size: 13px;
}
pre { margin: 0; background: rgb(var(--surface-high)); border-radius: 6px; padding: 10px 12px; overflow-x: auto; }
hr { border: 0; border-top: 1px solid rgb(var(--border)); margin: 4px 0; }
.orc-page { max-width: 980px; margin: 0 auto; display: grid; gap: 14px; align-content: start; }
.orc-grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
.orc-card {
  background: rgb(var(--surface));
  border: 1px solid rgb(var(--border));
  border-radius: 8px;
  padding: 12px 14px;
  display: grid;
  gap: 8px;
  align-content: start;
}
.orc-stat { display: grid; gap: 2px; }
.orc-stat-label { font-size: 12px; color: rgb(var(--muted-foreground)); }
.orc-stat-value { font-size: 22px; font-weight: 500; line-height: 1.2; }
.orc-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  width: fit-content;
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 4px;
  border: 1px solid rgb(var(--control-border));
  color: rgb(var(--muted-foreground));
}
.orc-badge-success { color: rgb(var(--success)); border-color: rgb(var(--success)); }
.orc-badge-warning { color: rgb(var(--warning)); border-color: rgb(var(--warning)); }
.orc-badge-error { color: rgb(var(--error)); border-color: rgb(var(--error)); }
.orc-table-wrap { overflow-x: auto; }
.orc-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.orc-table th {
  text-align: left;
  font-weight: 500;
  font-size: 12px;
  color: rgb(var(--muted-foreground));
  padding: 6px 10px;
  border-bottom: 1px solid rgb(var(--border));
}
.orc-table td { padding: 6px 10px; border-bottom: 1px solid rgb(var(--border)); }
.orc-table tr:last-child td { border-bottom: 0; }
.orc-tabs { display: grid; gap: 0; }
.orc-tab-list { display: flex; gap: 2px; border-bottom: 1px solid rgb(var(--border)); }
.orc-tab {
  appearance: none;
  background: none;
  border: 0;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  padding: 6px 10px;
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  color: rgb(var(--muted-foreground));
  cursor: pointer;
}
.orc-tab[aria-selected="true"] {
  color: rgb(var(--foreground));
  border-bottom-color: rgb(var(--primary));
}
.orc-tab-panel { padding: 10px 0; display: grid; gap: 10px; }
.orc-tab-panel[hidden] { display: none; }
.orc-chart {
  --chart-line: rgb(var(--progress));
  --chart-grid: rgb(var(--border));
  --chart-text: rgb(var(--muted-foreground));
  display: grid;
  gap: 6px;
  align-content: start;
}
.orc-chart svg { max-width: 100%; height: auto; }
.orc-chart text { fill: var(--chart-text); font-size: 11px; }
.orc-chart-label { font-size: 12px; color: rgb(var(--muted-foreground)); }
.orc-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid rgb(var(--primary));
  background: rgb(var(--primary));
  color: rgb(var(--primary-foreground));
  border-radius: 6px;
  padding: 6px 12px;
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
}
.orc-button[data-variant="quiet"] {
  background: none;
  color: rgb(var(--foreground));
  border-color: transparent;
}
.orc-button:disabled { opacity: 0.5; cursor: not-allowed; }
input, select, textarea {
  border: 1px solid rgb(var(--control-border));
  border-radius: 6px;
  padding: 6px 10px;
  background: transparent;
  color: rgb(var(--foreground));
  font: inherit;
  font-size: 16px;
}
input[type="checkbox"] { accent-color: rgb(var(--primary)); width: 16px; height: 16px; padding: 0; }
input:focus-visible, select:focus-visible, textarea:focus-visible, .orc-tab:focus-visible, .orc-button:focus-visible {
  outline: 2px solid rgb(var(--focus));
  outline-offset: 2px;
}
@media (min-width: 640px) and (pointer: fine) {
  input, select, textarea { font-size: 13px; padding-block: 5px; }
}
@media (max-width: 639px), (pointer: coarse) {
  .orc-tab, .orc-button, input:not([type="checkbox"]), select, label { min-height: 44px; }
}
label { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.orc-list { margin: 0; padding-left: 18px; display: grid; gap: 4px; font-size: 13px; }
.orc-muted { color: rgb(var(--muted-foreground)); }
.orc-hint { font-size: 12px; color: rgb(var(--muted-foreground)); }
.orc-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
`;

/** Each bundled kit version. A retired version keeps its exact CSS so pinned pads never shift. */
export const ORC_KIT_STYLESHEETS: Readonly<Record<number, string>> = {
  1: ORC_KIT_1_CSS,
};

/** Selects tabs by pointer or keyboard; initialization waits for the head-injected markup. */
const ORC_KIT_JS = `(() => {
  const buttonsFor = (tabs) => Array.from(tabs.querySelectorAll("[data-orc-tab]"))
    .filter((button) => button.closest(".orc-tabs") === tabs);
  const select = (tab) => {
    const tabs = tab.closest(".orc-tabs");
    if (!tabs || tab.disabled) return;
    for (const button of buttonsFor(tabs)) {
      const selected = button === tab;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
      const panel = document.getElementById(button.dataset.orcPanel ?? "");
      if (panel && panel.closest(".orc-tabs") === tabs) panel.hidden = !selected;
    }
  };
  const eventTab = (event) => event.target instanceof Element
    ? event.target.closest("[data-orc-tab]") : null;
  document.addEventListener("click", (event) => {
    const tab = eventTab(event);
    if (tab) select(tab);
  });
  document.addEventListener("keydown", (event) => {
    const tab = eventTab(event);
    if (!tab || tab.disabled) return;
    const tabs = tab.closest(".orc-tabs");
    if (!tabs) return;
    const buttons = buttonsFor(tabs).filter((button) => !button.disabled);
    const index = buttons.indexOf(tab);
    const vertical = tab.closest('[role="tablist"]')?.getAttribute("aria-orientation") === "vertical";
    let next;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = buttons.length - 1;
    else if (event.key === (vertical ? "ArrowUp" : "ArrowLeft")) next = (index - 1 + buttons.length) % buttons.length;
    else if (event.key === (vertical ? "ArrowDown" : "ArrowRight")) next = (index + 1) % buttons.length;
    else return;
    event.preventDefault();
    select(buttons[next]);
    buttons[next].focus();
  });
  const initialize = () => {
    for (const tabs of document.querySelectorAll(".orc-tabs")) {
      const buttons = buttonsFor(tabs).filter((button) => !button.disabled);
      const selected = buttons.find((button) => button.getAttribute("aria-selected") === "true") ?? buttons[0];
      if (selected) select(selected);
    }
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
  else initialize();
})();`;

/** The version a pad asks for with `<meta name="orc-kit" content="N">`; latest when absent or unknown. */
export function requestedKitVersion(html: string): { version: number; pinned: boolean } {
  const meta = new RegExp(
    `<meta\\b(?=[^>]*\\bname=["']${ORC_KIT_META_NAME}["'])(?=[^>]*\\bcontent=["'](\\d+)["'])[^>]*>`,
    "i",
  ).exec(html);
  const version = meta ? Number(meta[1]) : ORC_KIT_VERSION;
  return meta && version in ORC_KIT_STYLESHEETS
    ? { version, pinned: true }
    : { version: ORC_KIT_VERSION, pinned: false };
}

/**
 * Stylesheets, tab script and (for dark mode) the `.dark` class hook, inserted after any doctype
 * so the page keeps standards mode and the class is set before the body paints.
 */
export function withOrcKit(html: string, theme: Theme): string {
  const { version } = requestedKitVersion(html);
  const tags =
    `<style id="orc-kit" data-orc-kit-version="${version}">${ORC_KIT_STYLESHEETS[version]}</style>` +
    `<script id="orc-kit-js">${theme === "dark" ? 'document.documentElement.classList.add("dark");' : ""}${ORC_KIT_JS}</script>`;
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  return doctype ? `${doctype[0]}${tags}${html.slice(doctype[0].length)}` : `${tags}${html}`;
}

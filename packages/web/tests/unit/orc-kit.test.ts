import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  ORC_KIT_STYLESHEETS,
  ORC_KIT_VERSION,
  requestedKitVersion,
  withOrcKit,
} from "../../src/lib/orc-kit";

/** The JS the kit injects, taken out of a rendered document so syntax errors surface here. */
function injectedScript(html: string, theme: "dark" | "light"): string {
  return withOrcKit(html, theme).match(/<script id="orc-kit-js">([\s\S]*?)<\/script>/)?.[1] ?? "";
}

const indexCss = readFileSync(new URL("../../src/index.css", import.meta.url), "utf8");

/** Custom property declarations of a `selector { ... }` block, by name. */
function tokens(css: string, selector: string): Map<string, string> {
  const block = new RegExp(`${selector}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
  const map = new Map<string, string>();
  for (const [, name, value] of block.matchAll(/([-\w]+)\s*:\s*([^;]+);/g)) {
    map.set(name, value.trim());
  }
  return map;
}

function sameTokens(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [name, value] of a) if (b.get(name) !== value) return false;
  return true;
}

describe("kit tokens track the dashboard", () => {
  const kit = ORC_KIT_STYLESHEETS[ORC_KIT_VERSION];

  test("should bundle the current version and keep light and dark blocks in sync with index.css", () => {
    expect(ORC_KIT_STYLESHEETS[ORC_KIT_VERSION]).toBe(kit);
    expect(sameTokens(tokens(indexCss, ":root"), tokens(kit, ":root"))).toBe(true);
    expect(sameTokens(tokens(indexCss, ":root\\.dark"), tokens(kit, ":root\\.dark"))).toBe(true);
    expect(tokens(kit, ":root").get("color-scheme")).toBe("light");
    expect(tokens(kit, ":root\\.dark").get("color-scheme")).toBe("dark");
  });

  test("should define the components the issue lists", () => {
    for (const cls of [
      ".orc-page",
      ".orc-card",
      ".orc-table",
      ".orc-stat",
      ".orc-badge",
      ".orc-tabs",
      ".orc-chart",
    ]) {
      expect(kit).toContain(cls);
    }
  });
});

describe("kit version pinning", () => {
  test("should use the current version when the pad pins nothing", () => {
    expect(requestedKitVersion("<!doctype html><title>x</title>")).toEqual({
      version: ORC_KIT_VERSION,
      pinned: false,
    });
  });

  test("should honor a pinned version in either attribute order", () => {
    const pad = `<meta name="orc-kit" content="${ORC_KIT_VERSION}">`;
    const swapped = `<meta content="${ORC_KIT_VERSION}" name="orc-kit">`;
    expect(requestedKitVersion(pad)).toEqual({ version: ORC_KIT_VERSION, pinned: true });
    expect(requestedKitVersion(swapped)).toEqual({ version: ORC_KIT_VERSION, pinned: true });
  });

  test("should fall back to the current version for a pad that pins an unbundled one", () => {
    expect(requestedKitVersion(`<meta name="orc-kit" content="99">`)).toEqual({
      version: ORC_KIT_VERSION,
      pinned: false,
    });
  });

  test("should stamp the injected stylesheet with the version it carries", () => {
    const doc = withOrcKit(`<meta name="orc-kit" content="1"><p>x</p>`, "light");
    expect(doc).toContain(`data-orc-kit-version="1"`);
  });
});

describe("withOrcKit injection", () => {
  const page = `<!doctype html><html><head><title>T</title></head><body><h1>Hi</h1></body></html>`;

  test("should insert after the doctype so the page keeps standards mode", () => {
    const doc = withOrcKit(page, "light");
    expect(doc.startsWith("<!doctype html>")).toBe(true);
    expect(doc.indexOf('<style id="orc-kit"')).toBeLessThan(doc.indexOf("<html>"));
    expect(doc).toContain("<h1>Hi</h1>");
  });

  test("should inject into a fragment with no doctype", () => {
    const doc = withOrcKit("<p>hello</p>", "light");
    expect(doc.startsWith('<style id="orc-kit"')).toBe(true);
    expect(doc).toContain("<p>hello</p>");
  });

  test("should follow the dashboard theme through the dark class hook", () => {
    expect(withOrcKit(page, "dark")).toContain('document.documentElement.classList.add("dark")');
    expect(withOrcKit(page, "light")).not.toContain('classList.add("dark")');
  });

  test("should inject JavaScript that actually parses (quote escaping broke in a browser once)", () => {
    const script = injectedScript(page, "dark");
    expect(script.startsWith('document.documentElement.classList.add("dark");')).toBe(true);
    expect(() => new Function(script)).not.toThrow();
  });

  test("should carry the tabs script once, and stay bridge-compatible", () => {
    const doc = withOrcKit(page, "dark");
    expect(doc.match(/id="orc-kit-js"/g)).toHaveLength(1);
    expect(doc).toContain("data-orc-tab");
    // ScratchpadHtmlEditor puts the bridge after any doctype; the kit must leave it first.
    expect(/^\s*<!doctype[^>]*>/i.test(doc)).toBe(true);
  });
});

describe("kit pads are meaningfully smaller (issue #157 measurement)", () => {
  // A page an agent would write by hand for the same outcome, then the same page with kit classes.
  const withoutKit = `<!doctype html>
<html><head><title>Release status</title><style>
:root { --bg: #fafafa; --fg: #25262a; --line: #dee0e4; }
@media (prefers-color-scheme: dark) { :root { --bg: #000; --fg: #e5e5e5; --line: #262626; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 16px; background: var(--bg); color: var(--fg);
  font: 14px/1.5 system-ui, sans-serif; }
.page { max-width: 960px; margin: 0 auto; display: grid; gap: 14px; }
.grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
.card { background: #fff; border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; }
.stat-label { font-size: 12px; opacity: 0.7; }
.stat-value { font-size: 22px; font-weight: 500; }
.badge { display: inline-flex; font-size: 12px; padding: 2px 8px; border: 1px solid; border-radius: 4px; }
.ok { color: #466653; } .warn { color: #795f30; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th { text-align: left; font-size: 12px; opacity: 0.7; padding: 6px 10px; border-bottom: 1px solid var(--line); }
td { padding: 6px 10px; border-bottom: 1px solid var(--line); }
</style></head><body><div class="page">
<h1>Release status</h1>
<div class="grid">
  <div class="card"><div class="stat-label">Open tasks</div><div class="stat-value">12</div></div>
  <div class="card"><div class="stat-label">In review</div><div class="stat-value">3</div></div>
  <div class="card"><div class="stat-label">Blocked</div><div class="stat-value">1</div></div>
</div>
<div class="card"><span class="badge ok">healthy</span>
<table><thead><tr><th>Task</th><th>Status</th></tr></thead>
<tbody><tr><td>ship 0.9</td><td>doing</td></tr><tr><td>kit docs</td><td>review</td></tr></tbody></table>
</div></div></body></html>`;

  const withKit = `<!doctype html>
<html><head><meta name="orc-kit" content="1"><title>Release status</title></head><body>
<div class="orc-page">
<h1>Release status</h1>
<div class="orc-grid">
  <div class="orc-card"><div class="orc-stat"><span class="orc-stat-label">Open tasks</span><span class="orc-stat-value">12</span></div></div>
  <div class="orc-card"><div class="orc-stat"><span class="orc-stat-label">In review</span><span class="orc-stat-value">3</span></div></div>
  <div class="orc-card"><div class="orc-stat"><span class="orc-stat-label">Blocked</span><span class="orc-stat-value">1</span></div></div>
</div>
<div class="orc-card"><span class="orc-badge orc-badge-success">healthy</span>
<div class="orc-table-wrap"><table class="orc-table"><thead><tr><th>Task</th><th>Status</th></tr></thead>
<tbody><tr><td>ship 0.9</td><td>doing</td></tr><tr><td>kit docs</td><td>review</td></tr></tbody></table></div>
</div></div></body></html>`;

  test("should let the same page drop its whole style block", () => {
    expect(withoutKit).toContain("<style>");
    expect(withKit).not.toContain("<style");
    // Measured: 926 bytes of pad with the kit vs 1755 without, on this same page.
    expect(withKit.length * 5).toBeLessThan(withoutKit.length * 3);
  });
});

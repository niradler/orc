# HTML kit

ORC injects a look-and-feel kit into every `html` scratchpad render — in the editor
preview and in chat artifacts. It carries the dashboard's theme tokens and a small set
of component classes, so a page written with kit classes reads as a native ORC view
and follows the dashboard's light/dark theme without any work from you. **Write markup,
not CSS: a kit pad has no custom `<style>` block.** Custom CSS/JS still works if the
page needs something the kit does not cover; keep it small.

The kit is injected at render time into the iframe document. It never changes the saved
pad, needs no network fetch, and costs the page zero bytes.

## Pin the version

Every kit pad starts with a pin so old pads keep their look when the kit evolves:

```html
<meta name="orc-kit" content="1">
```

The dashboard bundles every retired version and renders a pad with exactly the version
it pins. A pad with no pin (or an unbundled version) renders with the current kit.
Bump the `content` only when you intentionally re-style an old pad.

## Classes

| Area | What to use |
| --- | --- |
| Page | `.orc-page` (centered column), `.orc-grid` (responsive card row), `.orc-row`, `hr` |
| Text | `h1` 22px, `h2` 16px, `h3` 14px, `.orc-muted`, `.orc-hint`, `.orc-list`, `pre`/`code` |
| Card | `.orc-card` — one contained region; do not card every group |
| Numbers | `.orc-stat` with `.orc-stat-label` + `.orc-stat-value` (put them in a card or the grid) |
| Status | `.orc-badge` with `orc-badge-success` / `orc-badge-warning` / `orc-badge-error`; keep surfaces neutral, color the badge only |
| Table | `.orc-table-wrap` > `table.orc-table` (th/td styled) |
| Tabs | `.orc-tabs` — see skeleton; the kit initializes after parsing, shows only the selected panel, and supports click, Left/Right (wrapping), Home/End; Tab leaves the tab strip |
| Chart | `.orc-chart` wrapper: inline SVG gets themed text/grid from `--chart-text`, `--chart-grid`, `--chart-line` |
| Controls | `.orc-button` (`data-variant="quiet"` for ghost), bare `input`/`select`/`textarea` are themed, checkboxes/`label` pairs work |

## Skeleton

```html
<!doctype html>
<html>
<head>
  <meta name="orc-kit" content="1">
  <title>Release status</title>
</head>
<body>
  <div class="orc-page">
    <h1>Release status</h1>
    <div class="orc-grid">
      <div class="orc-card orc-stat">
        <span class="orc-stat-label">Open tasks</span>
        <span class="orc-stat-value">12</span>
      </div>
    </div>
    <div class="orc-card">
      <div class="orc-tabs">
        <div class="orc-tab-list" role="tablist" aria-label="Release timeline">
          <button class="orc-tab" id="tab-now" role="tab" data-orc-tab data-orc-panel="p1" aria-controls="p1" aria-selected="true">Now</button>
          <button class="orc-tab" id="tab-next" role="tab" data-orc-tab data-orc-panel="p2" aria-controls="p2" aria-selected="false">Next</button>
        </div>
        <div class="orc-tab-panel" id="p1" role="tabpanel" aria-labelledby="tab-now" tabindex="0">…</div>
        <div class="orc-tab-panel" id="p2" role="tabpanel" aria-labelledby="tab-next" tabindex="0" hidden>…</div>
      </div>
    </div>
    <div class="orc-card orc-chart">
      <svg viewBox="0 0 300 80" role="img" aria-label="trend">
        <polyline points="0,70 60,40 120,55 180,20 240,35 300,10"
                  fill="none" stroke="var(--chart-line)" stroke-width="2" />
      </svg>
      <span class="orc-chart-label">runs/day, last 6</span>
    </div>
  </div>
</body>
</html>
```

Use unique tab and panel IDs for each group. Set one tab's `aria-selected` to
`true`; if omitted, the kit selects the first enabled tab. For a vertical tab
list, set `aria-orientation="vertical"` and use Up/Down. Changing the dashboard
theme rebuilds the iframe, so tab selection and other running page state reset;
the saved HTML and version pin stay unchanged.

## Charts and libraries

Embed the data in the page (see [scratchpads](scratchpads.md)) and draw inline SVG or
CSS bars inside `.orc-chart` — that is the cheapest themed chart and works everywhere.
A CDN library (Chart.js, ECharts) loads only in the editor preview: the chat artifact
frame runs a CSP that blocks network requests. When you must support both views, inline
the library code or prefer SVG. A hand-written themed CSS page and the same page with
the kit measured 1755 vs 926 bytes of pad content on the docs example (the kit's own
CSS rides along for free).

## For ORC maintainers

The kit lives in `packages/web/src/lib/orc-kit.ts`; token blocks must stay identical to
the dashboard's `:root` / `:root.dark` in `packages/web/src/index.css` (a unit test
enforces it). To change the kit: add the new version to `ORC_KIT_STYLESHEETS`, set
`ORC_KIT_VERSION`, keep retired CSS in the map, and update this reference.

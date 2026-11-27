# HTML kit

ORC injects a look-and-feel kit into every `html` scratchpad render — in the editor
preview and in chat artifacts. It carries the dashboard's theme tokens and a small set
of component classes, so a page written with kit classes reads as a native ORC view
and follows the dashboard's light/dark theme without any work from you. **Write markup,
not CSS: a kit pad has no custom `<style>` block.** Custom CSS/JS still works if the
page needs something the kit does not cover; keep it small.

Prefer the [component tags](#component-tags) for concise pages: `<orc-card>`,
`<orc-stat label="Open tasks" value="12">`, `<orc-badge>`, `<orc-tabs>` and
`<orc-chart>` generate the reusable markup and behavior. The classes below are also
available for custom layouts.

The kit is injected at render time into the iframe document. It never changes the saved
pad, needs no network fetch, and costs the page zero bytes.

## Pin the version

Every kit pad starts with a pin so old pads keep their look when the kit evolves:

```html
<meta name="orc-kit" content="3">
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
| Chart | `<orc-chart kind="bar\|line\|area\|sparkline" data='[…]'>` — themed axes, labels and hover values; `.orc-chart` is the wrapper class for hand-drawn SVG |
| Controls | `.orc-button` (`data-variant="quiet"` for ghost), bare `input`/`select`/`textarea` are themed, checkboxes/`label` pairs work |

## Skeleton

```html
<!doctype html>
<html>
<head>
  <meta name="orc-kit" content="3">
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
    <div class="orc-card">
      <orc-chart kind="line" label="runs/day, last 6" data="[3,5,4,7,6,9]"></orc-chart>
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

## Component tags

For shorter markup, use the kit's built-in Web Components. They reuse the same
styles and tab behavior without a framework, network request or custom script.
Existing `orc-*` classes remain supported. Elements use the document's normal DOM
so your CSS and scripts can inspect them.

```html
<!doctype html>
<html><head><meta name="orc-kit" content="3"><title>Release status</title></head>
<body>
  <orc-page>
    <h1>Release status</h1>
    <orc-grid>
      <orc-card><orc-stat label="Open tasks" value="12"></orc-stat></orc-card>
    </orc-grid>
    <orc-card>
      <orc-badge tone="success">Healthy</orc-badge>
      <orc-tabs label="Release timeline">
        <orc-tab label="Now">Current release</orc-tab>
        <orc-tab label="Next">Next release</orc-tab>
      </orc-tabs>
    </orc-card>
    <orc-table>
      <table><thead><tr><th>Task</th><th>Status</th></tr></thead>
      <tbody><tr><td>Ship kit</td><td>Ready</td></tr></tbody></table>
    </orc-table>
    <orc-card>
      <orc-chart kind="bar" label="Runs per day" unit="runs"
        data='[{"label":"Mon","value":12},{"label":"Tue","value":18},{"label":"Wed","value":9}]'></orc-chart>
    </orc-card>
  </orc-page>
</body></html>
```

`orc-page`, `orc-grid`, `orc-row` and `orc-card` wrap ordinary content; `orc-chart`
draws from its attributes (see [Charts](#charts-and-libraries)). `orc-stat` renders
its `label` and `value` attributes as text and updates when they change. `orc-badge`
accepts `tone="success"`, `warning` or `error`; omitting it uses neutral styling. Keep
a standard `<table>` inside `orc-table` so browsers preserve table markup correctly.

`orc-tabs` generates labeled buttons and panel relationships from its direct
`orc-tab` children. Add `selected` to select an initial panel, `disabled` to skip
a tab, or `orientation="vertical"` on the group for Up/Down navigation. Define
the tab structure before inserting the group; changing its child tabs after
initialization is not supported. All tabs disabled leaves all panels hidden.
The theme and sandbox rules above apply equally to these components.

## Charts and libraries

Use `<orc-chart>` for the common cases instead of hand-rolling axes and tooltips:

```html
<orc-chart kind="bar" label="Runs per day" unit="runs"
  data='[{"label":"Mon","value":12},{"label":"Tue","value":18}]'></orc-chart>
```

`data` is a JSON array of numbers or `{label, value}` objects; bare numbers are labeled
by position. `kind` is `bar`, `line` (default), `area` or `sparkline`; a sparkline drops
axes and labels. Optional `height`, `min` and `max` control the shape. The component
draws inline SVG with the theme's `--chart-line`, `--chart-grid` and `--chart-text`
tokens, so it renders identically in the editor preview and the chat artifact with no
network request and no CSP change. Hover a bar or point for its value. Charts require
kit version 3.

For anything the component does not cover, draw inline SVG or CSS bars inside
`.orc-chart`. A CDN library (Chart.js, ECharts) loads only in the editor preview: the
chat artifact frame runs a CSP that blocks network requests. When you must support both
views, inline the library code or prefer SVG. A hand-written themed CSS page and the
same page with the kit measured 1755 vs 926 bytes of pad content on the docs example
(the kit's own CSS rides along for free).

## For ORC maintainers

The kit lives in `packages/web/src/lib/orc-kit.ts`; token blocks must stay identical to
the dashboard's `:root` / `:root.dark` in `packages/web/src/index.css` (a unit test
enforces it). To change the kit: add the new version to `ORC_KIT_STYLESHEETS`, set
`ORC_KIT_VERSION`, keep retired CSS in the map, and update this reference.

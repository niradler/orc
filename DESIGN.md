---
version: alpha
name: ORC Quiet Workspace
description: ORC visual contract; black workspace approved through Activity, remaining pages adopt these rules.
colors:
  primary: "#DEDEDE"
  on-primary: "#000000"
  canvas: "#000000"
  surface: "#141414"
  elevated: "#1C1C1C"
  selected: "#242424"
  text: "#E5E5E5"
  muted: "#A3A3A3"
  border: "#262626"
  focus: "#C4C4C4"
  control-border: "#717171"
  progress: "#8AB4F8"
  success: "#85C19D"
  warning: "#D6B675"
  error: "#E2919A"
  light-primary: "#25262A"
  light-on-primary: "#FFFFFF"
  light-canvas: "#FAFAFA"
  light-surface: "#FFFFFF"
  light-elevated: "#F3F3F5"
  light-selected: "#E9EAED"
  light-text: "#25262A"
  light-muted: "#62666E"
  light-border: "#DEE0E4"
  light-focus: "#506585"
  light-control-border: "#858991"
  light-progress: "#315797"
  light-success: "#466653"
  light-warning: "#795F30"
  light-error: "#9B454D"
typography:
  page-title:
    fontFamily: IBM Plex Sans
    fontSize: 22px
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: -0.02em
  section-title:
    fontFamily: IBM Plex Sans
    fontSize: 16px
    fontWeight: 500
    lineHeight: 1.4
  body:
    fontFamily: IBM Plex Sans
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
  reading:
    fontFamily: IBM Plex Sans
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.65
  label:
    fontFamily: IBM Plex Sans
    fontSize: 13px
    fontWeight: 500
    lineHeight: 1.4
  caption:
    fontFamily: IBM Plex Sans
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
  code:
    fontFamily: IBM Plex Mono
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.6
  mobile-input:
    fontFamily: IBM Plex Sans
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
rounded:
  small: 4px
  control: 6px
  panel: 8px
  dialog: 12px
spacing:
  micro: 4px
  related: 8px
  control: 12px
  group: 16px
  section: 24px
  page: 32px
  touch-target: 44px
components:
  workspace:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
  surface:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
  overlay:
    backgroundColor: "{colors.elevated}"
    textColor: "{colors.text}"
    rounded: "{rounded.dialog}"
  navigation-selected:
    backgroundColor: "{colors.selected}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
  metadata:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.muted}"
    typography: "{typography.caption}"
  divider:
    backgroundColor: "{colors.border}"
    height: 1px
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "{spacing.control}"
  field-boundary:
    backgroundColor: "{colors.control-border}"
    height: 1px
  status-progress:
    textColor: "{colors.progress}"
    backgroundColor: "{colors.canvas}"
  focus-indicator:
    backgroundColor: "{colors.focus}"
    height: 2px
  status-success:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.success}"
  status-warning:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.warning}"
  status-error:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.error}"
  workspace-light:
    backgroundColor: "{colors.light-canvas}"
    textColor: "{colors.light-text}"
    typography: "{typography.body}"
  surface-light:
    backgroundColor: "{colors.light-surface}"
    textColor: "{colors.light-text}"
  overlay-light:
    backgroundColor: "{colors.light-elevated}"
    textColor: "{colors.light-text}"
    rounded: "{rounded.dialog}"
  navigation-selected-light:
    backgroundColor: "{colors.light-selected}"
    textColor: "{colors.light-text}"
    rounded: "{rounded.control}"
  metadata-light:
    backgroundColor: "{colors.light-canvas}"
    textColor: "{colors.light-muted}"
    typography: "{typography.caption}"
  divider-light:
    backgroundColor: "{colors.light-border}"
    height: 1px
  button-primary-light:
    backgroundColor: "{colors.light-primary}"
    textColor: "{colors.light-on-primary}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "{spacing.control}"
  field-boundary-light:
    backgroundColor: "{colors.light-control-border}"
    height: 1px
  status-progress-light:
    textColor: "{colors.light-progress}"
    backgroundColor: "{colors.light-canvas}"
  focus-indicator-light:
    backgroundColor: "{colors.light-focus}"
    height: 2px
  status-success-light:
    backgroundColor: "{colors.light-surface}"
    textColor: "{colors.light-success}"
  status-warning-light:
    backgroundColor: "{colors.light-surface}"
    textColor: "{colors.light-warning}"
  status-error-light:
    backgroundColor: "{colors.light-surface}"
    textColor: "{colors.light-error}"
---

# ORC design guide

## Overview

**Status: Activity direction approved for application-wide adoption, 2026-10-15.**
This is the implementation contract for the visual refinement. Activity is the
reference; all other screens adopt its shared palette and section rules with
behavior preserved. Font replacement, commits and publishing remain separate.

ORC is a daily coding-agent workspace: read work, make decisions, inspect output
and continue a conversation. The interface should feel calm, precise and usable
for long sessions. Content and current work carry the emphasis. Chrome should
help orientation without competing with the document, conversation or terminal.

The references are Codex, ChatGPT and Claude for calm working surfaces, and the
user-supplied Linear style document for systematic rules and restraint. Borrow
principles, not brand colors, copied components or marketing-page proportions.
ORC needs its own coherent workspace, not a collage of those products.

This file follows the [DESIGN.md format](https://github.com/google-labs-code/design.md/blob/main/docs/spec.md):
front matter defines target tokens; prose explains their use. The `light-` prefix
denotes alternate theme values, not additional colors to mix into dark mode.

### Implementation and adoption

- Runtime colors live in `packages/web/src/index.css`; semantic aliases
  and fonts live in `packages/web/tailwind.config.ts`.
- Former blue-tinted surfaces, bright selection fills and prominent status cards
  are implementation history. The approved black Activity baseline is now shared.
- Retain Tailwind and shadcn/ui. Adjust shared tokens and component variants
  together rather than introducing a parallel styling system.
- Keep IBM Plex Sans / IBM Plex Mono for the first comparison. These are already
  in the app; font replacement is a separate visual decision, not a prerequisite
  for calming the theme.
- Keep the agreed feature names, routes, project scope and capabilities. A theme
  refinement does not authorize navigation redesign or data migration.

## Colors

Use a pure black canvas with neutral charcoal interaction surfaces in dark mode and clean off-white in light mode.
Dark chrome uses equal RGB channels. Sidebar, header and main canvas share the
same #000000 background: one continuous workspace, not contrasting panels. Avoid
even a subtle blue cast. This reflects Nir’s preference after
the Activity comparison. No typography or sizing change is requested. Dark is the
initial default; an explicit choice persists. Avoid blue casts across the entire
canvas, sidebar, cards and text. Dark mode should remain comfortable, rather than
using maximum black/white contrast everywhere.

| Role | Dark | Light | Application |
| --- | --- | --- | --- |
| Canvas | `#000000` | `#FAFAFA` | Main workspace and large uninterrupted areas |
| Surface | `#141414` | `#FFFFFF` | A necessary contained region, not every group |
| Elevated | `#1C1C1C` | `#F3F3F5` | Popover, dialog, transient overlay |
| Selected | `#242424` | `#E9EAED` | Local selection and restrained active navigation |
| Text | `#E5E5E5` | `#25262A` | Main content and active controls |
| Muted | `#A3A3A3` | `#62666E` | Secondary information that must remain readable |
| Border | `#262626` | `#DEE0E4` | Quiet separators and nonessential structural edges |
| Primary action | `#DEDEDE` | `#25262A` | One locally dominant action, with opposite text |
| Focus | `#C4C4C4` | `#506585` | Keyboard focus |
| Control boundary | `#717171` | `#858991` | Input/select/textarea and outline control boundaries |
| Progress | `#8AB4F8` | `#315797` | Doing/queued status dot, never a page fill |

Primary action is deliberately neutral. A colored brand CTA is not required to
make a control discoverable. Other actions generally use text or a ghost variant.
Selection is conveyed through neutral fill, text and state semantics; it does not
need a bright stripe, tinted card and colored icon at the same time.

Success, warning and error colors communicate actual state. Use a small icon,
dot or short label, paired with text. Keep surrounding surfaces neutral. Do not
color entire KPI cards, whole table rows or long paragraphs by status. Reserve
red for actual errors/destructive actions, not decoration.

Normal text needs at least 4.5:1 contrast; large text and meaningful UI graphics
need at least 3:1 where applicable. The quiet border token is decorative: when a
boundary is the only way to identify a control, strengthen that boundary to meet
the relevant non-text contrast requirement. Never dim essential session text or
use placeholder color for saved content. Validate actual rendered combinations,
including hover, selection, links, disabled states and editor syntax colors.

## Typography

Use one UI family and one code family. Prefer regular 400 and medium 500; reserve
600 for rare emphasis. Weight, size, placement and spacing establish hierarchy.
Repeated semibold labels and large headings make a tool feel unnecessarily loud.

- Page titles: 22px / 500. Section headings: 16px / 500.
- UI content: 14px / 400. Controls and navigation: 13px / 500.
- Supporting metadata: 12px / 400, used sparingly and with readable contrast.
- Wiki and conversation reading: 16px with generous 1.65 line height and a
  comfortable measure around 65–78 characters.
- Code/editor defaults: 13px IBM Plex Mono; allow users to enlarge text. Use mono
  for code, commands and identifiers, not general navigation or explanatory copy.
- Mobile form fields: at least 16px. Do not shrink a desktop UI to fit a phone.

Use sentence case. Avoid tracked uppercase labels, decorative overlines and
marketing-sized display type. Preserve a logical heading hierarchy and a clear
page heading. Give long titles room to wrap; only truncate when the full name is
also available accessibly.

## Layout

Start with a 4px spacing unit. Use 8px within related controls, 12–16px within a
working group, 24px between sections, and 16px mobile / 24–32px desktop page insets.
Spacing should explain relationships. Do not wrap each relationship in a card.

The shell is project-centered: a compact sidebar, project dropdown and one
contextual navigation row. Keep Activity first and the default at `/activity`.
Knowledge has exactly Wiki, Knowledge base and Memories as sibling destinations.
Collection management and Wiki History are contextual actions. Chat opens from
the header; it is not another sidebar destination. The separate Agents/Packages
relationship remains an open UX decision; this document does not silently resolve it.

Keep flexible space for tasks, boards and terminals; do not impose a marketing
page max-width on workspaces. Constrain reading text inside those workspaces.
Avoid stacked title/toolbars, redundant introductions and permanent panels that
do not earn their width. Put a contextual action beside its section heading.

On mobile, use a navigation drawer and one useful working pane at a time. Keep
Files/Links/Graph and secondary tools available on demand. Preserve underlying
conversation streams and terminal connections when presentation changes.
Support 320px and 390px widths without page overflow; local table/board scrolling
must be intentional and discoverable. Maintain 44px touch targets even when the
visible icon or label is compact.

## Elevation & Depth

Sidebar, header and main canvas must share the same base background in each
theme. Do not introduce a darker sidebar or a separate main-panel fill. Orientation
comes from content, spacing and a quiet divider. Use a second surface only when containment helps a task,
and elevated surfaces mainly for transient overlays. Do not assign every nested
region a different shade; that produces the layered dashboard appearance Nir
rejected.

Use a subtle 1px divider where structure needs it. Borderless groups are the
default when alignment and spacing suffice. Shadows belong to floating overlays,
not ordinary task rows, stats or document panels. Avoid glow, decorative gradients,
glass effects and persistent pulsing outlines.

The refinement should be visible in a grayscale screenshot: hierarchy should
survive removal of status colors. A palette change alone does not resolve excess
containers, duplicated toolbars or overemphasized text.

## Shapes

Use a small, consistent vocabulary: 4px tags, 6px controls, 8px necessary panels,
12px dialogs. Rounded corners communicate a boundary; they are not decoration.
Do not turn every filter into a pill or place rounded cards inside rounded cards.
Icons share a restrained stroke weight and use the same foreground hierarchy as
text. Decorative icons should not add color to otherwise neutral controls.

## Components

### Actions and navigation

Each working region has a clear primary action. Neutral filled buttons carry
that emphasis; secondary actions are ghost/text, with an outline only when
necessary. Hover uses a small surface change; pressed/selected remains stable.
Focus is a visible 2px outline, independent of hover and color perception.
Destructive actions remain explicit and separated from the default action.

Navigation uses readable text with a quiet selected fill. Avoid simultaneously
emphasizing the same selection through several decorative treatments. Keep URL,
header and selected destination aligned. Every tab/view remains shareable and
restores on reload and browser Back/Forward.

### Lists, boards and Activity

Use rows and aligned text for repeated information. Keep row separators subtle;
do not box each row individually. Status uses a concise label plus small marker.
Selected rows need an unambiguous neutral fill and accessible state.

Activity should read as a concise working summary. Replace the visual effect of
large, individually colored KPI tiles with quieter grouped metrics. Give recent
work more importance than its container. Board columns and drag affordances must
stay legible without heavy borders or large colored headers.

### Inputs and filters

Keep inputs close to the canvas, with a clear label and visible focus. Use one
canonical control for each filter; do not add duplicate bulk toolbar actions.
Persistent agent-discovery visibility and a local source filter are distinct
behaviors, and their labels must explain that distinction.

### Wiki and Knowledge base

The authored page is the focal point. The file tree, graph, backlinks, save state
and revision controls support it. Use the same quiet editor frame in read/edit/
split modes. Display dirty, saving, conflict and error states clearly; never
trade data protection for visual simplicity. Indexed source documents remain
distinct from authored Wiki content. Technical audit details stay secondary.

### Conversation and terminal

Keep messages on a calm reading surface with light role/agent attribution.
Avoid a border around every assistant paragraph or a new card for each chunk.
The composer is a recognizable working area with clear send/cancel states.
Keep assistant-ui integration, Codex as initial default and saved agent choice.

Terminal output retains a dark, ANSI-readable canvas in either theme. Surrounding
chrome follows the app theme. Match file/editor/diff toolbars to shared variants;
do not add another permanent navigation column. Changes to layout must preserve
PTY continuity, keyboard input, output replay and file save/reopen.

### Feedback and motion

Loading skeletons should resemble content without dominating the page. Empty
states explain the next useful action. Errors remain readable, actionable and
distinct from empty results. Inline feedback should stay near its cause.

Use short, user-triggered transitions around 120–180ms. Honor reduced motion.
Selective Magic UI interactions must support orientation; theme switching does
not need a decorative reveal to feel polished.

## Do's and Don'ts

- Do prioritize the work over the chrome: page, conversation, task, terminal.
- Do use neutral space and typography before introducing another container.
- Do keep contrast, focus, status meaning and touch targets accessible.
- Do validate realistic populated, empty, loading, failure and conflict states.
- Do review dark/light desktop and phone renders before broad migration.
- Don't copy Linear's lime palette, marketing spacing or oversized headings.
- Don't use bright colors merely to make a muted UI feel designed.
- Don't rename features, merge data models or change routes as a theme shortcut.
- Don't call the target implemented or approved because token lint passes.

### Review gate for the next theme pass

Prepare a representative Activity view, populated Tasks list and Wiki/chat
reading view using shared variants. Compare them with the current baseline.
Check that the screen feels quieter with fewer simultaneous borders/fills,
while primary action, selected item, current project and error state remain easy
to identify. Nir reviews that comparison before broad application.

Then verify actual text/non-text contrast, keyboard navigation, responsive
behavior, theme persistence, save/reopen and live stream/terminal continuity.
Format validation is useful evidence about this document, not proof of product
accessibility or visual approval.

### Black canvas palette refinement

Activity uses #000000 throughout its shell, #141414 hover, #242424 selection, #E5E5E5 content and #A3A3A3 secondary text. Primary action fill is #DEDEDE. Status dots are 6px at full opacity: neutral todo, blue doing/queued (#8AB4F8), amber review, rose blocked/changes requested and green done. Critical/high priorities retain restrained semantic text. The Activity direction is approved for broader adoption; remaining screens receive integration validation.

## Approved implementation reference: Activity

### Brand assets

Keep the existing diamond mark. Application icons and browser favicons use a flat
`#E5E5E5` mark on a `#000000` tile, with transparent space outside the tile. Avoid
colored gradients and glow. Desktop SVG/PNG and web favicon must depict the same
mark. In-app wordmarks inherit the theme's neutral foreground. Reserve accent
colors for meaningful status; the logo does not need a separate brand accent.

Nir approved extending the black Activity direction to the whole application on
2026-10-15. Activity is the implemented reference, not a license to rename features
or restructure navigation. Preserve routes, shareable tabs, project scope, all
existing actions, loading/error states, streaming and terminal continuity.

### Color hierarchy and interaction contract

- Sidebar, header and page canvas share #000000 in dark mode. Section grouping
  uses headings, spacing and quiet #262626 separators, not alternate page fills.
- Body and headings use #E5E5E5. Metadata and secondary navigation use #A3A3A3.
  Do not fade saved text with opacity. Metadata must remain readable in every state.
- Hover is #141414, popovers/dialogs #1C1C1C, selected navigation/tabs #242424.
  Only transient overlays or functional editors need contained surfaces.
- Primary actions use #DEDEDE with black text. Secondary actions use neutral
  outlines/ghosts. Reserve a strong primary action for the main task in its section.
- Status dots use explicit semantic tokens at full opacity, minimum 6px. Doing and
  queued use #8AB4F8, review #D6B675, blocked/changes requested #E2919A,
  done #85C19D, neutral states #A3A3A3. Always keep the readable status label.
  Small semantic blue is permitted; blue backgrounds and large tinted panels are not.
- Critical and high priority retain restrained error/warning text. Normal and low
  use readable secondary text. Never color an entire row or KPI card by status.
- Keyboard focus uses #C4C4C4, visible at 2px with offset. Preserve input boundaries
  and accessible interactive affordances; decorative separators can be low contrast.
- At the darkest selected surface, main text is 12.32:1 and secondary text 6.15:1.
  Check actual foreground/background combinations, not just individual hex values.
- Light mode keeps its separate semantic palette. Never reuse dark semantic hues
  blindly on white; semantic colors must have sufficient contrast in both themes.

### Page and component adaptation

Use existing Tailwind semantic utilities and shadcn components. Shared theme and
variants belong to the coordinator. Page owners replace hardcoded or decorative
colors, unnecessary nested cards, heavy badge fills and competing section treatments.
Use sections for meaning: title/action row, resource controls, main content, supporting
content. Keep table headers secondary and titles primary. Avoid adding labels,
extra headings or explanatory UI copy merely to fill space. Preserve current sizing;
Nir confirmed the earlier perceived size issue was browser zoom.

Knowledge remains a reading/editing workspace: Wiki, Knowledgebase and Memories
keep their names and shareable tabs. Chat keeps its dedicated components, Codex default
and persisted provider selection. Terminals retain terminal state, PTY lifecycle,
scrollback and key input. Syntax colors may remain domain-specific where needed for
legibility; no blanket grayscale filters or broad descendant color overrides.

### Verification and ownership

Each owner reports exact changed files, scoped lint/typecheck or relevant tests,
actual behavior exercised and remaining issues. Coordinator integrates incrementally,
checks populated desktop/mobile in both themes, accessibility contrast/focus, and
reviews for accidental behavior changes. No push, merge, release or deployment is
part of this visual adoption. Keep .claude/docs/redesign.md current.

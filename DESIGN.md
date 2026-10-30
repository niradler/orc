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

## Platform patterns approved 2026-10-28

These rules apply across the product, including populated, empty, error and phone
states. Retain Tailwind, shadcn/Radix, IBM Plex and the existing neutral palette.
Use the shared components instead of inventing a different toolbar or control
style in each feature. An assessment or mock does not complete adoption: validate
the actual application with realistic data and preserve its working behavior.

- **Controls:**32px desktop controls with13px labels;44px touch hit areas, including
  tablets. Primary phone controls can have a34px painted face within that target.
  Use one neutral filled action per working area. Secondary actions are ghost or
  a restrained outline; use a contextual menu for infrequent row actions. Give
  icon actions an accessible name. Do not hide touch actions behind hover.
- **Headers and lists:** use `ViewHeader` for a compact title, concise count,
  optional title-adjacent help and main action. Dense list titles use16px; the
  standalone page-title token remains22px. Search/filter/view controls share one
  aligned region; `ResponsiveFilters` retains phone filter state and active count.
  Explain selection scope and preserve displayed-record bulk semantics. Use slim
  records; do not stack44px controls vertically just to fit desktop columns on a
  phone. Put related edits in a row action menu while keeping essential status
  visible. Preserve full accessible names when visual titles truncate.
- **Copy and disclosure:** remove redundant explanations. Optional format/setup
  information belongs in focus/hover/tap help beside its subject. Keep required
  instructions, failures, permission decisions and recovery visible. Secondary
  history/setup starts collapsed; counts/status identify relevant work without
  forcing it open for new arrivals. Documents and current work precede setup.
- **Forms:** short confirmations stay small. Use `FormDialog` for long project,
  task and job configuration: up to960px, related desktop columns, one ordered
  phone column, scrollable body and stable actions. Keep errors in the body above
  the footer. Protect dirty Cancel/Escape/backdrop, browser Back and reload; Keep
  editing preserves values, explicit Discard leaves safely, and focus returns to
  the opener. Pending operations cannot be dismissed. Successful writes use the
  committed close callback so navigation is not mistaken for discarded work.
  Long configuration forms use named tabbed steps to reduce scrolling. Keep
  values while moving between tabs, allow direct tab navigation, and validate
  every step before saving; reveal and focus an invalid field's step. Short forms
  stay on one page. Phone footers reach the dialog bottom without stretching
  gaps between fields.
- **Chat:** show one selected conversation. Session history is **one flat list,
  newest activity first**. Open, selected, working and needs-input states use icons
  and selection styling; they never create sections or override date order. Do not
  add Open/Earlier, source or date groups without explicit new direction. This is
  an intentional exception to the general secondary-list disclosure guidance. Use a
  collapsible sidebar in desktop fullscreen and a named phone drawer. Keep agent
  and model controls in the composer and infrequent conversation actions in one
  named menu. Changing agents after a session starts creates a separate session;
  changing models applies to the next turn. Align assistant and composer columns,
  including16px phone insets. Closing an open session leaves it in this same list with its drafts/history
  and background activity, but pauses pending-message dispatch. Stop, requests,
  errors and paused queues remain discoverable. Provider catalogs and model
  validation use the existing contracts; never hardcode a preview model list.
- **Settings:** named sections have clear save ownership. Appearance saves
  immediately; browser connection and server terminal font each have their own
  actions. Embedded server/host/chat/notification/knowledge forms own their saves.
  Keep sections mounted so switching categories does not erase drafts. URLs
  restore the current section on Back/reload.
- **Verification:** review populated desktop and phone states, both themes,
  keyboard focus, touch targets, long content and recoverable failures. Exercise
  real save/reopen, selection/filter scope, native session resume, stream/queue
  controls and terminal continuity when affected. Screenshots and automated
  accessibility scans support this evidence; they do not certify every browser
  or assistive technology.

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
the Activity comparison. Fonts remain; control sizing follows the compact platform rules above. Dark is the
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
- Document and conversation reading: 16px with generous 1.65 line height and a
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

Desktop detail panels resize from their outer edge by dragging or using arrow
keys on the splitter. Remember widths per view, clamp them to the current
viewport, and allow a double-click to restore the default. Phone panels fill the
available width. Agent and package detail actions use compact toolbars, with
instructions or files occupying the main reading area and source metadata in
expandable details.

The shell is project-centered: a compact sidebar, project dropdown and one
contextual navigation row. Keep Activity first and the default at `/activity`.
Knowledge has exactly Knowledge base and Memories as sibling destinations.
KB settings, digest, comments and document history are contextual actions. Chat opens from
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

Touch sizing follows the input device as well as viewport width, including tablets.
Keep input text at 16px on touch devices. Respect safe-area insets and the visual
viewport when software keyboards open; dialogs and composers must remain reachable.
Opening chat on a phone should focus the sheet without opening the keyboard.

Below 1024px, terminal workspaces show one selected pane and preserve the desktop
split layout. Put terminal details, close and worktree management in the options
sheet, and expose Esc, Tab, Ctrl+C and arrow keys for touch keyboards. Keep the
shortcut strip locally scrollable; it must not widen the workspace.

Below 1280px, chat occupies a full-screen sheet instead of squeezing the workspace.
Larger screens offer a resizable panel and a full-screen icon. Keep the same
conversation and stream while switching presentation. Use one compact header and
composer; activity indicators must not move or obscure Send/Stop.

Put the model choice in the composer and conversation history in the header.
Keep provider thinking and tool input/results collapsed by default, with native
details/summary keyboard and touch interaction. Show real provider events only;
use the responding indicator while a provider is quiet. Preserve activity with
the conversation and show permission decisions separately from tool results.
Settings owns new-chat defaults; the chat model dialog shows the session's
actual instructions, tools connection, permissions and execution folder. Changing
agents starts a new session; changing models affects the next turn.

On narrow screens, Knowledge Browse is a modal with trapped focus and a visible
close action. Restore focus to its trigger when dismissed; selecting a document
closes it. Document details use the shared sheet. Validate phone portrait and
landscape, tablet and desktop, in both themes and Chromium/WebKit.

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

Icon-only actions need an accessible name and explanatory hover/focus help.
Shared icon Buttons provide `ActionHelp`; raw icon actions use the same wrapper.
On touch, a hold explains an action without executing it, while a short tap keeps
its normal behavior. Actions with an existing explanation/confirmation popover
opt out of duplicate help. Keep destructive and installation confirmation explicit.

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

Single-value selects share a 14px chevron, 12px edge inset and centered alignment.
Native selects reserve space for that glyph through the global rule; Radix uses
the shared `SelectTrigger`. Do not add another arrow overlay to native selects.
Long selected values truncate before the arrow. Keep native popup and keyboard
behavior, omit chevrons from multi-row listboxes, mirror placement for RTL and
allow the platform arrow in forced-colors mode.

### Knowledge base

The document is the focal point. The file tree, links, comments, save state
and revision controls support it. Use the same quiet editor frame in read/edit/
split modes. Display dirty, saving, conflict and error states clearly; never
trade data protection for visual simplicity. Folder-backed copies remain
distinct from documents written in ORC. Technical audit details stay secondary.
Comments stay collapsed to one header row with a count per status (open uses
the warning dot, resolved done, dismissed neutral); a count opens the list
filtered to it. Maintenance warnings appear only when a document needs action.

### Compact, screen-aware working controls

Nir approved the compact chat queue in PR124 as the reference for professional
workspace controls. Design for the available screen space and the user's main
task; supporting controls must not consume the reading or editing area by default.

The workspace cleanup approved on 2026-10-28 extends this to Webhooks, Sessions,
Scratchpads and Jobs. Use the shared compact `ViewHeader`, `HelpPopover` and
`ResponsiveFilters` patterns: title, useful count and one primary action, followed
by search and filters. Remove obvious introductions and repeated empty-state
instructions. Put useful one-time explanations beside the title in help that
works with hover, keyboard focus and tap. Keep errors, recovery instructions,
permission decisions and unsaved state visible. On phones, keep search available
and disclose secondary filters with their active count; preserve their values
through hide/reopen, viewport changes and reload. Section tabs scroll locally
rather than wrapping into several rows. Use compact lists when table columns
would squeeze the actual work, retaining task links, status and contextual actions.

- Prefer one quiet summary with a count and progressive disclosure for secondary
  lists. Start nonessential details collapsed; new entries update the summary
  without reopening it. Keep urgent errors and decisions visible.
- Expanded repeated items should usually be slim rows with concise text and
  nearby actions, rather than separate padded cards, repeated badges, headings
  and multi-line action bars. Add a container only when it communicates structure.
- Show multiline editors and their Save/Cancel controls only for the item being
  edited. Keep routine actions, including removal where appropriate, reachable
  without opening a large editor. Icon actions need names, tooltips and focus states.
- Adapt density to the actual panel width and viewport, including narrow desktop
  side panels, phones, landscape and the software keyboard. Preserve readable
  text, 44px phone touch targets and bounded scrolling. Do not shrink touch targets
  merely to make a screenshot look dense.
- Preserve drafts and edit state when panels hide, resize or become fullscreen.
  A resumed editor must remain discoverable. Collapsing UI must not lose work or
  change the order, pause state or meaning of queued actions.

For a new or substantially changed control, inspect realistic populated desktop
and phone screenshots before calling the UI complete. Compare the space used in
its default, expanded and editing states. Reduce repeated chrome before asking
Nir to approve the result. The approved queue uses a 32px desktop / 44px phone
summary; those are examples, not mandatory heights for every component.

### Chat and terminal continuity

Use **Sessions** consistently in chat navigation. Keep history flat, ordered by
latest activity descending; do not pin open sessions above newer history. Place
the new-session plus beside the Sessions title. Each row uses its actual provider
icon, with a state color and accessible explanation; do not infer stale or running
state from age. Keep useful session actions in the header when space permits and
move them into More at narrower panel widths. Keep agent/model controls in the
composer, and preserve settings drafts across responsive transitions.

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

Prepare a representative Activity view, populated Tasks list and KB document/chat
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

Knowledge remains a reading/editing workspace: Knowledge base and Memories
keep their names and shareable tabs. Chat keeps its dedicated components, Codex default
and persisted provider selection. Terminals retain terminal state, PTY lifecycle,
scrollback and key input. Syntax colors may remain domain-specific where needed for
legibility; no blanket grayscale filters or broad descendant color overrides.

### Selection and bulk actions

Skills selection is opt-in: default rows hide checkboxes, Multiselect reveals
them and becomes Select displayed, and Done exits selection. Preserve retry and
scope-reset behavior. Show Global or project scope as a desktop column and phone
metadata. Shared resources (Skills, Knowledge and Scratchpads) show global plus
the selected project; All projects shows all, and Unassigned shows global-only
resources. Project-owned work and session history use exact project filtering.
Unknown session ownership belongs in All projects only. Unassigned requires a
session known to have no project; never invent ownership for older saved chats.

Markdown content fields provide compact Edit/Preview controls using the existing
safe renderer. Content-only panels should fill their available height and scroll
within the reading/editing region. Keep native validation, unsaved work and the
established document editor's Read/Edit/Split workflow intact.

Resource lists should support selecting specific entries and applying common actions
without opening an editor for each item. Jobs and Projects are the first adopters.
Reuse `useListSelection`, `BulkActionBar`, and `applyBulkAction`; keep action semantics
in the resource hook rather than duplicating selection or request handling per page.

- Give each row a labeled checkbox; selection must not open its editor. Provide
  select-all-displayed, a mixed checkbox state, a selected count, and Clear selection.
- Scope selection to displayed rows and current project/filter. Clear it when scope
  changes; never silently apply a visible selection to hidden/server-wide records.
- Show resource-specific actions only for a nonempty selection. Keep the toolbar
  usable with keyboard, on mobile and in both themes. Disable repeated submissions.
- Report successes and failures separately; keep failed entries selected for retry.
  Refresh affected lists/details and prevent old results appearing in another scope.
- New jobs start disabled. Enabling is explicit at creation, in the list, or in edit.
  Allow configuring webhook connections while disabled without enabling the job.
- Destructive actions retain resource-specific confirmation and authorization; a
  generic bulk toolbar does not imply permission to add bulk deletion.

### Verification and ownership

Each owner reports exact changed files, scoped lint/typecheck or relevant tests,
actual behavior exercised and remaining issues. Coordinator integrates incrementally,
checks populated desktop/mobile in both themes, accessibility contrast/focus, and
reviews for accidental behavior changes. No push, merge, release or deployment is
part of this visual adoption. Keep .claude/docs/redesign.md current.

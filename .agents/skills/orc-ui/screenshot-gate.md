# UI screenshot capture and Nir approval gate

Every PR that changes user-visible UI must include visual proof of the changed states for Nir to review and approve before merge. Passing unit/E2E tests or token lint does **not** replace visual inspection.

## 1. Capture rules

- **Synthetic demo data only**: capture from a dev server or Playwright fixture using isolated synthetic data (fake project names, temp `ORC_HOME`, mocked/seeded API responses). **Never capture from a real workspace or real user data.**
- **Required states**:
  - **Desktop (`1440x900`)**: populated default state, plus dark **and** light theme whenever surfaces, colors, borders, or contrast changed.
  - **Phone (`390x844`)**: populated view proving no horizontal overflow, readable truncation, and touch-sized (`44px`) controls.
  - **Interactive / edge states**: expanded disclosures, open popovers (`HelpPopover`), validation/error states, or empty states touched by the change.
- **Capture to a temporary directory** outside the repo (for example `/tmp/orc-pr-<issue>-screens/`), never into the git working tree.

Example Playwright capture pattern inside an E2E spec:

```ts
const screenshotDir = process.env.ORC_SCREENSHOT_DIR;
if (screenshotDir) {
  await page.screenshot({ path: `${screenshotDir}/feature-desktop.png` });
}
```

Run with:

```bash
PW_SHARDS=1 ORC_SCREENSHOT_DIR=/tmp/orc-pr-screens \
  bun packages/web/scripts/run-e2e.ts tests/e2e/<spec>.e2e.ts
```

## 2. Self-inspect every image before uploading

Read every captured PNG directly and audit it cold before attaching:
- Does hierarchy read cleanly without excessive borders, fills, or visual clutter?
- Are icons, chevrons, badges, and timestamps aligned (e.g., expanded disclosure chevrons pointing down, not stuck right)?
- On phone (`390px`), is every title/summary legible with clean truncation, zero horizontal clipping, and full `44px` tap targets?
- In light and dark themes, is contrast clear on muted labels, borders, errors, and `HelpPopover` overlays?
- Are there any stray debug overlays, real workspace paths, or empty placeholders where populated data should appear?

Fix any visual defect first, re-run tests, and re-capture before posting.

## 3. Attach to the PR and flag Nir's approval gate

Upload the screenshots in a PR comment using `scripts/attach-screenshots.sh` (or `gh pr comment <pr> --attach '<path>#<alt>'` directly):

```bash
bash .agents/skills/orc-ui/scripts/attach-screenshots.sh <pr-number> \
  "Populated demo-data states for <feature> (synthetic fixtures, no real workspace data)." \
  /tmp/orc-pr-screens/feature-desktop.png#Desktop-default \
  /tmp/orc-pr-screens/feature-phone.png#Phone-390px
```

- **Never commit approval screenshots to the repository.**
- Only update `docs/public/screens/` when a `docs/docs/` page actively references that screenshot (and recapture stale docs screenshots from demo data in the same PR).
- Always end the screenshot PR comment with an explicit note that **Nir's visual review of the attached desktop and phone states is the remaining UI approval gate**.
- After review rework that alters UI, re-capture and post updated screenshots citing the new commit SHA.

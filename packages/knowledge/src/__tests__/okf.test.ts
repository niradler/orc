import { describe, expect, test } from "bun:test";
import {
  buildOkfBundle,
  exportDocument,
  isOkfReserved,
  okfFields,
  okfLabels,
  parseFrontmatter,
  withOkfDefaults,
} from "../okf.js";

const note = `---
title: Release runbook
description: How to ship safely
type: runbook
tags: [release, ops]
verified: true
status: active
stale_after: 2027-01-01
sources: [git:docs/release.md]
generated: 2026-11-20
---

# Release runbook

Steps.
`;

describe("OKF frontmatter", () => {
  test("reads modelled fields and keeps unknown ones", () => {
    const fields = okfFields(note);
    expect(fields.title).toBe("Release runbook");
    expect(fields.description).toBe("How to ship safely");
    expect(fields.type).toBe("runbook");
    expect(fields.tags).toEqual(["release", "ops"]);
    expect(fields.verified).toBe(true);
    expect(fields.stale_after).toBe("2027-01-01");
    expect(fields.extra.sources).toEqual(["git:docs/release.md"]);
    expect(okfLabels(note)).toEqual(["release", "ops", "runbook"]);
  });

  test("leaves content untouched and reserved names out of concepts", () => {
    const parsed = parseFrontmatter(note);
    expect(parsed.body.startsWith("\n# Release runbook")).toBe(true);
    expect(isOkfReserved("index.md")).toBe(true);
    expect(isOkfReserved("guides/LOG.MD")).toBe(true);
    expect(isOkfReserved("guides/release.md")).toBe(false);
  });

  test("ingest uses explicit values first and inherits labels", () => {
    expect(withOkfDefaults(note, { title: "Custom" }, "fallback")).toEqual({
      title: "Custom",
      description: "How to ship safely",
      labels: ["release", "ops", "runbook"],
    });
    expect(withOkfDefaults("no frontmatter", {}, "fallback")).toEqual({
      title: "fallback",
      description: "",
      labels: [],
    });
  });
});

describe("OKF export", () => {
  test("native fields win and unknown frontmatter round-trips", () => {
    const out = exportDocument({
      path: "runbooks/release.md",
      title: "Release runbook v2",
      description: "",
      labels: ["release", "runbook"],
      content: note,
    });
    const parsed = parseFrontmatter(out);
    expect(parsed.data?.title).toBe("Release runbook v2");
    expect(parsed.data?.description).toBeUndefined();
    expect(parsed.data?.tags).toEqual(["release"]);
    expect(parsed.data?.sources).toEqual(["git:docs/release.md"]);
    expect(parsed.data?.type).toBe("runbook");
    expect(parsed.body).toContain("# Release runbook");
  });

  test("builds concept files, folder indexes, root index and log", () => {
    const files = buildOkfBundle(
      [
        {
          path: "runbooks/release.md",
          title: "Release",
          description: "",
          labels: [],
          content: "# Release\n",
        },
        {
          path: "decisions/db.md",
          title: "Database",
          description: "",
          labels: [],
          content: "# Database\n",
        },
        { path: "index.md", title: "Ignore", description: "", labels: [], content: "x" },
      ],
      ["2026-11-28 · Release · revision 2 · nir"],
      "Engineering",
    );
    const paths = files.map((f) => f.path);
    expect(paths).toContain("runbooks/release.md");
    expect(paths).toContain("runbooks/index.md");
    expect(paths).toContain("decisions/index.md");
    expect(paths).toContain("index.md");
    expect(paths).toContain("log.md");
    expect(paths).not.toContain("index.md#concept");
    const root = files.find((f) => f.path === "index.md")?.content ?? "";
    expect(root).toContain('okf_version: "0.3"');
    expect(root).toContain("runbooks/index.md");
    const log = files.find((f) => f.path === "log.md")?.content ?? "";
    expect(log).toContain("revision 2");
  });
});

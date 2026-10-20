import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnauthorizedError } from "@orc/core/errors";
import type { SkillDownload } from "@orc/core/skill-download";
import { SKILL_DOWNLOAD_TTL_MS } from "@orc/core/skill-download";
import {
  createSkill,
  getUserSkillsDir,
  readSkill,
  reloadCache,
  type SkillRefContent,
} from "@orc/core/skill-service";
import { getSqlite } from "@orc/db/client";
import { SkillHistory } from "@orc/db/skill-history";
import { executeTool } from "@orc/mcp/tools";
import type { createApp } from "../server.js";
import { SkillDownloads } from "../skill-downloads.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

let app: ReturnType<typeof createApp>;
const name = `download-fixture-${crypto.randomUUID()}`;
const script = Buffer.from("\ufeffprint('original')\r\n", "utf8");
const binary = Buffer.from([0, 255, 128, 13, 10]);
const outside = mkdtempSync(join(tmpdir(), "orc-download-outside-"));

beforeAll(() => {
  app = setupTestApp();
  createSkill(name, `---\nname: ${name}\ndescription: Download fixture\n---\nUse the helper.`, [
    { path: "scripts/check.py", content: script.toString("base64"), encoding: "base64" },
    { path: "assets/data.bin", content: binary.toString("base64"), encoding: "base64" },
  ]);
  reloadCache();
});
afterAll(() => {
  rmSync(join(getUserSkillsDir(), name), { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  teardownTestApp();
});

async function mint(ref = "scripts/check.py"): Promise<SkillDownload> {
  const res = await req(app, "POST", `/skills/${name}/download`, { ref, scope: "global" });
  expect(res.status).toBe(200);
  return res.json();
}

describe("signed skill downloads", () => {
  test("only authenticated callers can mint URLs", async () => {
    const res = await app.request(`/api/skills/${name}/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "scripts/check.py" }),
    });
    expect(res.status).toBe(401);
  });

  test("downloads exact original script and binary bytes without sharing API credentials", async () => {
    for (const [ref, original] of [
      ["scripts/check.py", script],
      ["assets/data.bin", binary],
    ] as const) {
      const link = await mint(ref);
      expect(link.download_url).not.toContain("test-secret");
      expect(link.size_bytes).toBe(original.length);
      expect(link.sha256).toBe(createHash("sha256").update(original).digest("hex"));
      expect(Date.parse(link.expires_at) - Date.now()).toBeLessThanOrEqual(SKILL_DOWNLOAD_TTL_MS);
      const res = await app.request(link.download_url);
      expect(res.status).toBe(200);
      expect(Buffer.from(await res.arrayBuffer())).toEqual(original);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
      expect(res.headers.get("Content-Disposition")).toContain("attachment;");
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    }
  });

  test("rejects payload tampering, wrong signatures and non-GET use", async () => {
    const link = await mint();
    const url = new URL(link.download_url);
    const token = url.pathname.split("/").at(-1) as string;
    const [payload, signature] = token.split(".") as [string, string];
    const claim = JSON.parse(Buffer.from(payload, "base64url").toString());
    claim.ref = "assets/data.bin";
    const changed = Buffer.from(JSON.stringify(claim)).toString("base64url");
    for (const bad of [`${changed}.${signature}`, `${payload}.${"A".repeat(43)}`]) {
      expect((await app.request(`/api/skills/download/${bad}`)).status).toBe(401);
    }
    expect((await app.request(link.download_url, { method: "POST" })).status).toBe(401);
    expect((await app.request("/api/skills/download/not-a-token")).status).toBe(401);
  });

  test("expires URLs and invalidates them across signer restarts", () => {
    let now = Date.now();
    const service = new SkillDownloads(() => now);
    const link = service.mint(name, "scripts/check.py", null, "http://localhost");
    const token = new URL(link.download_url).pathname.split("/").at(-1) as string;
    expect(service.read(token).bytes).toEqual(script);
    expect(() => new SkillDownloads().read(token)).toThrow(UnauthorizedError);
    now += SKILL_DOWNLOAD_TTL_MS;
    expect(() => service.read(token)).toThrow(UnauthorizedError);
  });

  test("a changed script cannot be substituted behind an existing signed URL", async () => {
    const link = await mint();
    const file = join(getUserSkillsDir(), name, "scripts/check.py");
    try {
      writeFileSync(file, "print('changed')");
      expect((await app.request(link.download_url)).status).toBe(409);
    } finally {
      writeFileSync(file, script);
    }
  });

  test("path traversal, symlinks, missing files and invalid project scopes cannot mint capabilities", async () => {
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "private.py"), "outside-only");
    symlinkSync(outside, join(getUserSkillsDir(), name, "linked"), "junction");
    for (const ref of [
      "../private.py",
      "scripts/../../private.py",
      "linked/private.py",
      "C:/private.py",
    ]) {
      expect((await req(app, "POST", `/skills/${name}/download`, { ref })).status).toBe(400);
    }
    expect((await req(app, "POST", `/skills/${name}/download`, { ref: "missing.py" })).status).toBe(
      404,
    );
    expect(
      (
        await req(app, "POST", `/skills/${name}/download`, {
          ref: "SKILL.md",
          project_id: "no-project",
        })
      ).status,
    ).toBe(404);
  });

  test("MCP returns a usable link instead of putting the script body in context", async () => {
    const res = await req(app, "POST", "/mcp/tool", {
      name: "skill_read",
      args: {
        name,
        ref: "scripts/check.py",
        download: true,
        scope: "global",
      },
    });
    expect(res.status).toBe(200);
    const result = (await res.json()).result as string;
    expect(result).not.toContain("print('original')");
    const link = JSON.parse(result) as SkillDownload;
    expect(Buffer.from(await (await app.request(link.download_url)).arrayBuffer())).toEqual(script);
    const invalid = await req(app, "POST", "/mcp/tool", {
      name: "skill_read",
      args: { name, download: true },
    });
    expect(invalid.status).toBe(400);
  });

  test("retired skill names can download the canonical helper", async () => {
    const res = await req(app, "POST", "/skills/orc-handoff/download", {
      ref: "scripts/upload-session.py",
    });
    expect(res.status).toBe(200);
    const link = (await res.json()) as SkillDownload;
    const response = await app.request(link.download_url);
    const file = readSkill("orc-platform", "scripts/upload-session.py") as SkillRefContent;
    expect(Buffer.from(await response.arrayBuffer())).toEqual(readFileSync(file.path));
  });

  test("pins the effective project entry without substituting global instructions", async () => {
    const sqlite = getSqlite();
    sqlite
      .query("INSERT INTO projects(id,name) VALUES (?,?)")
      .run("download-project", "download-project");
    const history = new SkillHistory(sqlite);
    const original = history.read(name, null, "SKILL.md") as SkillRefContent;
    history.update({
      skill_name: name,
      project_id: "download-project",
      content: `${original.content}\nProject-only guidance`,
      expected_content: original.content,
      reason: "Fixture",
    });
    const res = await req(app, "POST", `/skills/${name}/download`, {
      ref: "SKILL.md",
      project_id: "download-project",
    });
    expect(res.status).toBe(200);
    const projectLink = (await res.json()) as SkillDownload;
    expect(await (await app.request(projectLink.download_url)).text()).toContain(
      "Project-only guidance",
    );
    const globalLink = await mint("SKILL.md");
    expect(await (await app.request(globalLink.download_url)).text()).not.toContain(
      "Project-only guidance",
    );
  });

  test("standalone MCP execution mints through the API and returns a reachable URL", async () => {
    const prior = process.env.ORC_API_BASE;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
    try {
      process.env.ORC_API_BASE = `http://127.0.0.1:${server.port}`;
      const result = JSON.parse(
        await executeTool("skill_read", {
          name,
          scope: "global",
          ref: "scripts/check.py",
          download: true,
        }),
      ) as SkillDownload;
      const response = await fetch(result.download_url);
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(script);
    } finally {
      server.stop(true);
      if (prior === undefined) delete process.env.ORC_API_BASE;
      else process.env.ORC_API_BASE = prior;
    }
  });
});

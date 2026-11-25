import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { resetConfig } from "@orc/core/config";
import { ulid } from "@orc/core/ids";
import {
  createSkill,
  getUserSkillsDir,
  readSkill,
  reloadCache,
  type SkillRefContent,
} from "@orc/core/skill-service";
import { closeDb, createTestDb, getSqlite } from "@orc/db/client";
import { SkillHistory } from "@orc/db/skill-history";
import { createMcpServer } from "../server.js";
import { SKILLS_EXTENSION_ID } from "../skill-resources.js";

const originalActiveProject = process.env.ORC_ACTIVE_PROJECT;
const SKILL = `mcp-spec-skills-${process.pid}`;
const PAGE_SKILLS = Array.from({ length: 55 }, (_, i) => `mcp-spec-page-${i}-${process.pid}`);
const skillDir = join(getUserSkillsDir(), SKILL);

const SKILL_CONTENT = `---
name: ${SKILL}
description: Spec surface test skill
metadata:
  owner: test
---

# Test skill

Read references/checklist.md before reviewing.
`;
const CHECKLIST = "- check correctness\n- check tests\n";
const SCRIPT = "print('hi')\n";
// 1x1 transparent PNG (binary asset → base64/blob transport).
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function connectClient(options: Parameters<typeof createMcpServer>[0] = {}) {
  const server = createMcpServer({ mode: "full", ...options });
  const client = new Client({ name: "spec-test", version: "0.0.1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

function request(client: Client, method: string, params: Record<string, unknown> = {}) {
  return client.request({ method, params }, ResultSchema);
}

/** Page through a full skills/list result set. */
async function listAllSkills(client: Client) {
  const skills: {
    uri: string;
    frontmatter: Record<string, unknown>;
    resources: { uri: string; digest: string; size: number }[];
  }[] = [];
  let cursor: string | undefined;
  do {
    const result = (await request(client, "skills/list", cursor ? { cursor } : {})) as {
      skills: typeof skills;
      nextCursor?: string;
    };
    skills.push(...result.skills);
    cursor = result.nextCursor;
  } while (cursor);
  return skills;
}

/** Page through a full resources/list result set. */
async function listAllResources(client: Client) {
  const resources: { uri: string; name: string }[] = [];
  let cursor: string | undefined;
  do {
    const result = (await request(client, "resources/list", cursor ? { cursor } : {})) as {
      resources: typeof resources;
      nextCursor?: string;
    };
    resources.push(...result.resources);
    cursor = result.nextCursor;
  } while (cursor);
  return resources;
}

beforeAll(() => {
  process.env.ORC_ACTIVE_PROJECT = "";
  process.env.ORC_DB_PATH = ":memory:";
  resetConfig();
  createTestDb();
  createSkill(SKILL, SKILL_CONTENT, [
    { path: "references/checklist.md", content: CHECKLIST },
    { path: "scripts/run.py", content: SCRIPT },
    { path: "assets/logo.png", content: PNG_BASE64, encoding: "base64" },
  ]);
  for (const name of PAGE_SKILLS) {
    createSkill(name, `---\nname: ${name}\ndescription: Pagination fixture\n---\n\nBody.\n`);
  }
  reloadCache();
});

afterAll(() => {
  rmSync(skillDir, { recursive: true, force: true });
  for (const name of PAGE_SKILLS) {
    rmSync(join(getUserSkillsDir(), name), { recursive: true, force: true });
  }
  reloadCache();
  if (originalActiveProject === undefined) delete process.env.ORC_ACTIVE_PROJECT;
  else process.env.ORC_ACTIVE_PROJECT = originalActiveProject;
  closeDb();
  resetConfig();
  delete process.env.ORC_DB_PATH;
});

describe("Skills over MCP: capabilities", () => {
  test("server declares resources and the skills extension with directoryRead", async () => {
    const { client, server } = await connectClient();
    const capabilities = client.getServerCapabilities();
    expect(capabilities?.resources).toBeDefined();
    expect(capabilities?.extensions?.[SKILLS_EXTENSION_ID]).toEqual({ directoryRead: true });
    await client.close();
    await server.close();
  });
});

describe("Skills over MCP: discovery and integrity", () => {
  test("skills/list returns complete entries with manifests and cache fields", async () => {
    const { client, server } = await connectClient();
    const result = (await request(client, "skills/list")) as {
      resultType: string;
      ttlMs: number;
      cacheScope: string;
      skills: {
        uri: string;
        frontmatter: Record<string, unknown>;
        resources: { uri: string; digest: string; size: number }[];
      }[];
    };
    expect(result.resultType).toBe("complete");
    expect(result.ttlMs).toBeGreaterThan(0);
    expect(result.cacheScope).toBe("private");
    const entry = (await listAllSkills(client)).find((s) => s.uri === `skill://${SKILL}/SKILL.md`);
    expect(entry).toBeDefined();
    expect(entry?.frontmatter).toEqual({
      name: SKILL,
      description: "Spec surface test skill",
      metadata: { owner: "test" },
    });
    const uris = entry?.resources.map((r) => r.uri).sort();
    expect(uris).toEqual(
      [
        `skill://${SKILL}/SKILL.md`,
        `skill://${SKILL}/assets/logo.png`,
        `skill://${SKILL}/references/checklist.md`,
        `skill://${SKILL}/scripts/run.py`,
      ].sort(),
    );
    await client.close();
    await server.close();
  });

  test("every manifest file verifies by digest and size over resources/read", async () => {
    const { client, server } = await connectClient();
    const entry = (await listAllSkills(client)).find((s) => s.uri === `skill://${SKILL}/SKILL.md`);
    for (const file of entry?.resources ?? []) {
      const read = (await request(client, "resources/read", { uri: file.uri })) as {
        contents: { uri: string; mimeType?: string; text?: string; blob?: string }[];
      };
      const content = read.contents[0];
      expect(content?.uri).toBe(file.uri);
      const bytes =
        content?.blob !== undefined
          ? Buffer.from(content.blob, "base64")
          : Buffer.from(content?.text ?? "", "utf8");
      expect(bytes.length).toBe(file.size);
      expect(`sha256:${createHash("sha256").update(bytes).digest("hex")}`).toBe(file.digest);
    }
    await client.close();
    await server.close();
  });

  test("SKILL.md is served with its frontmatter; supporting files resolve by URI", async () => {
    const { client, server } = await connectClient();
    const entry = (await request(client, "resources/read", {
      uri: `skill://${SKILL}/SKILL.md`,
    })) as { contents: { text: string; mimeType: string }[] };
    expect(entry.contents[0]?.mimeType).toBe("text/markdown");
    expect(entry.contents[0]?.text.startsWith("---\n")).toBe(true);
    expect(entry.contents[0]?.text).toContain("Read references/checklist.md");

    const checklist = (await request(client, "resources/read", {
      uri: `skill://${SKILL}/references/checklist.md`,
    })) as { contents: { text: string }[] };
    expect(checklist.contents[0]?.text).toBe(CHECKLIST);

    const png = (await request(client, "resources/read", {
      uri: `skill://${SKILL}/assets/logo.png`,
    })) as { contents: { blob: string; mimeType: string }[] };
    expect(png.contents[0]?.mimeType).toBe("application/octet-stream");
    expect(png.contents[0]?.blob).toBe(PNG_BASE64);
    await client.close();
    await server.close();
  });

  test("skills/get returns the entry; unknown URIs fail with -32602", async () => {
    const { client, server } = await connectClient();
    const got = (await request(client, "skills/get", {
      uri: `skill://${SKILL}/SKILL.md`,
    })) as { skill: { uri: string }; resultType: string };
    expect(got.resultType).toBe("complete");
    expect(got.skill.uri).toBe(`skill://${SKILL}/SKILL.md`);

    for (const [method, params] of [
      ["skills/get", { uri: "skill://no-such-skill-xyz/SKILL.md" }],
      ["resources/read", { uri: `skill://${SKILL}/no-such-file.md` }],
      ["resources/read", { uri: "skill://no-such-skill-xyz/SKILL.md" }],
    ] as const) {
      const error = await request(client, method, params).catch((e: unknown) => e);
      expect((error as { code?: number }).code).toBe(-32602);
    }
    await client.close();
    await server.close();
  });

  test("resources/list exposes skill files as resources", async () => {
    const { client, server } = await connectClient();
    const resources = await listAllResources(client);
    expect(resources.some((r) => r.uri === `skill://${SKILL}/SKILL.md`)).toBe(true);
    expect(resources.some((r) => r.uri === `skill://${SKILL}/references/checklist.md`)).toBe(true);
    await client.close();
    await server.close();
  });
});

describe("Skills over MCP: directory read", () => {
  test("root lists SKILL.md and child directories; subdirectory lists direct children", async () => {
    const { client, server } = await connectClient();
    const root = (await request(client, "resources/directory/read", {
      uri: `skill://${SKILL}`,
    })) as { resources: { uri: string; name: string; mimeType: string }[] };
    const byName = new Map(root.resources.map((r) => [r.name, r]));
    expect(byName.get("SKILL.md")?.mimeType).toBe("text/markdown");
    expect(byName.get("references")?.mimeType).toBe("inode/directory");
    expect(byName.get("scripts")?.mimeType).toBe("inode/directory");
    expect(byName.get("assets")?.mimeType).toBe("inode/directory");

    const refs = (await request(client, "resources/directory/read", {
      uri: `skill://${SKILL}/references`,
    })) as { resources: { name: string; uri: string; mimeType: string }[] };
    expect(refs.resources).toEqual([
      {
        uri: `skill://${SKILL}/references/checklist.md`,
        name: "checklist.md",
        mimeType: "text/markdown",
      },
    ]);

    const error = await request(client, "resources/directory/read", {
      uri: `skill://${SKILL}/references/`,
    }).catch((e: unknown) => e);
    expect((error as { code?: number }).code).toBe(-32602);
    await client.close();
    await server.close();
  });
});

describe("Skills over MCP: pagination", () => {
  test("skills/list pages through the catalog without duplicates", async () => {
    const { client, server } = await connectClient();
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      const result = (await request(client, "skills/list", cursor ? { cursor } : {})) as {
        skills: { uri: string }[];
        nextCursor?: string;
      };
      pages += 1;
      for (const skill of result.skills) {
        expect(seen.has(skill.uri)).toBe(false);
        seen.add(skill.uri);
      }
      cursor = result.nextCursor;
    } while (cursor);
    expect(pages).toBeGreaterThan(1);
    for (const name of PAGE_SKILLS) expect(seen.has(`skill://${name}/SKILL.md`)).toBe(true);
    expect(seen.has("skill://orc-sdlc/SKILL.md")).toBe(true);

    const error = await request(client, "skills/list", { cursor: "not-a-cursor" }).catch(
      (e: unknown) => e,
    );
    expect((error as { code?: number }).code).toBe(-32602);
    await client.close();
    await server.close();
  });
});

describe("Skills over MCP: project scoping and overlays", () => {
  const projectId = ulid();
  const otherProjectId = ulid();
  const scopedSkill = `mcp-spec-scoped-${process.pid}`;

  beforeAll(() => {
    const sqlite = getSqlite();
    sqlite
      .query("INSERT INTO projects(id,name) VALUES(?,?)")
      .run(projectId, `spec-scope-${process.pid}`);
    sqlite
      .query("INSERT INTO projects(id,name) VALUES(?,?)")
      .run(otherProjectId, `spec-scope-other-${process.pid}`);
    createSkill(
      scopedSkill,
      `---\nname: ${scopedSkill}\ndescription: Scoped fixture\n---\n\nScoped body.\n`,
    );
    reloadCache();
    const history = new SkillHistory(sqlite);
    history.setProjects(scopedSkill, [projectId]);
    history.setProjects(SKILL, [otherProjectId]);
  });

  afterAll(() => {
    rmSync(join(getUserSkillsDir(), scopedSkill), { recursive: true, force: true });
    reloadCache();
  });

  test("scoped connection sees its project's skills; foreign-assigned skills are hidden", async () => {
    const { client, server } = await connectClient({ project: `spec-scope-${process.pid}` });
    const uris = (await listAllSkills(client)).map((s) => s.uri);
    expect(uris).toContain(`skill://${scopedSkill}/SKILL.md`);
    expect(uris).not.toContain(`skill://${SKILL}/SKILL.md`);
    expect(uris).toContain("skill://orc-sdlc/SKILL.md");

    const error = await request(client, "skills/get", {
      uri: `skill://${SKILL}/SKILL.md`,
    }).catch((e: unknown) => e);
    expect((error as { code?: number }).code).toBe(-32602);
    await client.close();
    await server.close();
  });

  test("effective overlay is served as the SKILL.md bytes and hashed in the manifest", async () => {
    const history = new SkillHistory(getSqlite());
    const base = readSkill(scopedSkill, "SKILL.md") as SkillRefContent;
    const overlay = base.content.replace("Scoped body.", "Overlaid body for this project.");
    history.update({
      skill_name: scopedSkill,
      project_id: projectId,
      content: overlay,
      expected_content: base.content,
      reason: "spec surface test",
    });

    const { client, server } = await connectClient({ project: `spec-scope-${process.pid}` });
    const got = (await request(client, "skills/get", {
      uri: `skill://${scopedSkill}/SKILL.md`,
    })) as { skill: { resources: { uri: string; digest: string; size: number }[] } };
    const manifest = got.skill.resources.find((r) => r.uri === `skill://${scopedSkill}/SKILL.md`);
    const read = (await request(client, "resources/read", {
      uri: `skill://${scopedSkill}/SKILL.md`,
    })) as { contents: { text: string }[] };
    expect(read.contents[0]?.text).toBe(overlay);
    const bytes = Buffer.from(read.contents[0]?.text ?? "", "utf8");
    expect(manifest?.size).toBe(bytes.length);
    expect(manifest?.digest).toBe(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
    await client.close();
    await server.close();
  });
});

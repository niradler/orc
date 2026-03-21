import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { ulid } from "@orc/core/ids";
import { createLogger } from "@orc/core/logger";
import { getDb } from "@orc/db/client";
import { prompts } from "@orc/db/schema";
import { eq } from "drizzle-orm";
import { Glob } from "bun";

const logger = createLogger("runner:seed-prompts");

type PromptFrontmatter = {
	name: string;
	description: string;
	is_skill: boolean;
	tags: string[];
};

function parseFrontmatter(content: string): {
	frontmatter: PromptFrontmatter;
	template: string;
} {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
	if (!match) throw new Error("Invalid SKILL.md: missing frontmatter");

	const raw = match[1] as string;
	const template = (match[2] as string).trim();

	const fm: Record<string, string> = {};
	for (const line of raw.split("\n")) {
		const idx = line.indexOf(":");
		if (idx === -1) continue;
		fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
	}

	const tags = (fm.tags ?? "")
		.replace(/^\[/, "")
		.replace(/\]$/, "")
		.split(",")
		.map((t) => t.trim())
		.filter(Boolean);

	return {
		frontmatter: {
			name: fm.name ?? "unknown",
			description: fm.description ?? "",
			is_skill: fm.is_skill === "true",
			tags,
		},
		template,
	};
}

export async function seedBuiltInPrompts(): Promise<void> {
	const db = getDb();
	const skillsDir = resolve(import.meta.dirname, "../../../skills/prompts");
	const glob = new Glob("*/SKILL.md");
	let seeded = 0;

	for await (const path of glob.scan(skillsDir)) {
		const fullPath = join(skillsDir, path);
		const content = readFileSync(fullPath, "utf-8");
		const { frontmatter: fm, template } = parseFrontmatter(content);

		const existing = await db.query.prompts.findFirst({
			where: eq(prompts.name, fm.name),
		});
		if (existing) continue;

		const now = new Date();
		await db.insert(prompts).values({
			id: ulid(),
			name: fm.name,
			description: fm.description,
			template,
			is_skill: fm.is_skill,
			tags: fm.tags,
			skill_dir: `skills/prompts/${basename(dirname(fullPath))}`,
			version: 1,
			pinned: true,
			created_at: now,
			updated_at: now,
		});
		seeded++;
	}
	if (seeded > 0) logger.info(`Seeded ${seeded} built-in prompts`);
}

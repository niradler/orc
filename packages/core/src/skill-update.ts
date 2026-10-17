import { z } from "zod";

const skillNameSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase-kebab-case")
  .max(100);

export const SkillUpdateSchema = z.object({
  project_id: z.string().min(1).nullable(),
  skill_name: skillNameSchema,
  content: z
    .string()
    .min(1)
    .max(100000)
    .describe("Full new SKILL.md including frontmatter (name must stay the same)"),
  reason: z.string().trim().min(1).max(2000),
  expected_content: z
    .string()
    .max(100000)
    .describe("Current full SKILL.md; a mismatch rejects a stale edit"),
  session_id: z.string().min(1).max(200).optional(),
  author: z.string().trim().min(1).max(200).optional(),
});
export type SkillUpdate = z.input<typeof SkillUpdateSchema>;

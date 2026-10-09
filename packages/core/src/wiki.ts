import { z } from "zod";

export const WikiEditSchema = z.object({
  slug: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(100),
  expected_revision: z.number().int().min(0),
  title: z.string().min(1).max(500),
  content: z.string().min(1).max(100000),
  tags: z.array(z.string().trim().min(1)).min(1).max(30),
  evidence: z.array(z.string().min(1)).min(1).max(100),
  summary: z.string().min(1).max(2000),
});
export const WikiOutcomeSchema = z.object({
  contribution_id: z.string(),
  project_id: z.string().nullable(),
  outcome: z.enum(["applied", "no_change", "failed"]),
  summary: z.string().min(1).max(4000),
  edits: z.array(WikiEditSchema).max(5).default([]),
});
export type WikiEdit = z.input<typeof WikiEditSchema>;
export type WikiOutcome = z.input<typeof WikiOutcomeSchema>;
export type WikiPage = {
  slug: string;
  project_id: string | null;
  revision: number;
  title: string;
  content: string;
  tags: string[];
  evidence: string[];
  summary: string;
  updated_at: number;
};
export type WikiContribution = {
  id: string;
  project_id: string | null;
  source_id: string;
  version: string;
  status: string;
  attempts: number;
  task_id: string | null;
  summary: string | null;
};
export type WikiContributionAttempt = {
  id: string;
  contribution_id: string;
  outcome: string;
  summary: string;
  created_at: number;
};

export type SkillActivation = {
  id: string;
  skill_name: string;
  proposal_id: string | null;
  evaluation_id: string | null;
  raw: string;
  previous_raw: string;
  active: number;
  action: string;
  reason: string;
  created_at: number;
};
export const SkillProposalSchema = z.object({
  project_id: z.string().nullable(),
  skill_name: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(100),
  baseline_hash: z.string().regex(/^[a-f0-9]{64}$/),
  candidate: z.string().min(1).max(100000),
  rationale: z.string().min(1).max(4000),
  evidence: z.array(z.string()).min(1).max(100),
  training_cases: z.array(z.string()).max(1000).default([]),
});
export const SkillEvaluationSchema = z.object({
  proposal_id: z.string(),
  project_id: z.string().nullable(),
  suite: z.string().min(1),
  cases: z
    .array(z.object({ id: z.string().min(1), baseline: z.boolean(), candidate: z.boolean() }))
    .min(1)
    .max(1000),
  validation_passed: z.boolean(),
  notes: z.string().max(4000),
});
export type SkillProposal = z.input<typeof SkillProposalSchema>;
export type SkillEvaluation = z.input<typeof SkillEvaluationSchema>;

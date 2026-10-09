import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { SkillEvaluationSchema, SkillProposalSchema, WikiOutcomeSchema } from "@orc/core/wiki";
import { getSqlite } from "@orc/db/client";
import { getSkillSnapshot, revertSkill } from "@orc/db/skill-evolution";
import { WikiStore } from "@orc/db/wiki";

const app = new OpenAPIHono();
const projectQuery = z.object({ project_id: z.string().optional(), slug: z.string().optional() });
const PageSchema = z.object({
  slug: z.string(),
  project_id: z.string().nullable(),
  revision: z.number(),
  title: z.string(),
  content: z.string(),
  tags: z.array(z.string()),
  evidence: z.array(z.string()),
  summary: z.string(),
  updated_at: z.number(),
});
app.openapi(
  createRoute({
    method: "get",
    path: "/knowledge/wiki",
    tags: ["Knowledge"],
    request: { query: projectQuery },
    responses: {
      200: {
        description: "Maintained wiki and processing history",
        content: {
          "application/json": {
            schema: z.object({
              pages: z.array(PageSchema),
              history: z.array(PageSchema),
              attempts: z.array(
                z.object({
                  id: z.string(),
                  contribution_id: z.string(),
                  outcome: z.string(),
                  summary: z.string(),
                  created_at: z.number(),
                }),
              ),
              contributions: z.array(
                z.object({
                  id: z.string(),
                  project_id: z.string().nullable(),
                  source_id: z.string(),
                  version: z.string(),
                  status: z.string(),
                  attempts: z.number(),
                  task_id: z.string().nullable(),
                  summary: z.string().nullable(),
                }),
              ),
            }),
          },
        },
      },
    },
  }),
  async (c) => {
    const { project_id, slug } = c.req.valid("query");
    const wiki = new WikiStore(getSqlite());
    return c.json(
      {
        pages: wiki.list(project_id ?? null),
        history: slug ? wiki.history(project_id ?? null, slug) : [],
        contributions: wiki.contributions(project_id ?? null),
        attempts: wiki.attempts(project_id ?? null),
      },
      200,
    );
  },
);
app.openapi(
  createRoute({
    method: "post",
    path: "/knowledge/wiki/apply",
    tags: ["Knowledge"],
    request: { body: { content: { "application/json": { schema: WikiOutcomeSchema } } } },
    responses: {
      200: {
        description: "Outcome recorded",
        content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } },
      },
    },
  }),
  async (c) => {
    new WikiStore(getSqlite()).apply(c.req.valid("json"));
    return c.json({ ok: true as const }, 200);
  },
);
app.openapi(
  createRoute({
    method: "post",
    path: "/skills/proposals",
    tags: ["Skills"],
    request: { body: { content: { "application/json": { schema: SkillProposalSchema } } } },
    responses: {
      201: {
        description: "Proposal retained",
        content: { "application/json": { schema: z.object({ id: z.string() }) } },
      },
    },
  }),
  async (c) => c.json({ id: new WikiStore(getSqlite()).propose(c.req.valid("json")) }, 201),
);
app.openapi(
  createRoute({
    method: "post",
    path: "/skills/evaluations",
    tags: ["Skills"],
    request: { body: { content: { "application/json": { schema: SkillEvaluationSchema } } } },
    responses: {
      201: {
        description: "Evaluation retained",
        content: {
          "application/json": { schema: z.object({ id: z.string(), result: z.string() }) },
        },
      },
    },
  }),
  async (c) => c.json(new WikiStore(getSqlite()).evaluate(c.req.valid("json")), 201),
);
app.openapi(
  createRoute({
    method: "get",
    path: "/skills/proposals",
    tags: ["Skills"],
    request: { query: projectQuery },
    responses: {
      200: {
        description: "Proposals and retained evaluations",
        content: {
          "application/json": {
            schema: z.object({
              proposals: z.array(
                z.object({
                  id: z.string(),
                  skill_name: z.string(),
                  status: z.string(),
                  decision: z.string().nullable(),
                  payload: z.string(),
                }),
              ),
              evaluations: z.array(
                z.object({
                  id: z.string(),
                  proposal_id: z.string(),
                  payload: z.string(),
                  result: z.string(),
                }),
              ),
            }),
          },
        },
      },
    },
  }),
  async (c) => {
    const project = c.req.valid("query").project_id ?? null;
    new WikiStore(getSqlite());
    const proposals = getSqlite()
      .query<
        {
          id: string;
          skill_name: string;
          status: string;
          decision: string | null;
          payload: string;
        },
        [string | null]
      >(
        "SELECT id,skill_name,status,decision,payload FROM skill_proposals WHERE project_id IS ? ORDER BY created_at DESC LIMIT 100",
      )
      .all(project);
    const evaluations = getSqlite()
      .query<{ id: string; proposal_id: string; payload: string; result: string }, [string | null]>(
        "SELECT e.id,e.proposal_id,e.payload,e.result FROM skill_evaluations e JOIN skill_proposals p ON p.id=e.proposal_id WHERE p.project_id IS ? ORDER BY e.created_at DESC LIMIT 500",
      )
      .all(project);
    return c.json({ proposals, evaluations }, 200);
  },
);
app.openapi(
  createRoute({
    method: "post",
    path: "/skills/proposals/reject",
    tags: ["Skills"],
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              id: z.string(),
              project_id: z.string().nullable(),
              reason: z.string().trim().min(1).max(4000),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Rejection retained",
        content: { "application/json": { schema: z.object({ ok: z.literal(true) }) } },
      },
    },
  }),
  async (c) => {
    const input = c.req.valid("json");
    new WikiStore(getSqlite()).reject(input.id, input.project_id, input.reason);
    return c.json({ ok: true as const }, 200);
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/skills/evolution",
    tags: ["Skills"],
    request: { query: projectQuery },
    responses: {
      200: {
        description: "Automatic promotion and revert history",
        content: {
          "application/json": {
            schema: z.object({
              history: z.array(
                z.object({
                  id: z.string(),
                  skill_name: z.string(),
                  proposal_id: z.string().nullable(),
                  evaluation_id: z.string().nullable(),
                  raw: z.string(),
                  previous_raw: z.string(),
                  active: z.number(),
                  action: z.string(),
                  reason: z.string(),
                  created_at: z.number(),
                }),
              ),
            }),
          },
        },
      },
    },
  }),
  async (c) => {
    const project = c.req.valid("query").project_id ?? null;
    new WikiStore(getSqlite());
    const projectKey = project === null ? "global:" : `project:${project}`;
    const history = getSqlite()
      .query<
        {
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
        },
        [string]
      >(
        "SELECT id,skill_name,proposal_id,evaluation_id,raw,previous_raw,active,action,reason,created_at FROM skill_activations WHERE project_key=? ORDER BY created_at DESC,id DESC LIMIT 100",
      )
      .all(projectKey);
    return c.json({ history }, 200);
  },
);
app.openapi(
  createRoute({
    method: "post",
    path: "/skills/evolution/revert",
    tags: ["Skills"],
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              id: z.string(),
              project_id: z.string().nullable(),
              reason: z.string().trim().min(1).max(4000),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Reverted current version, history retained",
        content: { "application/json": { schema: z.object({ id: z.string() }) } },
      },
    },
  }),
  async (c) => {
    const input = c.req.valid("json");
    return c.json({ id: revertSkill(getSqlite(), input.id, input.project_id, input.reason) }, 200);
  },
);
app.openapi(
  createRoute({
    method: "get",
    path: "/skills/evolution/baseline",
    tags: ["Skills"],
    request: { query: z.object({ name: z.string(), project_id: z.string().optional() }) },
    responses: {
      200: {
        description: "Active baseline package identity",
        content: {
          "application/json": {
            schema: z.object({ hash: z.string(), base_hash: z.string(), raw: z.string() }),
          },
        },
      },
    },
  }),
  async (c) => {
    const input = c.req.valid("query");
    const snapshot = getSkillSnapshot(getSqlite(), input.name, input.project_id ?? null);
    return c.json({ hash: snapshot.hash, base_hash: snapshot.base_hash, raw: snapshot.raw }, 200);
  },
);

export { app as wikiRouter };

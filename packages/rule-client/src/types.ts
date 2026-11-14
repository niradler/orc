export type OrcRule = {
  id: string;
  reason: string;
  kind: "event";
  enabled: boolean;
  scope: { agents: "all" | string[]; events: string[] };
  filter: { match: "all" | "any"; conditions: unknown[] };
  target: { type: string; expires_in_seconds?: number; [key: string]: unknown };
};

export type OrcRulePolicy = {
  workspace: string;
  project_id: string | null;
  rules: OrcRule[];
};

export type OrcRuleRevision = {
  id: string;
  workspace: string;
  project_id: string | null;
  policy: OrcRulePolicy | null;
  current: boolean;
};

export type HookDecision = {
  block: boolean;
  reason?: string;
  context?: string;
  updatedInput?: Record<string, unknown>;
};

export type RulePlan<Native extends string = string> = {
  events: Set<Native>;
  timeoutMs: Map<Native, number>;
  count: number;
};

export type HookRun<Native extends string = string> = {
  command: string;
  native: Native;
  payload: Record<string, unknown>;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
};

export type RuleGateInput<Native extends string = string> = {
  enabled: boolean;
  plan: RulePlan<Native> | undefined;
  disabled: boolean;
  native: Native;
};

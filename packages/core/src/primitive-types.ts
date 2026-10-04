export type AgentFields = Record<string, unknown> & {
  name?: string | undefined;
  description: string;
  model?: string | undefined;
  tools?: Record<string, boolean> | string[] | string | undefined;
  color?: string | undefined;
  handoffs?:
    | Array<
        | string
        | (Record<string, unknown> & {
            agent: string;
            label?: string | undefined;
            prompt?: string | undefined;
            send?: boolean | undefined;
          })
      >
    | undefined;
};
export type AgentProfile = {
  id: string;
  name: string;
  description: string;
  source: "user" | "project" | "package";
  path: string;
  fields: AgentFields;
};
export type AgentFull = AgentProfile & { content: string; raw: string };
export type BrokenAgent = { path: string; error: string };
export type ApmManifest = Record<string, unknown> & {
  name: string;
  version: string;
  description?: string;
};
export type PackageMeta = {
  name: string;
  version: string;
  description: string;
  path: string;
  manifest: ApmManifest;
};
export type PackageFull = PackageMeta & {
  content: string;
  files: Array<{ name: string; path: string }>;
};

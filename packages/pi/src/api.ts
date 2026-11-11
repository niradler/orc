import type { OrcRulePolicy, OrcRuleRevision } from "./rules.js";

export type OrcJobInput = {
  name: string;
  description?: string;
  trigger_type: "cron";
  cron_expr: string;
  enabled: boolean;
  action: { type: "agent"; prompt: string; backend: string; auto_approve?: boolean };
  working_dir?: string;
  project_id?: string | null;
};

export type OrcJob = {
  id: string;
  name: string;
  enabled: boolean;
  trigger_type: string;
  cron_expr: string | null;
  next_run_at: string | null;
  project_id: string | null;
  run_count?: number;
};

export type OrcProjectRoot = {
  project_id: string;
  project_name: string;
  root: string;
  folders: Array<{ agent: string; label: string; dir: string; skills: number }>;
};

export class OrcApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "OrcApiError";
  }
}

function withQuery(path: string, query: string): string {
  return query ? `${path}?${query}` : path;
}

export class OrcApiClient {
  constructor(
    private readonly base: string,
    private readonly secret: string | undefined,
    private readonly timeoutMs: number,
    private readonly secretSource?: string,
  ) {}

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.secret) headers.set("Authorization", `Bearer ${this.secret}`);
    headers.set("Accept", "application/json");
    let response: Response;
    try {
      response = await fetch(`${this.base}/api${path}`, {
        ...init,
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new OrcApiError(
        `Cannot reach ORC at ${this.base}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      let message = body.trim();
      try {
        const parsed = JSON.parse(body) as { error?: { message?: string } | string };
        if (typeof parsed.error === "string") message = parsed.error;
        else if (parsed.error?.message) message = parsed.error.message;
      } catch {}
      const hint =
        response.status === 401
          ? ` (${this.secret ? `secret from ${this.secretSource ?? "config"} was rejected; set PORC_API_SECRET to the secret of ${this.base}` : `no secret configured; set PORC_API_SECRET or api.secret in ~/.orc/config.json`})`
          : "";
      throw new OrcApiError(
        `/api${path} failed (${response.status})${message ? `: ${message.slice(0, 500)}` : ""}${hint}`,
        response.status,
      );
    }
    return response;
  }

  private async json<T>(path: string): Promise<T> {
    return (await (await this.request(path)).json()) as T;
  }

  private async send<T>(path: string, body: unknown, method = "POST"): Promise<T> {
    const response = await this.request(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await response.json()) as T;
  }

  async createProject(input: {
    name: string;
    scope?: string;
    description?: string;
  }): Promise<{ id: string; name: string }> {
    return this.send("/projects", input);
  }

  async createJob(input: OrcJobInput): Promise<OrcJob> {
    return this.send("/jobs", input);
  }

  async listJobs(projectId?: string): Promise<OrcJob[]> {
    const query = projectId
      ? `?project_id=${encodeURIComponent(projectId)}&limit=100`
      : "?limit=100";
    return (await this.json<{ jobs: OrcJob[] }>(`/jobs${query}`)).jobs;
  }

  async rules(workspace?: string): Promise<{ enabled: boolean; history: OrcRuleRevision[] }> {
    return this.json(
      withQuery("/rules", workspace ? `workspace=${encodeURIComponent(workspace)}` : ""),
    );
  }

  async activateRules(
    policy: OrcRulePolicy,
    expectedId: string | null,
    reason: string,
  ): Promise<OrcRuleRevision> {
    return this.send("/rules/activate", { policy, expected_id: expectedId, reason });
  }

  async health(): Promise<boolean> {
    try {
      const response = await fetch(`${this.base}/api/health`, {
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, 1500)),
        headers: this.secret ? { Authorization: `Bearer ${this.secret}` } : {},
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async projectRoots(): Promise<OrcProjectRoot[]> {
    const data = await this.json<{ projects: OrcProjectRoot[] }>("/skills/project-folders");
    return data.projects;
  }
}

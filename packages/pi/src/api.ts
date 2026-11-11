export type OrcSkillRef = {
  name: string;
  path: string;
  size?: number;
};

export type OrcSkill = {
  name: string;
  description: string;
  source: "builtin" | "user" | string;
  path?: string;
  project_ids?: string[];
  content: string;
  references?: OrcSkillRef[];
  files?: OrcSkillRef[];
};

export type OrcSkillFile = {
  name: string;
  path: string;
  content: string;
  encoding: "utf8" | "base64" | string;
};

export type OrcSkillListItem = {
  name: string;
  description: string;
  source: string;
  project_ids: string[];
};

export type OrcProjectRoot = {
  project_id: string;
  project_name: string;
  root: string;
  folders: Array<{ agent: string; label: string; dir: string; skills: number }>;
};

type Scope = { projectId?: string; global?: boolean };

export class OrcApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "OrcApiError";
  }
}

function scopeQuery(scope: Scope): string {
  if (scope.projectId) return `project_id=${encodeURIComponent(scope.projectId)}`;
  if (scope.global) return "scope=global";
  return "";
}

function withQuery(path: string, query: string): string {
  return query ? `${path}?${query}` : path;
}

export class OrcApiClient {
  constructor(
    private readonly base: string,
    private readonly secret: string | undefined,
    private readonly timeoutMs: number,
  ) {}

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.secret) headers.set("Authorization", `Bearer ${this.secret}`);
    headers.set("Accept", "application/json");
    let response: Response;
    try {
      response = await fetch(`${this.base}${path}`, {
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
      } catch {
        // Plain-text errors are already handled.
      }
      throw new OrcApiError(
        `${path} failed (${response.status})${message ? `: ${message.slice(0, 500)}` : ""}`,
        response.status,
      );
    }
    return response;
  }

  private async json<T>(path: string): Promise<T> {
    return (await (await this.request(path)).json()) as T;
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

  async projectIdByName(name: string): Promise<string | undefined> {
    try {
      const data = await this.json<{ id?: string; project?: { id?: string } }>(
        `/projects/by-name/${encodeURIComponent(name)}`,
      );
      return data.id ?? data.project?.id;
    } catch (err) {
      if (err instanceof OrcApiError && err.status === 404) return undefined;
      throw err;
    }
  }

  async listSkills(): Promise<OrcSkillListItem[]> {
    const data = await this.json<{ skills: OrcSkillListItem[] }>("/skills?scope=all&limit=500");
    return data.skills;
  }

  async readSkill(name: string, scope: Scope = {}): Promise<OrcSkill> {
    return this.json<OrcSkill>(withQuery(`/skills/${encodeURIComponent(name)}`, scopeQuery(scope)));
  }

  async readSkillFile(name: string, ref: string, scope: Scope = {}): Promise<OrcSkillFile> {
    const query = [scopeQuery(scope), `ref=${encodeURIComponent(ref)}`].filter(Boolean).join("&");
    return this.json<OrcSkillFile>(withQuery(`/skills/${encodeURIComponent(name)}`, query));
  }
}

import { posix, win32 } from "node:path";
import { ValidationError } from "@orc/core/errors";
import type { SessionBundle, SessionHandoffRequest } from "@orc/core/session-handoff";

export interface ImportedFile {
  path: string;
  content: string;
}

export interface HandoffAdapter {
  validate(bundle: SessionBundle, request: SessionHandoffRequest): void;
  installFiles(
    bundle: SessionBundle,
    request: SessionHandoffRequest,
    sessionId: string,
    cwd: string,
    home: string,
    createdAt: Date,
    nativeRoot?: string,
  ): ImportedFile[];
}

function records(content: string): Record<string, unknown>[] {
  const parsed: Record<string, unknown>[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new ValidationError("Session file contains invalid JSONL");
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new ValidationError("Session records must be JSON objects");
    parsed.push(value as Record<string, unknown>);
  }
  if (!parsed.length) throw new ValidationError("Session file is empty");
  return parsed;
}

function mainFile(bundle: SessionBundle): ImportedFile {
  const file = bundle.files.find((entry) => entry.path === "session.jsonl");
  if (!file) throw new ValidationError("Upload must contain session.jsonl");
  return file;
}

function jsonl(rows: Record<string, unknown>[]): string {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function validatePaths(bundle: SessionBundle, sidecars: boolean): void {
  const seen = new Set<string>();
  for (const file of bundle.files) {
    if (seen.has(file.path)) throw new ValidationError("Duplicate session file");
    seen.add(file.path);
    if (
      file.path !== "session.jsonl" &&
      !(sidecars && /^subagents\/agent-[A-Za-z0-9_-]+\.jsonl$/.test(file.path))
    )
      throw new ValidationError("Unsupported session file path");
  }
  mainFile(bundle);
}

export const handoffAdapters: Record<SessionHandoffRequest["agent"], HandoffAdapter> = {
  claude: {
    validate(bundle, request) {
      validatePaths(bundle, true);
      const rows = records(mainFile(bundle).content);
      if (
        !rows.some(
          (row) =>
            row.sessionId === request.session_id &&
            ["user", "assistant"].includes(String(row.type)),
        )
      )
        throw new ValidationError("Claude transcript does not match the source session");
      if (
        rows.some(
          (row) => typeof row.sessionId === "string" && row.sessionId !== request.session_id,
        )
      )
        throw new ValidationError("Claude transcript mixes session IDs");
      for (const file of bundle.files) records(file.content);
    },
    installFiles(bundle, request, sessionId, cwd, home, _createdAt, nativeRoot) {
      const paths = home.startsWith("/") ? posix : win32;
      const projectKey = cwd.replace(/[^a-zA-Z0-9]/g, "-");
      const root = paths.join(nativeRoot ?? paths.join(home, ".claude"), "projects", projectKey);
      return [
        mainFile(bundle),
        ...bundle.files.filter((file) => file.path !== "session.jsonl"),
      ].map((file) => ({
        path:
          file.path === "session.jsonl"
            ? paths.join(root, `${sessionId}.jsonl`)
            : paths.join(root, sessionId, file.path),
        content: jsonl(
          records(file.content).map((row) => ({
            ...row,
            ...(row.sessionId === request.session_id ? { sessionId } : {}),
            ...(typeof row.cwd === "string" ? { cwd } : {}),
          })),
        ),
      }));
    },
  },
  codex: {
    validate(bundle, request) {
      validatePaths(bundle, false);
      const rows = records(mainFile(bundle).content);
      const first = rows[0];
      const meta = object(first?.payload);
      if (first?.type !== "session_meta" || meta?.id !== request.session_id)
        throw new ValidationError("Codex rollout does not match the source session");
      if (object(meta.source)?.subagent || meta.parent_thread_id)
        throw new ValidationError(
          "Hand off the parent Codex session; standalone child-agent imports are not supported",
        );
      if (rows.filter((row) => row.type === "session_meta").length !== 1)
        throw new ValidationError("Codex rollout must contain one session_meta record");
    },
    installFiles(bundle, _request, sessionId, cwd, home, createdAt, nativeRoot) {
      const paths = home.startsWith("/") ? posix : win32;
      const now = createdAt.toISOString();
      const date = now.slice(0, 10).split("-");
      const stamp = now.slice(0, 19).replace(/:/g, "-");
      return [
        {
          path: paths.join(
            nativeRoot ?? paths.join(home, ".codex"),
            "sessions",
            ...date,
            `rollout-${stamp}-${sessionId}.jsonl`,
          ),
          content: jsonl(
            records(mainFile(bundle).content).map((row) => {
              const payload = object(row.payload);
              if (row.type === "session_meta" && payload)
                return {
                  ...row,
                  payload: {
                    ...payload,
                    id: sessionId,
                    cwd,
                    ...(typeof payload.session_id === "string" ? { session_id: sessionId } : {}),
                    ...(Array.isArray(payload.runtime_workspace_roots)
                      ? { runtime_workspace_roots: [cwd] }
                      : {}),
                  },
                };
              if (row.type === "turn_context" && payload) {
                const sandbox = object(payload.sandbox_policy);
                return {
                  ...row,
                  payload: {
                    ...payload,
                    cwd,
                    ...(sandbox && Array.isArray(sandbox.writable_roots)
                      ? { sandbox_policy: { ...sandbox, writable_roots: [cwd] } }
                      : {}),
                  },
                };
              }
              return row;
            }),
          ),
        },
      ];
    },
  },
};

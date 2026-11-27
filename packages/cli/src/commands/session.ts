import { configuredApiSecret, loadConfig, resolveApiBase } from "@orc/core/config";
import { shortId } from "@orc/core/ids";
import { Command } from "commander";
import { isJson, jsonOut } from "../output.js";

type SessionRow = {
  id: string;
  agent: string;
  project_id: string | null;
  summary: string | null;
  tokens_used: number | null;
  created_at: string;
};

type EventRow = {
  id: string;
  type: string;
  priority: number;
  data: string;
  created_at: string;
};

type SessionDetail = SessionRow & {
  snapshot: string | null;
  events: EventRow[];
};

function formatAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function apiBase(): string {
  try {
    return `${resolveApiBase()}/api`;
  } catch {
    return "http://127.0.0.1:7700/api";
  }
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const secret =
    process.env.ORC_API_SECRET ??
    (() => {
      try {
        return loadConfig().api.secret;
      } catch {
        return undefined;
      }
    })();
  const bearer = configuredApiSecret(secret);
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  return headers;
}

type LiveSessionDetail = {
  id: string;
  agent: string;
  session_id: string | null;
  name: string | null;
  summary: string | null;
  cwd: string | null;
  status: string;
  project_id: string | null;
  last_activity_at: string | null;
  created_at: string;
};

type LiveSessionStatus = {
  session_id: string;
  title: string;
  agent: string;
  status: string;
  waiting_for: string | null;
  last_message: string | null;
  project_id: string | null;
  cwd: string;
  started_at: number | null;
  updated_at: number;
  last_activity_at?: number | null;
  last_activity?: string | null;
  activity_count?: number;
  start_error?: string | null;
  native_session_id?: string | null;
  live_session_id?: string | null;
};

async function resolveLiveCandidateId(id: string): Promise<string> {
  if (id.length < 6 || id.length >= 26) return id;
  const listRes = await fetch(
    `${apiBase()}/sessions/live?active=false&include_hidden=true&limit=500`,
    {
      headers: authHeaders(),
    },
  ).catch(() => null);
  if (!listRes?.ok) return id;
  const body = (await listRes.json()) as { sessions?: LiveSessionDetail[] };
  const matches = (body.sessions ?? []).filter(
    (row) =>
      row.id === id ||
      row.id.endsWith(id) ||
      row.id.startsWith(id) ||
      row.session_id === id ||
      row.session_id?.startsWith(id),
  );
  return matches.length === 1 && matches[0] ? matches[0].id : id;
}

async function showLiveSession(id: string): Promise<boolean> {
  const headers = authHeaders();
  let targetId = id;
  let statusRes = await fetch(`${apiBase()}/sessions/live/${encodeURIComponent(targetId)}/status`, {
    headers,
  }).catch(() => null);
  if (statusRes?.status === 404) {
    const candidate = await resolveLiveCandidateId(id);
    if (candidate !== targetId) {
      targetId = candidate;
      statusRes = await fetch(`${apiBase()}/sessions/live/${encodeURIComponent(targetId)}/status`, {
        headers,
      }).catch(() => null);
    }
  }
  const liveRes = await fetch(`${apiBase()}/sessions/live/${encodeURIComponent(targetId)}`, {
    headers,
  }).catch(() => null);

  const statusBody = statusRes?.ok ? ((await statusRes.json()) as LiveSessionStatus) : null;
  const liveBody = liveRes?.ok ? ((await liveRes.json()) as LiveSessionDetail) : null;
  if (!statusBody && !liveBody) return false;

  if (isJson()) {
    jsonOut(statusBody ? { ...statusBody, ...(liveBody ? { live: liveBody } : {}) } : liveBody);
    return true;
  }

  const sessionId = statusBody?.session_id ?? liveBody?.id ?? id;
  const agent = statusBody?.agent ?? liveBody?.agent ?? "unknown";
  const status = statusBody?.status ?? liveBody?.status ?? "unknown";
  const title = statusBody?.title ?? liveBody?.name ?? null;
  const projectId = statusBody?.project_id ?? liveBody?.project_id ?? null;
  const cwd = statusBody?.cwd || liveBody?.cwd || null;
  const nativeId = statusBody?.native_session_id ?? liveBody?.session_id ?? null;
  const liveId = statusBody?.live_session_id ?? liveBody?.id ?? null;
  const lastActivityMs =
    statusBody?.last_activity_at ??
    (liveBody?.last_activity_at ? Date.parse(liveBody.last_activity_at) : null);

  console.log(`Session:  ${sessionId}`);
  if (liveId && liveId !== sessionId) console.log(`Live ID:  ${liveId}`);
  if (nativeId && nativeId !== sessionId) console.log(`Native:   ${nativeId}`);
  console.log(`Agent:    ${agent}`);
  console.log(
    `Status:   ${status}${statusBody?.waiting_for ? ` (${statusBody.waiting_for})` : ""}`,
  );
  if (title) console.log(`Title:    ${title}`);
  if (projectId) console.log(`Project:  ${projectId}`);
  if (cwd) console.log(`CWD:      ${cwd}`);
  if (lastActivityMs && Number.isFinite(lastActivityMs)) {
    const iso = new Date(lastActivityMs).toISOString();
    console.log(
      `Activity: ${new Date(lastActivityMs).toLocaleString()} (${formatAgo(iso)})${statusBody?.last_activity ? ` [${statusBody.last_activity}]` : ""}`,
    );
  }
  if (statusBody?.start_error) {
    console.log("\nError:");
    console.log(`  ${statusBody.start_error}`);
  }
  const msg = statusBody?.last_message ?? liveBody?.summary ?? null;
  if (msg && msg !== statusBody?.start_error) {
    console.log("\nLast message:");
    console.log(`  ${msg}`);
  }
  return true;
}

export function sessionCommand() {
  const cmd = new Command("session").description("View session history");

  cmd
    .command("list")
    .description("List recent sessions")
    .option("-a, --agent <agent>", "Filter by agent (claude-code, cursor, codex)")
    .option("-n, --limit <n>", "Max results", "20")
    .action(async (opts: { agent?: string; limit: string }) => {
      const qs = new URLSearchParams({ limit: opts.limit });
      if (opts.agent) qs.set("agent", opts.agent);

      let res: Response;
      try {
        res = await fetch(`${apiBase()}/sessions?${qs}`, {
          headers: authHeaders(),
        });
      } catch {
        return console.error("Cannot connect to orc API. Is it running? (orc api or orc daemon)");
      }

      if (!res.ok) return console.error(`API error: ${res.status}`);
      const body = (await res.json()) as { sessions: SessionRow[] };
      const rows = body.sessions;

      if (isJson()) return jsonOut({ sessions: rows });
      if (rows.length === 0) return console.log("No sessions recorded yet.");

      console.log(`${"ID".padEnd(8)}  ${"AGENT".padEnd(16)}  ${"WHEN".padEnd(10)}  SUMMARY`);
      console.log("─".repeat(72));
      for (const s of rows) {
        const id = shortId(s.id);
        const agent = s.agent.padEnd(16);
        const when = formatAgo(s.created_at).padEnd(10);
        const summary = (s.summary ?? "-").slice(0, 40);
        console.log(`${id}  ${agent}  ${when}  ${summary}`);
      }
    });

  cmd
    .command("show <id>")
    .description("Show session detail (recorded, live, chat UUID, or native session id)")
    .option("-e, --events", "Show recorded events")
    .option("-s, --snapshot", "Show snapshot XML")
    .option("-n, --limit <n>", "Max events to show", "50")
    .action(async (id: string, opts: { events?: boolean; snapshot?: boolean; limit: string }) => {
      let resolvedId = id;
      if (id.length < 26) {
        const listRes = await fetch(`${apiBase()}/sessions?limit=100`, {
          headers: authHeaders(),
        }).catch(() => null);
        if (listRes?.ok) {
          const body = (await listRes.json()) as { sessions: SessionRow[] };
          const match = body.sessions.find((s) => s.id.endsWith(id) || s.id === id);
          if (match) resolvedId = match.id;
        }
      }

      let res: Response;
      try {
        res = await fetch(`${apiBase()}/sessions/${encodeURIComponent(resolvedId)}`, {
          headers: authHeaders(),
        });
      } catch {
        return console.error("Cannot connect to orc API.");
      }

      if (res.status === 404) {
        const liveShown = await showLiveSession(id);
        if (liveShown) return;
        process.exitCode = 1;
        return console.error(`Session not found: ${id}`);
      }
      if (!res.ok) return console.error(`API error: ${res.status}`);

      const s = (await res.json()) as SessionDetail;

      if (isJson()) return jsonOut(s);
      console.log(`Session: ${s.id}`);
      console.log(`Agent:   ${s.agent}`);
      console.log(
        `When:    ${new Date(s.created_at).toLocaleString()} (${formatAgo(s.created_at)})`,
      );
      if (s.project_id) console.log(`Project: ${s.project_id}`);
      if (s.tokens_used) console.log(`Tokens:  ${s.tokens_used}`);
      if (s.summary) {
        console.log("\nSummary:");
        console.log(`  ${s.summary}`);
      }

      if (opts.events && s.events.length > 0) {
        const maxEvents = Number(opts.limit);
        const shown = s.events.slice(0, maxEvents);
        console.log(`\nEvents (${shown.length}/${s.events.length}):`);
        const icons: Record<string, string> = {
          file: "📄",
          task: "✓",
          decision: "💡",
          git: "⎇",
          error: "✗",
          env: "⚙",
          rule: "📌",
          plan: "📋",
          intent: "→",
          subagent: "◎",
        };
        for (const e of shown) {
          const icon = icons[e.type] ?? "·";
          const when = new Date(e.created_at).toLocaleTimeString();
          const parsed = (() => {
            try {
              const d = JSON.parse(e.data) as Record<string, string>;
              return Object.entries(d)
                .map(([k, v]) => `${k}=${String(v).slice(0, 50)}`)
                .join(" ");
            } catch {
              return e.data.slice(0, 80);
            }
          })();
          console.log(`  ${icon} [${e.type.padEnd(10)}] ${when}  ${parsed}`);
        }
      }

      if (opts.snapshot && s.snapshot) {
        console.log("\nSnapshot:");
        console.log(s.snapshot);
      } else if (opts.snapshot && !s.snapshot) {
        console.log("\nNo snapshot stored for this session.");
      }
    });

  cmd
    .command("log <summary>")
    .description("Log a session summary")
    .option("-a, --agent <name>", "Agent name", "human")
    .option("--agent-version <v>", "Agent version string")
    .action(async (summary: string, opts) => {
      const config = loadConfig();
      const base = `${resolveApiBase(config)}/api`;
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (config.api.secret) headers.Authorization = `Bearer ${config.api.secret}`;

      const res = await fetch(`${base}/sessions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          agent: opts.agent,
          ...(opts.agentVersion ? { agent_version: opts.agentVersion } : {}),
          summary,
        }),
      });

      const body = (await res.json()) as { id?: string; error?: string };
      if (!res.ok) return console.error("Error:", body.error);
      if (isJson()) return jsonOut(body);
      console.log(`Session logged: ${body.id}`);
    });

  return cmd;
}

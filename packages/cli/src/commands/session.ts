import { loadConfig } from "@orc/core/config";
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
    const c = loadConfig();
    return `http://${c.api.host}:${c.api.port}/api`;
  } catch {
    return `${process.env.ORC_API_BASE ?? "http://127.0.0.1:7700"}/api`;
  }
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const secret =
    process.env.ORC_API_SECRET ??
    (() => {
      try {
        return loadConfig().api.secret;
      } catch {
        return undefined;
      }
    })();
  if (secret) headers.Authorization = `Bearer ${secret}`;
  return headers;
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
        res = await fetch(`${apiBase()}/sessions?${qs}`, { headers: authHeaders() });
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
    .description("Show session detail with events")
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
        res = await fetch(`${apiBase()}/sessions/${resolvedId}`, { headers: authHeaders() });
      } catch {
        return console.error("Cannot connect to orc API.");
      }

      if (res.status === 404) return console.error(`Session not found: ${id}`);
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
    .description("Log a session summary (calls session_log MCP tool)")
    .option("-a, --agent <name>", "Agent name", "human")
    .option("--agent-version <v>", "Agent version string")
    .action(async (summary: string, opts) => {
      const config = loadConfig();
      const base = `http://${config.api.host}:${config.api.port}/api`;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (config.api.secret) headers.Authorization = `Bearer ${config.api.secret}`;

      const res = await fetch(`${base}/mcp/tool`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: "session_log",
          args: {
            agent: opts.agent,
            agent_version: opts.agentVersion,
            summary,
          },
        }),
      });

      const body = (await res.json()) as { result?: string; error?: string };
      if (!res.ok) return console.error("Error:", body.error);
      if (isJson()) return jsonOut(body);
      console.log(body.result);
    });

  return cmd;
}

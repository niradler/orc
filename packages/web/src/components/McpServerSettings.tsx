import { CheckCircle, Copy } from "lucide-react";
import { useMemo, useState } from "react";
import { getApiSecret, getApiUrl } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useProjects } from "@/hooks/useProjects";
import {
  ENV_NAME,
  MCP_CLIENT_LABELS,
  MCP_CLIENTS,
  type McpClient,
  mcpBaseUrl,
  mcpSnippet,
  SERVER_NAME,
} from "@/lib/mcp-connection";

const row = "grid gap-4 border-b border-border py-5 lg:grid-cols-[minmax(160px,1fr)_minmax(0,2fr)]";

export function McpServerSettings() {
  const { data: projects = [] } = useProjects();
  const [baseUrl, setBaseUrl] = useState(() => mcpBaseUrl(getApiUrl(), window.location.origin));
  const [mode, setMode] = useState<"meta" | "full">("meta");
  const [selected, setSelected] = useState<string[]>([]);
  const [client, setClient] = useState<McpClient>("claude-json");
  const [name, setName] = useState("orc");
  const [useSecret, setUseSecret] = useState(() => Boolean(getApiSecret()));
  const [secretEnv, setSecretEnv] = useState("ORC_API_SECRET");
  const [status, setStatus] = useState("");

  const error = useMemo(() => {
    try {
      if (!/^https?:$/.test(new URL(baseUrl).protocol)) return "Use an http(s) endpoint URL.";
    } catch {
      return "Enter a full endpoint URL, e.g. http://localhost:7700/mcp.";
    }
    if (!SERVER_NAME.test(name)) return "Server name allows letters, digits, - and _.";
    if (useSecret && !ENV_NAME.test(secretEnv)) return "Enter a valid environment variable name.";
    return "";
  }, [baseUrl, name, useSecret, secretEnv]);

  const snippet = error
    ? ""
    : mcpSnippet(client, {
        baseUrl,
        mode,
        projects: selected,
        name,
        secretEnv: useSecret ? secretEnv : "",
      });

  async function copy() {
    try {
      await navigator.clipboard.writeText(snippet);
      setStatus(`${MCP_CLIENT_LABELS[client]} copied.`);
    } catch {
      setStatus("Copy failed. Select the text and copy it manually.");
    }
  }

  function edit<T>(set: (value: T) => void) {
    return (value: T) => {
      set(value);
      setStatus("");
    };
  }

  return (
    <section aria-labelledby="mcp-server-title" data-testid="settings-mcp">
      <h2 id="mcp-server-title" className="mb-1 text-base font-medium">
        MCP server
      </h2>
      <p className="text-sm text-muted-foreground">
        Build the connection for an agent. Options become query parameters on the ORC endpoint;
        nothing here changes the server.
      </p>
      <div className={row}>
        <div>
          <Label htmlFor="mcp-base-url">Endpoint</Label>
          <p className="mt-1 text-xs text-muted-foreground">
            Change the host when the agent reaches ORC by another address.
          </p>
        </div>
        <Input
          id="mcp-base-url"
          data-testid="mcp-base-url"
          value={baseUrl}
          onChange={(event) => edit(setBaseUrl)(event.target.value.trim())}
        />
      </div>
      <div className={row}>
        <div>
          <span className="text-sm font-medium">Tool surface</span>
          <p className="mt-1 text-xs text-muted-foreground">
            Meta serves search, describe and invoke so agents load schemas on demand.
          </p>
        </div>
        <fieldset aria-label="Tool surface" className="flex flex-wrap gap-2">
          {(["meta", "full"] as const).map((value) => (
            <Button
              key={value}
              variant={mode === value ? "secondary" : "outline"}
              aria-pressed={mode === value}
              data-testid={`mcp-mode-${value}`}
              onClick={() => edit(setMode)(value)}
            >
              {value === "meta" ? "Meta tools" : "All tools"}
            </Button>
          ))}
        </fieldset>
      </div>
      <div className={row}>
        <div>
          <span className="text-sm font-medium">Projects</span>
          <p className="mt-1 text-xs text-muted-foreground">
            No selection serves every project. Selected projects scope project-aware tools.
          </p>
        </div>
        <details>
          <summary className="min-h-11 cursor-pointer py-3 text-sm">
            {selected.length ? selected.join(", ") : "All projects"}
          </summary>
          <div className="flex flex-wrap gap-x-4">
            {projects.map((project) => (
              <label
                key={project.id}
                className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-sm"
              >
                <input
                  type="checkbox"
                  data-testid={`mcp-project-${project.name}`}
                  checked={selected.includes(project.name)}
                  onChange={(event) =>
                    edit(setSelected)(
                      event.target.checked
                        ? [...selected, project.name]
                        : selected.filter((value) => value !== project.name),
                    )
                  }
                  className="size-4 accent-primary"
                />
                {project.name}
              </label>
            ))}
          </div>
        </details>
      </div>
      <div className={row}>
        <div>
          <span className="text-sm font-medium">Authentication</span>
          <p className="mt-1 text-xs text-muted-foreground">
            The snippet names an environment variable; the secret itself is never shown.
          </p>
        </div>
        <div className="space-y-2">
          <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              data-testid="mcp-use-secret"
              checked={useSecret}
              onChange={(event) => edit(setUseSecret)(event.target.checked)}
              className="size-4 accent-primary"
            />
            Send the API secret as a bearer token
          </label>
          {useSecret && (
            <Input
              aria-label="Secret environment variable"
              data-testid="mcp-secret-env"
              value={secretEnv}
              onChange={(event) => edit(setSecretEnv)(event.target.value.trim())}
            />
          )}
        </div>
      </div>
      <div className={row}>
        <div>
          <Label htmlFor="mcp-client">Client</Label>
          <p className="mt-1 text-xs text-muted-foreground">Format to copy into the agent.</p>
        </div>
        <div className="grid gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <select
            id="mcp-client"
            data-testid="mcp-client"
            className="form-control form-control-single"
            value={client}
            onChange={(event) => edit(setClient)(event.target.value as McpClient)}
          >
            {MCP_CLIENTS.map((value) => (
              <option key={value} value={value}>
                {MCP_CLIENT_LABELS[value]}
              </option>
            ))}
          </select>
          <Input
            aria-label="Server name"
            data-testid="mcp-server-name"
            value={name}
            disabled={client === "url"}
            onChange={(event) => edit(setName)(event.target.value.trim())}
          />
        </div>
      </div>
      <div className="mt-5 space-y-3">
        {error ? (
          <p role="alert" className="text-sm text-error">
            {error}
          </p>
        ) : (
          <pre
            data-testid="mcp-snippet"
            className="overflow-x-auto whitespace-pre-wrap break-all rounded-md border border-border bg-surface p-3 font-mono text-[13px]"
          >
            {snippet}
          </pre>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button data-testid="mcp-copy" disabled={Boolean(error)} onClick={() => void copy()}>
            {status ? <CheckCircle size={14} /> : <Copy size={14} />}Copy
          </Button>
          {status && (
            <p role="status" className="text-sm text-muted-foreground">
              {status}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

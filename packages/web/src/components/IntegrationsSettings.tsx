import type { IntegrationConnection } from "@orc/sdk/types";
import { Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ConnectionEditor } from "@/components/ConnectionEditor";
import { ConnectionTools } from "@/components/ConnectionTools";
import { McpServerSettings } from "@/components/McpServerSettings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  useConnections,
  useRefreshConnection,
  useRemoveConnection,
  useSetConnectionEnabled,
} from "@/hooks/useIntegrations";
import { isMcpConnection } from "@/lib/connection-features";
import { connectionTypeLabel } from "@/lib/connection-source";
import { useViewParam } from "@/lib/view-params";

const tabs = ["mcp", "connections"] as const;
type Tab = (typeof tabs)[number];
const tabLabels: Record<Tab, string> = { mcp: "MCP server", connections: "Connections" };

export function IntegrationsSettings({ active }: { active: boolean }) {
  const [tab, setTab] = useViewParam<Tab>("integrationsTab", "mcp", tabs);
  return (
    <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)}>
      <TabsList aria-label="Integrations" className="mb-5">
        {tabs.map((value) => (
          <TabsTrigger key={value} value={value} data-testid={`integrations-tab-${value}`}>
            {tabLabels[value]}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value="mcp">
        <McpServerSettings />
      </TabsContent>
      <TabsContent value="connections">
        <ConnectionsSettings enabled={active && tab === "connections"} />
      </TabsContent>
    </Tabs>
  );
}

function ConnectionsSettings({ enabled }: { enabled: boolean }) {
  const { data, error, isLoading } = useConnections(enabled);
  const setEnabled = useSetConnectionEnabled();
  const refresh = useRefreshConnection();
  const remove = useRemoveConnection();
  // `null` opens the editor for a new connection.
  const [editing, setEditing] = useState<string | null | undefined>(undefined);
  const [browsing, setBrowsing] = useState<IntegrationConnection | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const actionError = setEnabled.error ?? refresh.error;
  return (
    <section aria-labelledby="connections-title" data-testid="settings-connections">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h2 id="connections-title" className="text-base font-medium">
          Connections
        </h2>
        <Button size="sm" data-testid="connection-add" onClick={() => setEditing(null)}>
          <Plus className="size-4" />
          Add connection
        </Button>
      </div>
      <p className="mb-4 text-sm text-muted-foreground">
        APIs and MCP servers in the <code>spec</code> CLI registry. ORC edits that registry
        directly, so changes here and from <code>spec</code> stay in step.
      </p>
      {isLoading && <p className="text-sm text-muted-foreground">Loading connections…</p>}
      {(error ?? actionError) && (
        <p role="alert" className="mb-3 text-sm text-error">
          {(error ?? actionError)?.message}
        </p>
      )}
      {refresh.data && (
        <p role="status" className="mb-3 text-sm text-muted-foreground">
          {refresh.data.name} refreshed: {refresh.data.count} tools.
        </p>
      )}
      {data && data.length === 0 && (
        <p className="text-sm text-muted-foreground">No connections yet.</p>
      )}
      {data && data.length > 0 && (
        <ul className="divide-y divide-border border-y border-border">
          {data.map((connection) => (
            <li
              key={connection.name}
              data-testid={`connection-${connection.name}`}
              className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 py-1"
            >
              <label className="flex min-h-11 items-center">
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  aria-label={`Enable ${connection.name}`}
                  checked={connection.enabled}
                  disabled={setEnabled.isPending}
                  onChange={(event) =>
                    setEnabled.mutate({ name: connection.name, enabled: event.target.checked })
                  }
                />
              </label>
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-sm font-medium">{connection.name}</span>
                <Badge variant="outline">{connectionTypeLabel(connection.type)}</Badge>
                {!connection.enabled && <Badge variant="outline">Disabled</Badge>}
                {connection.description && (
                  <span className="min-w-0 basis-full truncate text-xs text-muted-foreground sm:basis-auto">
                    {connection.description}
                  </span>
                )}
              </div>
              <div className="ml-auto flex items-center">
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="connection-tools"
                  onClick={() => setBrowsing(connection)}
                >
                  {isMcpConnection(connection.type) ? "Browse" : "Tools"}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Refresh ${connection.name}`}
                  disabled={!connection.enabled || refresh.isPending}
                  onClick={() => refresh.mutate(connection.name)}
                >
                  <RefreshCw
                    className={
                      refresh.isPending && refresh.variables === connection.name
                        ? "size-4 animate-spin"
                        : "size-4"
                    }
                  />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Edit ${connection.name}`}
                  onClick={() => setEditing(connection.name)}
                >
                  <Pencil className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Delete ${connection.name}`}
                  onClick={() => setDeleting(connection.name)}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {editing !== undefined && (
        <ConnectionEditor name={editing} onClose={() => setEditing(undefined)} />
      )}
      {browsing && (
        <ConnectionTools
          name={browsing.name}
          type={browsing.type}
          enabled={browsing.enabled}
          onClose={() => setBrowsing(null)}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        title="Delete connection"
        description={`Delete ${deleting}? spec-cli also removes its cached spec and revokes its OAuth tokens. This can't be undone.`}
        isPending={remove.isPending}
        onCancel={() => setDeleting(null)}
        onConfirm={() =>
          deleting && remove.mutate(deleting, { onSettled: () => setDeleting(null) })
        }
      />
    </section>
  );
}

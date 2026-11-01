import type { IntegrationToolResult } from "@orc/sdk/types";
import { useId, useState } from "react";
import {
  Availability,
  ErrorText,
  FeatureRow,
  OutputBlock,
  PromptList,
  prettyText,
  ResourceList,
  RunButton,
  SearchBox,
  useSearch,
} from "@/components/ConnectionFeatures";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  useConnectionTool,
  useConnectionTools,
  useInvokeTool,
  useSetToolEnabled,
} from "@/hooks/useIntegrations";
import { isMcpConnection } from "@/lib/connection-features";

const panel = "mt-0 flex min-h-0 flex-1 flex-col gap-3 data-[state=inactive]:hidden";

/**
 * Browses what a connection offers agents: its tools and, for an MCP server, its resources and
 * prompts. Each can be turned on or off for agents, or tried out.
 */
export function ConnectionTools({
  name,
  type,
  enabled,
  onClose,
}: {
  name: string;
  type: string | null;
  enabled: boolean;
  onClose: () => void;
}) {
  const mcp = isMcpConnection(type);
  const [tab, setTab] = useState("tools");
  return (
    <Dialog open onOpenChange={(value) => !value && onClose()}>
      <DialogContent
        data-testid="connection-tools"
        className="flex max-h-[min(85dvh,calc(var(--app-height,100dvh)-2rem))] flex-col sm:max-w-2xl"
      >
        <DialogHeader>
          <DialogTitle className="font-headline text-base text-on-surface">
            {mcp ? name : `${name} tools`}
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            Choose what agents may use, or open an item to try it.
            {!enabled && " The connection is disabled, so nothing can be called."}
          </DialogDescription>
        </DialogHeader>
        {mcp ? (
          <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col gap-3">
            <TabsList className="self-start">
              <TabsTrigger value="tools">Tools</TabsTrigger>
              <TabsTrigger value="resources">Resources</TabsTrigger>
              <TabsTrigger value="prompts">Prompts</TabsTrigger>
            </TabsList>
            <TabsContent value="tools" className={panel}>
              <ToolList name={name} enabled={enabled} />
            </TabsContent>
            {/* Mounted on first view only: listing them connects to the server. */}
            <TabsContent value="resources" className={panel}>
              {tab === "resources" && <ResourceList name={name} enabled={enabled} />}
            </TabsContent>
            <TabsContent value="prompts" className={panel}>
              {tab === "prompts" && <PromptList name={name} enabled={enabled} />}
            </TabsContent>
          </Tabs>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-3">
            <ToolList name={name} enabled={enabled} />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ToolList({ name, enabled }: { name: string; enabled: boolean }) {
  const tools = useConnectionTools(name);
  const setToolEnabled = useSetToolEnabled();
  const [open, setOpen] = useState<string | null>(null);
  const { query, setQuery, shown } = useSearch(tools.data, (tool) => [tool.id, tool.description]);
  const count = tools.data?.length ?? 0;
  return (
    <>
      <Availability items={tools.data} noun="tools" />
      {count > 8 && <SearchBox label="Search tools" value={query} onChange={setQuery} />}
      <ErrorText>{(tools.error ?? setToolEnabled.error)?.message}</ErrorText>
      <ul className="-mx-1 min-h-0 flex-1 divide-y divide-border overflow-y-auto px-1">
        {shown.map((tool) => (
          <FeatureRow
            key={tool.id}
            testId={`tool-${tool.id}`}
            label={tool.id}
            description={tool.description}
            allowed={tool.enabled}
            toggling={setToolEnabled.isPending}
            onAllow={(allowed) => setToolEnabled.mutate({ name, tool: tool.id, enabled: allowed })}
            open={open === tool.id}
            onOpen={() => setOpen(open === tool.id ? null : tool.id)}
          >
            <ToolRunner name={name} tool={tool.id} callable={enabled && tool.enabled} />
          </FeatureRow>
        ))}
        {tools.data && shown.length === 0 && (
          <li className="py-3 text-sm text-muted-foreground">
            {count ? "No tools match." : "This connection has no tools."}
          </li>
        )}
      </ul>
    </>
  );
}

function ToolRunner({ name, tool, callable }: { name: string; tool: string; callable: boolean }) {
  const detail = useConnectionTool(name, tool);
  const invoke = useInvokeTool();
  const [args, setArgs] = useState("{}");
  const [invalid, setInvalid] = useState<string | null>(null);
  const argsId = useId();
  const run = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(args || "{}");
    } catch (error) {
      setInvalid(`Arguments are not valid JSON: ${(error as Error).message}`);
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      setInvalid("Arguments must be a JSON object.");
      return;
    }
    setInvalid(null);
    invoke.mutate({ name, tool, args: parsed as Record<string, unknown> });
  };
  return (
    <>
      <ErrorText>{detail.error?.message}</ErrorText>
      {detail.data && (
        <>
          {detail.data.description && (
            <p className="whitespace-pre-wrap text-sm">{detail.data.description}</p>
          )}
          <details>
            <summary className="min-h-11 cursor-pointer content-center text-sm text-muted-foreground">
              Input schema
            </summary>
            <pre className="max-h-64 overflow-auto rounded-lg bg-background p-2 font-mono text-xs text-on-surface-variant">
              {JSON.stringify(detail.data.inputSchema, null, 2)}
            </pre>
          </details>
        </>
      )}
      <div className="space-y-1.5">
        <Label htmlFor={argsId} className="font-label text-sm text-muted-foreground">
          Arguments (JSON)
        </Label>
        <Textarea
          id={argsId}
          data-testid="tool-args"
          rows={4}
          spellCheck={false}
          value={args}
          onChange={(event) => setArgs(event.target.value)}
          className="bg-background border-control-border font-mono text-sm"
        />
      </div>
      <RunButton
        testId="tool-run"
        callable={callable}
        pending={invoke.isPending}
        idle="Run"
        busy="Running…"
        onRun={run}
        blockedHint="Allow the tool and enable the connection to run it."
      />
      <ErrorText>{invalid ?? invoke.error?.message}</ErrorText>
      {invoke.data && <ToolResult result={invoke.data} />}
    </>
  );
}

function ToolResult({ result }: { result: IntegrationToolResult }) {
  return (
    <section aria-label="Result" data-testid="tool-result" className="space-y-2">
      {result.isError && <Badge variant="outline">Error</Badge>}
      {result.content.map((item, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: result content has no ids and never reorders
        <OutputBlock key={index}>
          {item.type === "text" && typeof item.text === "string"
            ? prettyText(item.text)
            : JSON.stringify(item, null, 2)}
        </OutputBlock>
      ))}
    </section>
  );
}

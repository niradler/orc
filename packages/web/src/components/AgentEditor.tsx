import { useMemo, useState } from "react";
import type { AgentFull } from "@/api/client";
import { CodeEditor } from "@/components/CodeEditor";
import { Button } from "@/components/ui/button";
import { DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AGENT_TEMPLATES,
  agentTools,
  readAgentDefinition,
  setAgentBody,
  setAgentField,
  setAgentTools,
  type ToolRow,
} from "@/lib/agent-definition";

type Props = {
  agent?: AgentFull;
  pending: boolean;
  error?: string;
  onSave: (id: string, content: string) => void;
};

type EditorToolRow = ToolRow & { key: string };

function editableTools(fields: Record<string, unknown>): EditorToolRow[] {
  return agentTools(fields).map((tool) => ({ ...tool, key: crypto.randomUUID() }));
}

export function AgentEditor({ agent, pending, error, onSave }: Props) {
  const [id, setId] = useState(agent?.id ?? "");
  const [source, setSource] = useState(agent?.raw ?? AGENT_TEMPLATES.specialist);
  const [mode, setMode] = useState<"fields" | "source">("fields");
  const [tools, setTools] = useState<EditorToolRow[]>(() =>
    agent ? editableTools(agent.fields) : [],
  );
  const [modeError, setModeError] = useState<string>();
  const parsed = useMemo(() => {
    try {
      return { value: readAgentDefinition(source), error: undefined };
    } catch (failure) {
      return { value: undefined, error: (failure as Error).message };
    }
  }, [source]);
  const fields = parsed.value?.fields;
  let toolError: string | undefined;
  if (tools.some((tool) => !tool.name.trim())) toolError = "Enter a name for every tool.";
  else if (new Set(tools.map((tool) => tool.name.trim())).size !== tools.length)
    toolError = "Tool names must be unique.";
  const saveLabel = agent ? "Save changes" : "Create agent";

  function changeToolRows(next: EditorToolRow[]): void {
    setTools(next);
    if (
      next.every((tool) => tool.name.trim()) &&
      new Set(next.map((tool) => tool.name.trim())).size === next.length
    )
      setSource(
        setAgentTools(
          source,
          next.map((tool) => ({ ...tool, name: tool.name.trim() })),
        ),
      );
  }

  function switchMode(): void {
    setModeError(undefined);
    if (mode === "fields") {
      if (toolError) return;
      setMode("source");
      return;
    }
    try {
      const definition = readAgentDefinition(source);
      for (const key of ["name", "description", "model", "color"])
        if (definition.fields[key] !== undefined && typeof definition.fields[key] !== "string")
          throw new Error(`${key} must be a string to edit it in the form.`);
      setTools(editableTools(definition.fields));
      setMode("fields");
    } catch (failure) {
      setModeError((failure as Error).message);
    }
  }

  return (
    <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{agent ? `Edit ${agent.name}` : "New shared agent"}</DialogTitle>
      </DialogHeader>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSave(id, source);
        }}
      >
        <fieldset disabled={pending} className="space-y-4">
          {!agent && (
            <>
              <Label htmlFor="agent-template">Starting template</Label>
              <select
                id="agent-template"
                data-testid="agent-template"
                className="w-full border rounded-sm p-2 bg-surface"
                defaultValue="specialist"
                onChange={(event) => {
                  const template =
                    AGENT_TEMPLATES[event.target.value as keyof typeof AGENT_TEMPLATES];
                  setSource(template);
                  setTools(editableTools(readAgentDefinition(template).fields));
                  setModeError(undefined);
                }}
              >
                <option value="specialist">General specialist</option>
                <option value="reviewer">Reviewer</option>
                <option value="builder">Builder</option>
              </select>
            </>
          )}
          <Label htmlFor="agent-id">Agent ID</Label>
          <Input
            id="agent-id"
            data-testid="agent-id-input"
            value={id}
            disabled={Boolean(agent)}
            onChange={(event) => setId(event.target.value)}
            placeholder="security-review"
          />
          <Button
            type="button"
            variant="outline"
            data-testid="agent-editor-mode"
            onClick={switchMode}
            disabled={mode === "fields" && Boolean(toolError)}
          >
            {mode === "fields" ? "Edit YAML + Markdown" : "Edit fields"}
          </Button>
          {mode === "source" ? (
            <>
              <Label htmlFor="agent-definition">YAML configuration + Markdown instructions</Label>
              <CodeEditor
                id="agent-definition"
                testId="agent-content-input"
                path="agent.agent.md"
                readOnly={pending}
                height={400}
                value={source}
                onChange={(value) => {
                  setSource(value);
                  setModeError(undefined);
                }}
              />
            </>
          ) : (
            fields && (
              <>
                {(
                  [
                    ["name", "Name"],
                    ["description", "Description"],
                    ["model", "Model (optional)"],
                    ["color", "Color (optional)"],
                  ] as const
                ).map(([key, label]) => (
                  <div key={key} className="space-y-1">
                    <Label htmlFor={`agent-${key}`}>{label}</Label>
                    <Input
                      id={`agent-${key}`}
                      data-testid={`agent-${key}-input`}
                      value={typeof fields[key] === "string" ? fields[key] : ""}
                      onChange={(event) =>
                        setSource(
                          setAgentField(
                            source,
                            key,
                            event.target.value || (key === "description" ? "" : undefined),
                          ),
                        )
                      }
                    />
                  </div>
                ))}
                <div className="space-y-2">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      data-testid="agent-custom-tools"
                      type="checkbox"
                      checked={fields.tools !== undefined}
                      onChange={(event) => {
                        setTools([]);
                        setSource(
                          setAgentField(source, "tools", event.target.checked ? {} : undefined),
                        );
                      }}
                    />{" "}
                    Customize tool access
                  </label>
                  <p className="text-xs text-outline">
                    Use the tool names supported by your chosen backend. With customization off, the
                    backend's default tools apply. An empty custom list allows no tools.
                  </p>
                  {fields.tools !== undefined && (
                    <>
                      {tools.map((tool, index) => (
                        <div
                          key={tool.key}
                          data-testid="agent-tool-row"
                          className="flex items-center gap-2"
                        >
                          <Input
                            data-testid="agent-tool-name"
                            aria-label={`Tool ${index + 1} name`}
                            value={tool.name}
                            list="agent-tool-suggestions"
                            onChange={(event) =>
                              changeToolRows(
                                tools.map((entry, position) =>
                                  position === index
                                    ? { ...entry, name: event.target.value }
                                    : entry,
                                ),
                              )
                            }
                          />
                          <label className="flex items-center gap-1 text-sm">
                            <input
                              data-testid="agent-tool-allowed"
                              type="checkbox"
                              checked={tool.allowed}
                              onChange={(event) =>
                                changeToolRows(
                                  tools.map((entry, position) =>
                                    position === index
                                      ? { ...entry, allowed: event.target.checked }
                                      : entry,
                                  ),
                                )
                              }
                            />{" "}
                            Allowed
                          </label>
                          <Button
                            data-testid="agent-tool-remove"
                            type="button"
                            variant="outline"
                            onClick={() =>
                              changeToolRows(tools.filter((_, position) => position !== index))
                            }
                          >
                            Remove
                          </Button>
                        </div>
                      ))}
                      <datalist id="agent-tool-suggestions">
                        {["Read", "Grep", "Glob", "Edit", "Write", "Bash"].map((name) => (
                          <option key={name} value={name} />
                        ))}
                      </datalist>
                      <Button
                        data-testid="agent-tool-add"
                        type="button"
                        variant="outline"
                        onClick={() =>
                          changeToolRows([
                            ...tools,
                            { key: crypto.randomUUID(), name: "", allowed: true },
                          ])
                        }
                      >
                        Add tool
                      </Button>
                    </>
                  )}
                </div>
                <Label htmlFor="agent-instructions">Instructions</Label>
                <CodeEditor
                  id="agent-instructions"
                  testId="agent-instructions-input"
                  path="instructions.md"
                  readOnly={pending}
                  height={240}
                  value={parsed.value?.body ?? ""}
                  onChange={(value) => setSource(setAgentBody(source, value))}
                />
                <p className="text-xs text-outline">
                  Use YAML + Markdown to edit handoffs and additional configuration. Custom fields
                  are preserved.
                </p>
              </>
            )
          )}
        </fieldset>
        {(error || parsed.error || modeError || (mode === "fields" && toolError)) && (
          <p data-testid="agent-editor-error" role="alert" className="text-destructive">
            {error || parsed.error || modeError || toolError}
          </p>
        )}
        <Button
          data-testid="agent-submit"
          type="submit"
          disabled={
            pending ||
            !id.trim() ||
            !source.trim() ||
            Boolean(parsed.error) ||
            (mode === "fields" && Boolean(toolError))
          }
        >
          {pending ? "Saving..." : saveLabel}
        </Button>
      </form>
    </DialogContent>
  );
}

import { CHAT_UI_CATALOG_URI } from "@orc/core/chat-ui";
import { type McpSettings, McpSettingsSchema } from "@orc/core/mcp-settings";
import { useEffect, useState } from "react";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export function McpSettingsForm() {
  const [config, setConfig] = useState<McpSettings | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let disposed = false;
    void api.settings.mcp
      .get()
      .then((saved) => {
        if (!disposed) setConfig(McpSettingsSchema.parse(saved));
      })
      .catch((error) => {
        if (!disposed) {
          setFailed(true);
          setFeedback(error.message);
        }
      });
    return () => {
      disposed = true;
    };
  }, []);

  async function save() {
    setPending(true);
    setFeedback("");
    setFailed(false);
    try {
      const saved = await api.settings.mcp.save(McpSettingsSchema.parse(config));
      setConfig(saved);
      setFeedback("MCP settings saved. New connections use these defaults.");
    } catch (error) {
      setFailed(true);
      setFeedback(error instanceof Error ? error.message : "MCP settings could not be saved.");
    } finally {
      setPending(false);
    }
  }

  function patchPrompt(index: number, patch: Partial<McpSettings["prompts"][number]>) {
    if (!config) return;
    setConfig({
      ...config,
      prompts: config.prompts.map((prompt, i) => (i === index ? { ...prompt, ...patch } : prompt)),
    });
  }

  return (
    <section aria-labelledby="mcp-settings-title" data-testid="mcp-settings" className="space-y-5">
      <div>
        <h2 id="mcp-settings-title" className="text-base font-medium">
          MCP
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Control how agents connect to this ORC server.
        </p>
      </div>
      {config && (
        <fieldset disabled={pending} className="min-w-0 space-y-5">
          <div className="space-y-2">
            <Label htmlFor="mcp-default-mode">Default tool mode</Label>
            <select
              id="mcp-default-mode"
              data-testid="mcp-default-mode"
              className="form-control form-control-single max-w-sm"
              value={config.default_mode}
              onChange={(event) =>
                setConfig({
                  ...config,
                  default_mode: event.target.value as McpSettings["default_mode"],
                })
              }
            >
              <option value="meta">Meta — discover tools on demand</option>
              <option value="full">Full — list every tool</option>
            </select>
            <p className="text-xs text-muted-foreground">
              An explicit connection mode overrides this default. Restart existing stdio clients to
              apply changes.
            </p>
          </div>
          <div className="border-y border-border py-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-medium">Prompts · {config.prompts.length}</h3>
              <Button
                variant="outline"
                disabled={pending || config.prompts.length >= 50}
                data-testid="mcp-add-prompt"
                onClick={() => {
                  const used = new Set(config.prompts.map((prompt) => prompt.name));
                  let suffix = 1;
                  while (used.has(`prompt-${suffix}`)) suffix++;
                  setEditing(config.prompts.length);
                  setConfig({
                    ...config,
                    prompts: [
                      ...config.prompts,
                      {
                        name: `prompt-${suffix}`,
                        title: "New prompt",
                        description: "",
                        content: "Answer the user's request.",
                        include_ui_catalog: false,
                      },
                    ],
                  });
                }}
              >
                Add prompt
              </Button>
            </div>
            <p className="my-2 text-xs text-muted-foreground">
              Agents select these through MCP prompts. Catalog content is generated from the current
              schema.
            </p>
            <ul className="divide-y divide-border">
              {config.prompts.map((prompt, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: editable names cannot be keys; rows own no local state
                <li key={index} className="py-2">
                  <div className="flex min-w-0 items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-sm">
                      {prompt.title}{" "}
                      <span className="text-xs text-muted-foreground">{prompt.name}</span>
                    </span>
                    <Button
                      variant="ghost"
                      onClick={() => setEditing(editing === index ? null : index)}
                      aria-expanded={editing === index}
                    >
                      Edit
                    </Button>
                  </div>
                  {editing === index && (
                    <fieldset
                      disabled={pending}
                      className="mt-2 space-y-3"
                      data-testid="mcp-prompt-editor"
                    >
                      <div className="grid gap-3 sm:grid-cols-2">
                        <label htmlFor={`mcp-prompt-name-${index}`} className="space-y-1 text-sm">
                          Name
                          <Input
                            id={`mcp-prompt-name-${index}`}
                            aria-label="Prompt name"
                            value={prompt.name}
                            onChange={(event) => patchPrompt(index, { name: event.target.value })}
                          />
                        </label>
                        <label htmlFor={`mcp-prompt-title-${index}`} className="space-y-1 text-sm">
                          Title
                          <Input
                            id={`mcp-prompt-title-${index}`}
                            aria-label="Prompt title"
                            value={prompt.title}
                            onChange={(event) => patchPrompt(index, { title: event.target.value })}
                          />
                        </label>
                      </div>
                      <label
                        htmlFor={`mcp-prompt-description-${index}`}
                        className="block space-y-1 text-sm"
                      >
                        Description
                        <Input
                          id={`mcp-prompt-description-${index}`}
                          aria-label="Prompt description"
                          value={prompt.description}
                          onChange={(event) =>
                            patchPrompt(index, { description: event.target.value })
                          }
                        />
                      </label>
                      <label
                        htmlFor={`mcp-prompt-content-${index}`}
                        className="block space-y-1 text-sm"
                      >
                        Instructions
                        <Textarea
                          id={`mcp-prompt-content-${index}`}
                          aria-label="Prompt instructions"
                          value={prompt.content}
                          rows={5}
                          onChange={(event) => patchPrompt(index, { content: event.target.value })}
                        />
                      </label>
                      <label className="flex min-h-11 items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={prompt.include_ui_catalog}
                          onChange={(event) =>
                            patchPrompt(index, { include_ui_catalog: event.target.checked })
                          }
                        />
                        Include current UI catalog
                      </label>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setConfig({
                            ...config,
                            prompts: config.prompts.filter((_, i) => i !== index),
                          });
                          setEditing(null);
                        }}
                      >
                        Remove prompt
                      </Button>
                    </fieldset>
                  )}
                </li>
              ))}
            </ul>
          </div>
          <details className="text-sm">
            <summary className="min-h-11 cursor-pointer py-3">Resources · 1</summary>
            <p className="break-all font-mono text-xs">{CHAT_UI_CATALOG_URI}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              The current component and action catalog. Also available through the ui_catalog tool.
            </p>
          </details>
          <Button data-testid="mcp-save" disabled={pending} onClick={() => void save()}>
            Save changes
          </Button>
        </fieldset>
      )}
      {feedback && (
        <p
          role={failed ? "alert" : "status"}
          className={failed ? "text-sm text-error" : "text-sm text-muted-foreground"}
        >
          {feedback}
        </p>
      )}
    </section>
  );
}

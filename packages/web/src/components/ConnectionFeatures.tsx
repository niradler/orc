import type {
  IntegrationPrompt,
  IntegrationPromptResult,
  IntegrationResourceContents,
} from "@orc/sdk/types";
import { ChevronDown, ChevronRight } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  useConnectionPrompts,
  useConnectionResources,
  useGetPrompt,
  useReadResource,
  useSetToolEnabled,
} from "@/hooks/useIntegrations";
import { promptFilterId, resourceFilterId, templateVariables } from "@/lib/connection-features";

/** Filters a list by its search box once it is long enough to need one. */
export function useSearch<T>(items: T[] | undefined, text: (item: T) => string[]) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const shown = (items ?? []).filter(
    (item) => !needle || text(item).some((value) => value.toLowerCase().includes(needle)),
  );
  return { query, setQuery, shown };
}

export function SearchBox({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Input
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={label}
      className="bg-background border-control-border text-sm"
    />
  );
}

/** "3 of 5 resources available to agents." */
export function Availability({ items, noun }: { items?: { enabled: boolean }[]; noun: string }) {
  if (!items) return <p className="text-xs text-muted-foreground">Loading {noun}…</p>;
  const on = items.filter((item) => item.enabled).length;
  return (
    <p className="text-xs text-muted-foreground">
      {on} of {items.length} {noun} available to agents.
    </p>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  return children ? (
    <p role="alert" className="text-sm text-error">
      {children}
    </p>
  ) : null;
}

/** One tool, resource or prompt: a checkbox that allows it for agents, and a toggle to try it. */
export function FeatureRow({
  testId,
  label,
  description,
  allowed,
  toggling,
  onAllow,
  open,
  onOpen,
  children,
}: {
  testId: string;
  label: string;
  description?: string | null;
  allowed: boolean;
  toggling: boolean;
  onAllow: (allowed: boolean) => void;
  open: boolean;
  onOpen: () => void;
  children: ReactNode;
}) {
  return (
    <li data-testid={testId} className="py-1">
      <div className="flex min-h-11 items-center gap-2">
        <input
          type="checkbox"
          className="size-4 shrink-0 accent-primary"
          aria-label={`Allow ${label}`}
          checked={allowed}
          disabled={toggling}
          onChange={(event) => onAllow(event.target.checked)}
        />
        <button
          type="button"
          aria-expanded={open}
          onClick={onOpen}
          className="flex min-h-11 min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate font-mono text-sm">{label}</span>
            {description && (
              <span className="block truncate text-xs text-muted-foreground">{description}</span>
            )}
          </span>
          {open ? (
            <ChevronDown className="size-4 shrink-0" aria-hidden />
          ) : (
            <ChevronRight className="size-4 shrink-0" aria-hidden />
          )}
        </button>
      </div>
      {open && <div className="mb-2 space-y-3 rounded-md border border-border p-3">{children}</div>}
    </li>
  );
}

export function RunButton({
  testId,
  callable,
  pending,
  idle,
  busy,
  onRun,
  blockedHint,
}: {
  testId: string;
  callable: boolean;
  pending: boolean;
  idle: string;
  busy: string;
  onRun: () => void;
  blockedHint: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        size="sm"
        data-testid={testId}
        disabled={!callable || pending}
        onClick={onRun}
      >
        {pending ? busy : idle}
      </Button>
      {!callable && <span className="text-xs text-muted-foreground">{blockedHint}</span>}
    </div>
  );
}

export function OutputBlock({ children }: { children: ReactNode }) {
  return (
    <pre className="max-h-80 overflow-auto rounded-lg bg-background p-2 font-mono text-xs text-on-surface-variant whitespace-pre-wrap wrap-break-word">
      {children}
    </pre>
  );
}

/** Text results are often JSON; indent it so it can be read. */
export function prettyText(text: string) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** Named string inputs, one per template variable or prompt argument. */
function ValueFields({
  fields,
  values,
  onChange,
}: {
  fields: { name: string; description?: string | null; required?: boolean }[];
  values: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
}) {
  const id = useId();
  if (fields.length === 0) return null;
  return (
    <div className="grid gap-3">
      {fields.map((field) => (
        <div key={field.name} className="space-y-1.5">
          <Label
            htmlFor={`${id}-${field.name}`}
            className="font-label text-sm text-muted-foreground"
          >
            <span className="font-mono">{field.name}</span>
            {field.required && <span aria-hidden> *</span>}
          </Label>
          <Input
            id={`${id}-${field.name}`}
            value={values[field.name] ?? ""}
            required={field.required}
            placeholder={field.description ?? undefined}
            onChange={(event) => onChange({ ...values, [field.name]: event.target.value })}
            className="bg-background border-control-border font-mono text-sm"
          />
        </div>
      ))}
    </div>
  );
}

/** Drops empty optional values, so the server applies its own defaults. */
const filled = (values: Record<string, string>) =>
  Object.fromEntries(Object.entries(values).filter(([, value]) => value !== ""));

type ResourceItem = {
  key: string;
  target: string;
  name: string;
  description: string | null;
  mimeType: string | null;
  enabled: boolean;
  template: boolean;
};

/** An MCP connection's resources and resource templates. */
export function ResourceList({ name, enabled }: { name: string; enabled: boolean }) {
  const resources = useConnectionResources(name, true);
  const setEnabled = useSetToolEnabled();
  const [open, setOpen] = useState<string | null>(null);
  const items: ResourceItem[] | undefined = resources.data && [
    ...resources.data.resources.map((resource) => ({
      ...resource,
      key: resource.uri,
      target: resource.uri,
      template: false,
    })),
    ...resources.data.templates.map((template) => ({
      ...template,
      key: template.uriTemplate,
      target: template.uriTemplate,
      template: true,
    })),
  ];
  const { query, setQuery, shown } = useSearch(items, (item) => [
    item.name,
    item.target,
    item.description ?? "",
  ]);
  return (
    <>
      <Availability items={items} noun="resources" />
      {(items?.length ?? 0) > 8 && (
        <SearchBox label="Search resources" value={query} onChange={setQuery} />
      )}
      <ErrorText>
        {resources.data?.error ?? (resources.error ?? setEnabled.error)?.message}
      </ErrorText>
      <ul className="-mx-1 min-h-0 flex-1 divide-y divide-border overflow-y-auto px-1">
        {shown.map((item) => (
          <FeatureRow
            key={item.key}
            testId={`resource-${item.key}`}
            label={item.target}
            description={item.description ?? item.name}
            allowed={item.enabled}
            toggling={setEnabled.isPending}
            onAllow={(allowed) =>
              setEnabled.mutate({ name, tool: resourceFilterId(item.target), enabled: allowed })
            }
            open={open === item.key}
            onOpen={() => setOpen(open === item.key ? null : item.key)}
          >
            <ResourceReader name={name} item={item} callable={enabled && item.enabled} />
          </FeatureRow>
        ))}
        {items && shown.length === 0 && (
          <li className="py-3 text-sm text-muted-foreground">
            {items.length ? "No resources match." : "This connection has no resources."}
          </li>
        )}
      </ul>
    </>
  );
}

function ResourceReader({
  name,
  item,
  callable,
}: {
  name: string;
  item: ResourceItem;
  callable: boolean;
}) {
  const read = useReadResource();
  const [vars, setVars] = useState<Record<string, string>>({});
  const variables = item.template ? templateVariables(item.target) : [];
  return (
    <>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Name</dt>
        <dd className="min-w-0 break-all font-mono">{item.name}</dd>
        {item.mimeType && (
          <>
            <dt className="text-muted-foreground">Type</dt>
            <dd className="font-mono">{item.mimeType}</dd>
          </>
        )}
      </dl>
      {item.description && <p className="whitespace-pre-wrap text-sm">{item.description}</p>}
      <ValueFields
        fields={variables.map((variable) => ({ name: variable }))}
        values={vars}
        onChange={setVars}
      />
      <RunButton
        testId="resource-read"
        callable={callable}
        pending={read.isPending}
        idle="Read"
        busy="Reading…"
        onRun={() => read.mutate({ name, uri: item.target, vars: filled(vars) })}
        blockedHint="Allow the resource and enable the connection to read it."
      />
      <ErrorText>{read.error?.message}</ErrorText>
      {read.data && <ResourceContents result={read.data} />}
    </>
  );
}

function ResourceContents({ result }: { result: IntegrationResourceContents }) {
  return (
    <section aria-label="Contents" data-testid="resource-contents" className="space-y-2">
      {result.contents.length === 0 && (
        <p className="text-sm text-muted-foreground">The resource is empty.</p>
      )}
      {result.contents.map((content, index) => {
        const mimeType = typeof content.mimeType === "string" ? content.mimeType : null;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: contents have no ids and never reorder
          <div key={index} className="space-y-1">
            {typeof content.uri === "string" && (
              <p className="break-all font-mono text-xs text-muted-foreground">
                {content.uri}
                {mimeType && ` · ${mimeType}`}
              </p>
            )}
            {typeof content.text === "string" ? (
              <OutputBlock>{prettyText(content.text)}</OutputBlock>
            ) : typeof content.blob === "string" && mimeType?.startsWith("image/") ? (
              <img
                src={`data:${mimeType};base64,${content.blob}`}
                alt={typeof content.uri === "string" ? content.uri : "Resource"}
                className="max-h-80 rounded-lg"
              />
            ) : typeof content.blob === "string" ? (
              <p className="text-sm text-muted-foreground">
                Binary content, {Math.floor((content.blob.length * 3) / 4)} bytes.
              </p>
            ) : (
              <OutputBlock>{JSON.stringify(content, null, 2)}</OutputBlock>
            )}
          </div>
        );
      })}
    </section>
  );
}

/** An MCP connection's prompts. */
export function PromptList({ name, enabled }: { name: string; enabled: boolean }) {
  const prompts = useConnectionPrompts(name, true);
  const setEnabled = useSetToolEnabled();
  const [open, setOpen] = useState<string | null>(null);
  const items = prompts.data?.prompts;
  const { query, setQuery, shown } = useSearch(items, (prompt) => [
    prompt.name,
    prompt.description ?? "",
  ]);
  return (
    <>
      <Availability items={items} noun="prompts" />
      {(items?.length ?? 0) > 8 && (
        <SearchBox label="Search prompts" value={query} onChange={setQuery} />
      )}
      <ErrorText>{prompts.data?.error ?? (prompts.error ?? setEnabled.error)?.message}</ErrorText>
      <ul className="-mx-1 min-h-0 flex-1 divide-y divide-border overflow-y-auto px-1">
        {shown.map((prompt) => (
          <FeatureRow
            key={prompt.name}
            testId={`prompt-${prompt.name}`}
            label={prompt.name}
            description={prompt.description}
            allowed={prompt.enabled}
            toggling={setEnabled.isPending}
            onAllow={(allowed) =>
              setEnabled.mutate({ name, tool: promptFilterId(prompt.name), enabled: allowed })
            }
            open={open === prompt.name}
            onOpen={() => setOpen(open === prompt.name ? null : prompt.name)}
          >
            <PromptRunner name={name} prompt={prompt} callable={enabled && prompt.enabled} />
          </FeatureRow>
        ))}
        {items && shown.length === 0 && (
          <li className="py-3 text-sm text-muted-foreground">
            {items.length ? "No prompts match." : "This connection has no prompts."}
          </li>
        )}
      </ul>
    </>
  );
}

function PromptRunner({
  name,
  prompt,
  callable,
}: {
  name: string;
  prompt: IntegrationPrompt;
  callable: boolean;
}) {
  const get = useGetPrompt();
  const [args, setArgs] = useState<Record<string, string>>({});
  const missing = prompt.arguments.filter((arg) => arg.required && !args[arg.name]);
  return (
    <>
      {prompt.description && <p className="whitespace-pre-wrap text-sm">{prompt.description}</p>}
      <ValueFields fields={prompt.arguments} values={args} onChange={setArgs} />
      <RunButton
        testId="prompt-get"
        callable={callable && missing.length === 0}
        pending={get.isPending}
        idle="Render"
        busy="Rendering…"
        onRun={() => get.mutate({ name, prompt: prompt.name, args: filled(args) })}
        blockedHint={
          callable
            ? `Fill in ${missing.map((arg) => arg.name).join(", ")}.`
            : "Allow the prompt and enable the connection to render it."
        }
      />
      <ErrorText>{get.error?.message}</ErrorText>
      {get.data && <PromptMessages result={get.data} />}
    </>
  );
}

function PromptMessages({ result }: { result: IntegrationPromptResult }) {
  return (
    <section aria-label="Messages" data-testid="prompt-messages" className="space-y-2">
      {result.description && <p className="text-sm">{result.description}</p>}
      {result.messages.map((message, index) => {
        const content = message.content as Record<string, unknown> | undefined;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: messages have no ids and never reorder
          <div key={index} className="space-y-1">
            <Badge variant="outline">{String(message.role)}</Badge>
            <OutputBlock>
              {content?.type === "text" && typeof content.text === "string"
                ? content.text
                : JSON.stringify(content, null, 2)}
            </OutputBlock>
          </div>
        );
      })}
    </section>
  );
}

import { type ChatQuestion, ChatQuestionSchema } from "@orc/core/chat";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Unsupported form");
  return value as Record<string, unknown>;
}

type FormValue = string | number | boolean;
type FormChoice = { label: string; value: FormValue; description: string };
type FormField = {
  key: string;
  field: Record<string, unknown>;
  type: "string" | "number" | "integer" | "boolean" | "array";
  required: boolean;
  multi: boolean;
  choices: FormChoice[];
  customKey?: string;
};

const SECRET_FIELD = /password|passphrase|secret|token|credential|api.?key|private[_ -]?key/i;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function titledChoices(value: unknown): FormChoice[] {
  if (!Array.isArray(value)) throw new Error("Unsupported form choices");
  return value.map((raw) => {
    const option = object(raw);
    const constant = option.const;
    if (
      typeof constant !== "string" &&
      typeof constant !== "number" &&
      typeof constant !== "boolean"
    )
      throw new Error("Unsupported form choice value");
    const label = text(option.title) || String(constant);
    return {
      label,
      value: constant,
      description: text(option.description),
    };
  });
}

function enumChoices(value: unknown): FormChoice[] {
  if (!Array.isArray(value)) throw new Error("Unsupported form choices");
  return value.map((raw) => {
    if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean")
      throw new Error("Unsupported form choice value");
    return { label: String(raw), value: raw, description: "" };
  });
}

function arrayChoices(items: unknown): FormChoice[] {
  const item = object(items);
  if (item.anyOf !== undefined) return titledChoices(item.anyOf);
  if (item.enum !== undefined) return enumChoices(item.enum);
  throw new Error("Unsupported multi-select options");
}

function uniqueChoices(choices: FormChoice[]): FormChoice[] {
  const labels = new Set<string>();
  for (const choice of choices) {
    if (labels.has(choice.label)) throw new Error("Ambiguous form choices");
    labels.add(choice.label);
  }
  return choices;
}

/** ACP form elicitation: generic agent forms, including OpenCode's question schema. */
export function acpElicitationForm(requestId: string, raw: Record<string, unknown>) {
  if (raw.mode !== "form")
    throw new Error(
      raw.mode === "url"
        ? "This agent needs input in its native client: it requested URL elicitation."
        : `This agent needs input in its native client: unsupported elicitation mode "${String(raw.mode)}".`,
    );
  const schema = object(raw.requestedSchema);
  if (schema.type !== "object") throw new Error("Unsupported form schema");
  if (schema.oneOf || schema.anyOf || schema.allOf)
    throw new Error("Unsupported form schema constraints");
  const properties = object(schema.properties);
  const entries = Object.entries(properties);
  if (entries.length === 0) throw new Error("Unsupported form schema: no fields");
  const required = Array.isArray(schema.required) ? schema.required : [];
  if (required.some((key) => typeof key !== "string" || !Object.hasOwn(properties, key)))
    throw new Error("Unsupported form schema constraints");

  const rawFields = entries.map(([key, value]) => ({ key, field: object(value) }));
  const customKeys = new Set<string>();
  const companion = new Map<string, string>();
  for (const { key, field } of rawFields) {
    if (
      key.endsWith("_custom") &&
      field.type === "string" &&
      Object.hasOwn(properties, key.slice(0, -"_custom".length))
    ) {
      const baseKey = key.slice(0, -"_custom".length);
      const base = object(properties[baseKey]);
      if (base.type === "string" || base.type === "array") {
        if (
          SECRET_FIELD.test([key, text(field.title), text(field.description)].join(" ")) ||
          field.format === "password" ||
          Object.keys(field).some(
            (name) =>
              ![
                "type",
                "title",
                "description",
                "_meta",
                "format",
                "minLength",
                "maxLength",
              ].includes(name),
          )
        )
          throw new Error("Secret input requires the agent's native client");
        companion.set(baseKey, key);
        customKeys.add(key);
      }
    }
  }

  const fields: FormField[] = rawFields
    .filter(({ key }) => !customKeys.has(key))
    .map(({ key, field }) => {
      const type = String(field.type);
      if (!["string", "number", "integer", "boolean", "array"].includes(type))
        throw new Error("Unsupported form field type");
      const supported = new Set([
        "type",
        "title",
        "description",
        "_meta",
        "default",
        ...(type === "string"
          ? ["enum", "oneOf", "format", "minLength", "maxLength"]
          : type === "array"
            ? ["items", "minItems", "maxItems"]
            : type === "boolean"
              ? []
              : ["minimum", "maximum"]),
      ]);
      if (
        field.writeOnly ||
        field.pattern ||
        Object.keys(field).some((name) => !supported.has(name))
      )
        throw new Error("Unsupported form field constraints");
      if (
        field.minLength !== undefined &&
        (typeof field.minLength !== "number" || field.minLength < 0)
      )
        throw new Error("Unsupported form field constraints");
      if (
        field.maxLength !== undefined &&
        (typeof field.maxLength !== "number" || field.maxLength < 0)
      )
        throw new Error("Unsupported form field constraints");
      if (
        (field.minItems !== undefined &&
          (typeof field.minItems !== "number" || field.minItems < 0)) ||
        (field.maxItems !== undefined && (typeof field.maxItems !== "number" || field.maxItems < 0))
      )
        throw new Error("Unsupported form field constraints");
      if (
        (type === "number" || type === "integer") &&
        ((field.minimum !== undefined && typeof field.minimum !== "number") ||
          (field.maximum !== undefined && typeof field.maximum !== "number"))
      )
        throw new Error("Unsupported form field constraints");

      const choices =
        type === "string"
          ? field.oneOf !== undefined && field.enum !== undefined
            ? (() => {
                throw new Error("Ambiguous form choices");
              })()
            : field.oneOf !== undefined
              ? titledChoices(field.oneOf)
              : field.enum !== undefined
                ? enumChoices(field.enum)
                : []
          : type === "array"
            ? arrayChoices(field.items)
            : type === "boolean"
              ? [
                  { label: "true", value: true, description: "" },
                  { label: "false", value: false, description: "" },
                ]
              : [];
      const customKey = companion.get(key);
      const optionText = choices.flatMap((choice) => [choice.label, choice.description]).join(" ");
      if (
        field.format === "password" ||
        SECRET_FIELD.test([key, text(field.title), text(field.description), optionText].join(" "))
      )
        throw new Error("Secret input requires the agent's native client");
      if (type === "array" && choices.some((choice) => typeof choice.value !== "string"))
        throw new Error("Unsupported multi-select option value");
      return {
        key,
        field,
        type: type as FormField["type"],
        required: required.includes(key),
        multi: type === "array",
        choices: uniqueChoices(choices),
        ...(customKey ? { customKey } : {}),
      };
    });
  if (fields.length === 0) throw new Error("Unsupported form schema: no fields");

  const header = text(raw.message).slice(0, 500) || "Agent question";
  const question: ChatQuestion = ChatQuestionSchema.parse({
    requestId,
    questions: fields.map(({ key, field, required, choices }) => ({
      id: key,
      header,
      question: [
        text(raw.message),
        text(field.title) || key,
        text(field.description),
        !required ? 'Reply "(skip)" to omit this optional field.' : null,
      ]
        .filter(Boolean)
        .join("\n"),
      ...(field.type === "array" ? { multiSelect: true } : {}),
      options: choices.length
        ? choices.map(({ label, description }) => ({ label, description }))
        : null,
    })),
  });

  return {
    question,
    content(answers: Record<string, string[]>): Record<string, FormValue | string[]> {
      const content: Record<string, FormValue | string[]> = Object.create(null);
      for (const { key, field, type, required, multi, choices, customKey } of fields) {
        const values = (answers[key] ?? []).filter((answer) => answer.trim().length > 0);
        if (!values.length) {
          if (required) throw new Error("Missing form answer");
          continue;
        }
        if (values.length === 1 && values[0] === "(skip)") {
          if (required) throw new Error("Missing form answer");
          continue;
        }
        if (multi) {
          const selected: string[] = [];
          let custom = "";
          for (const answer of values) {
            const choice = choices.find((entry) => entry.label === answer);
            if (choice) selected.push(String(choice.value));
            else if (customKey) {
              if (custom) throw new Error("Invalid form answer");
              custom = answer;
            } else throw new Error("Invalid form answer");
          }
          const minimum = typeof field.minItems === "number" ? field.minItems : 0;
          const maximum =
            typeof field.maxItems === "number" ? field.maxItems : Number.POSITIVE_INFINITY;
          if (selected.length < minimum || selected.length > maximum)
            throw new Error("Invalid form answer");
          if (selected.length) content[key] = selected;
          if (custom) content[customKey ?? `${key}_custom`] = custom;
          continue;
        }
        if (values.length !== 1) throw new Error("Invalid form answer");
        const answer = values[0] as string;
        const choice = choices.find((entry) => entry.label === answer);
        if (choice) {
          content[key] = choice.value;
          continue;
        }
        if (choices.length) {
          if (!customKey) throw new Error("Invalid form answer");
          content[key] = answer;
          content[customKey] = answer;
          continue;
        }
        if (type === "boolean") {
          if (answer !== "true" && answer !== "false") throw new Error("Invalid form answer");
          content[key] = answer === "true";
        } else if (type === "number" || type === "integer") {
          const value = Number(answer);
          if (
            !Number.isFinite(value) ||
            (type === "integer" && !Number.isInteger(value)) ||
            (typeof field.minimum === "number" && value < field.minimum) ||
            (typeof field.maximum === "number" && value > field.maximum)
          )
            throw new Error("Invalid form answer");
          content[key] = value;
        } else {
          if (
            (typeof field.minLength === "number" && answer.length < field.minLength) ||
            (typeof field.maxLength === "number" && answer.length > field.maxLength)
          )
            throw new Error("Invalid form answer");
          content[key] = answer;
        }
      }
      return content;
    },
  };
}

/** Only non-secret primitive forms enter the durable inbox. URL authentication stays external. */
export function elicitationForm(requestId: string, raw: Record<string, unknown>) {
  if (raw.mode && raw.mode !== "form")
    throw new Error("URL or extended authentication form requires its native client");
  const schema = object(raw.requestedSchema);
  if (schema.type !== "object") throw new Error("Unsupported form schema");
  const properties = object(schema.properties);
  const fields = Object.entries(properties);
  const required = Array.isArray(schema.required) ? schema.required : [];
  if (
    schema.oneOf ||
    schema.anyOf ||
    schema.allOf ||
    required.some((key) => typeof key !== "string" || !Object.hasOwn(properties, key))
  )
    throw new Error("Unsupported form schema constraints");
  const question: ChatQuestion = ChatQuestionSchema.parse({
    requestId,
    questions: fields.map(([key, value]) => {
      const field = object(value);
      const supported = new Set([
        "type",
        "title",
        "description",
        "enum",
        "minimum",
        "maximum",
        "minLength",
        "maxLength",
        "default",
      ]);
      if (
        !["string", "number", "integer", "boolean"].includes(String(field.type)) ||
        field.format ||
        field.writeOnly ||
        /password|secret|token|credential|api.?key/i.test(
          [key, field.title, field.description].join(" "),
        ) ||
        Object.keys(field).some((key) => !supported.has(key)) ||
        (Array.isArray(field.enum) &&
          field.enum.some((value) => !["string", "number", "boolean"].includes(typeof value)))
      )
        throw new Error("Secret or unsupported form field");
      const choices = Array.isArray(field.enum)
        ? field.enum.map(String)
        : field.type === "boolean"
          ? ["true", "false"]
          : [];
      return {
        id: key,
        header: String(raw.serverName ?? "MCP form"),
        question: [
          raw.message,
          field.title ?? key,
          field.description,
          !required.includes(key) ? 'Reply "(skip)" to omit this optional field.' : null,
        ]
          .filter(Boolean)
          .join("\n"),
        options: choices.map((label) => ({ label, description: "" })),
      };
    }),
  });
  return {
    question,
    content(answers: Record<string, string[]>): Record<string, string | number | boolean> {
      const content: Record<string, string | number | boolean> = Object.create(null);
      for (const [key, rawField] of fields) {
        const field = object(rawField);
        const answer = answers[key]?.[0];
        if (answer === "(skip)" && !required.includes(key)) continue;
        if (answer === undefined || answers[key]?.length !== 1)
          throw new Error("Missing form answer");
        const value =
          field.type === "boolean"
            ? answer === "true"
              ? true
              : answer === "false"
                ? false
                : undefined
            : field.type === "string"
              ? answer
              : Number(answer);
        if (
          value === undefined ||
          (typeof value === "number" &&
            (!Number.isFinite(value) || (field.type === "integer" && !Number.isInteger(value)))) ||
          (Array.isArray(field.enum) && !field.enum.includes(value)) ||
          (typeof value === "number" &&
            ((typeof field.minimum === "number" && value < field.minimum) ||
              (typeof field.maximum === "number" && value > field.maximum))) ||
          (typeof value === "string" &&
            ((typeof field.minLength === "number" && value.length < field.minLength) ||
              (typeof field.maxLength === "number" && value.length > field.maxLength)))
        )
          throw new Error("Invalid form answer");
        // Unimplemented schema constraints fail closed rather than claiming successful validation.
        if (field.pattern || field.oneOf || field.anyOf || field.allOf)
          throw new Error("Unsupported form constraint");
        content[key] = value;
      }
      return content;
    },
  };
}

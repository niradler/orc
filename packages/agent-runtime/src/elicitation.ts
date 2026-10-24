import { type ChatQuestion, ChatQuestionSchema } from "@orc/core/chat";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Unsupported form");
  return value as Record<string, unknown>;
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

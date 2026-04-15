import type { ZodTypeAny } from "zod";

export function zodToJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  const def = schema._def;
  const typeName = def.typeName as string;

  if (typeName === "ZodObject") {
    const shape = def.shape() as Record<string, ZodTypeAny>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [key, val] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(val);
      const vDef = (val as ZodTypeAny)._def;
      if (vDef.typeName !== "ZodOptional" && vDef.typeName !== "ZodDefault") {
        required.push(key);
      }
    }

    return { type: "object", properties, ...(required.length ? { required } : {}) };
  }

  if (typeName === "ZodString") return { type: "string" };
  if (typeName === "ZodNumber") return { type: "number" };
  if (typeName === "ZodBoolean") return { type: "boolean" };

  if (typeName === "ZodArray") {
    return { type: "array", items: zodToJsonSchema(def.element as ZodTypeAny) };
  }

  if (typeName === "ZodEnum") {
    return { type: "string", enum: def.values as string[] };
  }

  if (typeName === "ZodOptional" || typeName === "ZodDefault") {
    return zodToJsonSchema(def.innerType as ZodTypeAny);
  }

  if (typeName === "ZodUnion") {
    return { oneOf: (def.options as ZodTypeAny[]).map(zodToJsonSchema) };
  }

  return {};
}

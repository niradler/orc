import { RE2JS } from "re2js";
import { z } from "zod";

const scalar = z.union([z.string().max(16000), z.number().finite(), z.boolean(), z.null()]);
const field = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-zA-Z_][\w]*(?:\.[\w]+)*$/)
  .refine(
    (value) =>
      !value.split(".").some((part) => ["__proto__", "prototype", "constructor"].includes(part)),
    "Unsafe field path",
  );
export const RulePredicateSchema = z.discriminatedUnion("operator", [
  z.object({ field, operator: z.literal("equals"), value: scalar }).strict(),
  z.object({ field, operator: z.literal("in"), value: z.array(scalar).min(1).max(100) }).strict(),
  z.object({ field, operator: z.literal("exists") }).strict(),
  z
    .object({
      field,
      operator: z.enum(["contains", "starts_with", "ends_with"]),
      value: z.string().min(1).max(16000),
      ignore_case: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      field,
      operator: z.literal("regex"),
      value: z.string().min(1).max(512),
      ignore_case: z.boolean().optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
      try {
        compileRuleRegex(value.value, value.ignore_case);
      } catch {
        ctx.addIssue({
          code: "custom",
          message: "Invalid RE2 regex (lookaround and backreferences are unsupported)",
        });
      }
    }),
]);
export const RuleFilterSchema = z
  .object({
    match: z.enum(["all", "any"]),
    conditions: z
      .array(z.object({ predicate: RulePredicateSchema, negate: z.boolean().optional() }).strict())
      .max(32),
  })
  .strict();
export type RuleFilter = z.infer<typeof RuleFilterSchema>;

export function compileRuleRegex(pattern: string, ignoreCase = false): RE2JS {
  return RE2JS.compile(pattern, ignoreCase ? RE2JS.CASE_INSENSITIVE : 0);
}

function valueAt(event: unknown, field: string): unknown {
  let value = event;
  for (const key of field.split(".")) {
    if (!value || typeof value !== "object") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return undefined;
    value = descriptor.value;
  }
  return value;
}

export function matchesRuleFilter(filter: RuleFilter, event: unknown): boolean {
  if (!filter.conditions.length) return true;
  const test = ({ predicate, negate }: RuleFilter["conditions"][number]): boolean => {
    const actual = valueAt(event, predicate.field);
    let matched = false;
    if (predicate.operator === "exists") matched = actual !== undefined && actual !== null;
    else if (predicate.operator === "equals") matched = actual === predicate.value;
    else if (predicate.operator === "in")
      matched = predicate.value.some((value) => actual === value);
    else if (typeof actual === "string") {
      if (actual.length > 1_000_000) throw new Error("Filter field exceeds input limit");
      if (predicate.operator === "regex")
        matched = compileRuleRegex(predicate.value, predicate.ignore_case).matcher(actual).find();
      else {
        const text = predicate.ignore_case ? actual.toLowerCase() : actual;
        const expected = predicate.ignore_case ? predicate.value.toLowerCase() : predicate.value;
        if (predicate.operator === "contains") matched = text.includes(expected);
        else if (predicate.operator === "starts_with") matched = text.startsWith(expected);
        else matched = text.endsWith(expected);
      }
    }
    return negate ? !matched : matched;
  };
  return filter.match === "all" ? filter.conditions.every(test) : filter.conditions.some(test);
}

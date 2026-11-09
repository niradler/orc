import { z } from "zod";

const argument = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes("\0"));
export const JobEnvironmentSchema = z
  .array(
    z
      .object({
        name: z
          .string()
          .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
          .refine((value) => !value.toUpperCase().startsWith("ORC_"), "ORC_ variables are reserved")
          .max(128),
        value: z
          .string()
          .max(8192)
          .refine((value) => !/[\r\n\0]/.test(value), "Use a single-line value")
          .nullable(),
        secret: z.boolean(),
      })
      .strict(),
  )
  .max(100)
  .refine(
    (values) => new Set(values.map((entry) => entry.name.toUpperCase())).size === values.length,
    "Environment names must be unique",
  );
export const JobSettingsSchema = z
  .object({
    host: z
      .string()
      .regex(/^[A-Za-z0-9_.@][A-Za-z0-9_.@-]*$/)
      .max(128)
      .nullable()
      .optional(),
    inherit_project_directory: z.boolean().optional(),
    timezone: z
      .string()
      .max(100)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }, "Choose a valid timezone")
      .optional(),
    shell: z
      .object({
        executable: argument,
        args: z.array(argument).max(32),
      })
      .strict()
      .optional(),
    workspace: z
      .object({
        mode: z.enum(["directory", "worktree"]),
        base_ref: z
          .string()
          .min(1)
          .max(256)
          .regex(/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/)
          .refine((value) => !value.includes("..")),
        cleanup_on_success: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type JobSettings = z.infer<typeof JobSettingsSchema>;
export type JobEnvironment = z.infer<typeof JobEnvironmentSchema>;

export function jobShellArgv(
  settings: JobSettings | null | undefined,
  script: string,
  platform: string,
): string[] {
  if (settings?.shell) return [settings.shell.executable, ...settings.shell.args, script];
  // An absent settings object preserves the historical sh behavior for stored jobs.
  if (!settings || platform !== "win32") return ["sh", "-c", script];
  return ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script];
}

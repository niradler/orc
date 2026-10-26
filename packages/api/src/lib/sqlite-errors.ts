type ConstraintFailure = { status: 409 | 422; code: string; error: string };

const CONFLICTS = new Set(["SQLITE_CONSTRAINT_UNIQUE", "SQLITE_CONSTRAINT_PRIMARYKEY"]);
const INVALID = new Set(["SQLITE_CONSTRAINT_NOTNULL", "SQLITE_CONSTRAINT_CHECK"]);

/**
 * Maps a SQLite constraint violation (possibly wrapped as an error `cause`) to a client
 * error: the request referenced a missing row or duplicated an existing one. Trigger
 * failures and other storage errors stay server errors.
 */
export function constraintFailure(err: unknown): ConstraintFailure | null {
  for (let e = err; e instanceof Error; e = e.cause) {
    const code = (e as { code?: unknown }).code;
    if (typeof code !== "string") continue;
    if (CONFLICTS.has(code)) return { status: 409, code: "CONFLICT", error: e.message };
    if (code === "SQLITE_CONSTRAINT_FOREIGNKEY")
      return {
        status: 422,
        code: "REFERENCE_NOT_FOUND",
        error: "A referenced record does not exist",
      };
    if (INVALID.has(code)) return { status: 422, code: "CONSTRAINT_VIOLATION", error: e.message };
  }
  return null;
}

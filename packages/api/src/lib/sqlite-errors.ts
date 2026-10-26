type ConstraintFailure = { status: 409 | 422; code: string; error: string; detail: string };

const CONFLICTS = new Set(["SQLITE_CONSTRAINT_UNIQUE", "SQLITE_CONSTRAINT_PRIMARYKEY"]);
const INVALID = new Set(["SQLITE_CONSTRAINT_NOTNULL", "SQLITE_CONSTRAINT_CHECK"]);

/**
 * Maps a SQLite constraint violation (possibly wrapped as an error `cause`) to a client
 * error: the request referenced a missing row or duplicated an existing one. `error` is
 * safe to return; `detail` is the raw SQLite message, which names tables and columns and
 * belongs in logs only. Trigger failures and other storage errors stay server errors.
 */
export function constraintFailure(err: unknown): ConstraintFailure | null {
  for (let e = err; e instanceof Error; e = e.cause) {
    const code = (e as { code?: unknown }).code;
    if (typeof code !== "string") continue;
    const detail = e.message;
    if (CONFLICTS.has(code))
      return {
        status: 409,
        code: "CONFLICT",
        error: "A record with this key already exists",
        detail,
      };
    if (code === "SQLITE_CONSTRAINT_FOREIGNKEY")
      return {
        status: 422,
        code: "REFERENCE_NOT_FOUND",
        error: "A referenced record does not exist",
        detail,
      };
    if (INVALID.has(code))
      return {
        status: 422,
        code: "CONSTRAINT_VIOLATION",
        error: "A required field is missing or invalid",
        detail,
      };
  }
  return null;
}

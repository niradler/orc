export class OrcError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500,
    /** Extra JSON fields merged into the API error body (e.g. the SESSION_BUSY
     *  `active` run), so a client can act on the conflict instead of guessing. */
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "OrcError";
  }
}

export class NotFoundError extends OrcError {
  constructor(resource: string, id: string) {
    super(`${resource} not found: ${id}`, "NOT_FOUND", 404);
    this.name = "NotFoundError";
  }
}

export class ValidationError extends OrcError {
  constructor(message: string) {
    super(message, "VALIDATION_ERROR", 400);
    this.name = "ValidationError";
  }
}

export class ConflictError extends OrcError {
  constructor(message: string, code = "CONFLICT", details?: Record<string, unknown>) {
    super(message, code, 409, details);
    this.name = "ConflictError";
  }
}

export class UnauthorizedError extends OrcError {
  constructor(message: string = "Unauthorized") {
    super(message, "UNAUTHORIZED", 401);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends OrcError {
  constructor(message: string, code: string = "FORBIDDEN") {
    super(message, code, 403);
    this.name = "ForbiddenError";
  }
}

export class TooManyRequestsError extends OrcError {
  constructor(message: string = "Too many requests", details?: Record<string, unknown>) {
    super(message, "RATE_LIMITED", 429, details);
    this.name = "TooManyRequestsError";
  }
}

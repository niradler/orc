const MAX_TITLE_LENGTH = 200;

export function validateTaskTitle(title: string): { valid: boolean; error?: string } {
  const trimmed = title.trim();

  if (trimmed.length === 0) {
    return { valid: false, error: "Title must not be empty" };
  }

  if (trimmed.length > MAX_TITLE_LENGTH) {
    return {
      valid: false,
      error: `Title must not exceed ${MAX_TITLE_LENGTH} characters (got ${trimmed.length})`,
    };
  }

  return { valid: true };
}

import { z } from "zod";

/** Git remote URLs ORC accepts for a project: no credentials, query or fragment. */
export function isGitRemoteUrl(value: string): boolean {
  if (
    /\s/.test(value) ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    return false;
  if (/^[A-Za-z0-9._-]+@(?:[A-Za-z0-9.-]+|\[[A-Fa-f0-9:]+\]):[^\s?#]+$/.test(value)) return true;
  try {
    const url = new URL(value);
    return (
      ["https:", "http:", "ssh:", "git:"].includes(url.protocol) &&
      Boolean(url.hostname) &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.protocol === "ssh:" || !url.username)
    );
  } catch {
    return false;
  }
}

export const GitRemoteUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .refine(
    (value) => !value || isGitRemoteUrl(value),
    "Enter a Git remote URL without passwords, access tokens, query parameters or fragments",
  )
  .transform((value) => value || null)
  .nullable();

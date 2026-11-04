import { type McpPrompt, renderMcpPrompt } from "./mcp-prompts.js";

const COMMAND =
  /(^|\s)\/([\p{L}\p{N}][\p{L}\p{N}_:-]*(?:\/[\p{L}\p{N}][\p{L}\p{N}_:-]*)?)(?=\s|$)/gu;

/** Every `/name` token that starts the message or follows whitespace, in order, without repeats. */
export function chatCommandNames(message: string): string[] {
  return [...new Set([...message.matchAll(COMMAND)].map((match) => match[2] as string))];
}

export type ChatCommandLookup = {
  prompt: (name: string) => Pick<McpPrompt, "content"> | null;
  /** The skill's rendered instructions, or null when no visible skill has that name. */
  skill: (name: string) => string | null;
};

/**
 * Expands `/name` tokens anywhere in a chat message. A saved prompt wins over a skill of the same
 * name; unknown tokens stay as typed. Skills are loaded ahead of the message, prompts wrap the
 * remaining text as their request.
 */
export function expandChatCommands(message: string, lookup: ChatCommandLookup): string {
  const prompts: Pick<McpPrompt, "content">[] = [];
  const skills: { name: string; instructions: string }[] = [];
  const used = new Set<string>();
  for (const name of chatCommandNames(message)) {
    const prompt = lookup.prompt(name);
    if (prompt) {
      prompts.push(prompt);
      used.add(name);
      continue;
    }
    const instructions = lookup.skill(name);
    if (instructions !== null) {
      skills.push({ name, instructions });
      used.add(name);
    }
  }
  if (!used.size) return message;
  const request = message
    .replace(COMMAND, (token, lead: string, name: string) => (used.has(name) ? lead : token))
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  const loaded = skills.map(
    (skill) => `<skill name="${skill.name}">\n${skill.instructions.trim()}\n</skill>`,
  );
  if (prompts.length)
    return [...loaded, ...prompts.map((prompt) => renderMcpPrompt(prompt, request))].join("\n\n");
  const names = skills.map((skill) => `/${skill.name}`).join(", ");
  return [
    ...loaded,
    `The user loaded ${skills.length === 1 ? "the skill" : "the skills"} ${names} above. Follow ${skills.length === 1 ? "it" : "them"} for this message.`,
    request || "(no further request; apply the skill, asking what is needed if unclear)",
  ].join("\n\n");
}

export type RecallHit = { name: string; description: string; score?: number };

export type RecallResult = {
  skills: RecallHit[];
  memories: RecallHit[];
};

export type RecallOptions = {
  maxSkills: number;
  maxMemories: number;
  minSkillScore: number;
  budgetChars: number;
};

export const DEFAULT_RECALL: RecallOptions = {
  maxSkills: 3,
  maxMemories: 4,
  minSkillScore: 6,
  budgetChars: 900,
};

const STOPWORDS = new Set(
  "a about above after again all also am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers him his how i if in into is it its just let like make me more most my no nor not now of off on once only or other our out over own please really same she should so some such than that the their them then there these they this those through to too under until up us use using very was we were what when where which while who why will with would you your want need get got run see look check try add new fix change make create update file files code project".split(
    " ",
  ),
);

/** Distinctive lowercase tokens of a prompt, in first-seen order, for lexical ORC search. */
export function extractQuery(prompt: string, maxTerms = 12): string {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of prompt.toLowerCase().split(/[^\p{L}\p{N}_-]+/u)) {
    const token = raw.replace(/^[-_]+|[-_]+$/g, "");
    if (token.length < 3 || token.length > 40) continue;
    if (STOPWORDS.has(token) || /^\d+$/.test(token) || seen.has(token)) continue;
    seen.add(token);
    terms.push(token);
    if (terms.length >= maxTerms) break;
  }
  return terms.join(" ");
}

const SKILL_LINE = /^(\S+)\s+(?:\[[^\]]*\]\s+)?\(\d+ reads?\)\s+\[score:\s*([\d.]+)\]\s+-\s+(.*)$/;
const MEMORY_LINE =
  /^(\S+)\s+(?:\[p\d+\]\s+)?\(\d+ reads?\)\s+(?:\[score:\s*[\d.]+\]\s+)?-\s+(.*?)(?:\s+\[project: [^\]]+\])?$/;

/**
 * ORC search requires every term to match, so one long query finds nothing. Adjacent
 * term pairs keep the match specific while tolerating chatty prompts.
 */
export function queryWindows(prompt: string, maxTerms = 8): string[] {
  const terms = extractQuery(prompt, maxTerms).split(" ").filter(Boolean);
  if (terms.length <= 2) return terms.length ? [terms.join(" ")] : [];
  return terms.slice(0, -1).map((term, i) => `${term} ${terms[i + 1]}`);
}

export function parseSkillHits(text: string, minScore: number): RecallHit[] {
  const hits: RecallHit[] = [];
  for (const line of text.split("\n")) {
    const match = SKILL_LINE.exec(line.trim());
    if (!match?.[1]) continue;
    const score = Number(match[2]);
    if (Number.isFinite(score) && score >= minScore)
      hits.push({ name: match[1], description: match[3] ?? "", score });
  }
  return hits.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

export function parseMemoryHits(text: string): RecallHit[] {
  const hits: RecallHit[] = [];
  for (const line of text.split("\n")) {
    const match = MEMORY_LINE.exec(line.trim());
    if (match?.[1]) hits.push({ name: match[1], description: match[2] ?? "" });
  }
  return hits;
}

/** Union of per-window hits by name: best score first, then first-seen order. */
export function mergeHits(lists: RecallHit[][]): RecallHit[] {
  const best = new Map<string, RecallHit>();
  for (const hit of lists.flat()) {
    const known = best.get(hit.name);
    if (!known || (hit.score ?? 0) > (known.score ?? 0)) best.set(hit.name, hit);
  }
  return [...best.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, Math.max(max - 1, 1)).trimEnd()}…` : flat;
}

/**
 * Pointer-only recall: names and one-line descriptions, never bodies. Names already
 * offered in this session, or already loaded as Pi skills, are dropped so a long
 * session does not pay for the same hint twice.
 */
export function filterRecall(
  result: RecallResult,
  options: RecallOptions,
  already: ReadonlySet<string>,
  localSkills: ReadonlySet<string>,
): RecallResult {
  const skills = result.skills
    .filter((hit) => !localSkills.has(hit.name) && !already.has(`skill:${hit.name}`))
    .slice(0, options.maxSkills);
  const memories = result.memories
    .filter((hit) => !already.has(`memory:${hit.name}`))
    .slice(0, options.maxMemories);
  return { skills, memories };
}

export function recallKeys(result: RecallResult): string[] {
  return [
    ...result.skills.map((hit) => `skill:${hit.name}`),
    ...result.memories.map((hit) => `memory:${hit.name}`),
  ];
}

/** Render a compact hint, or undefined when there is nothing worth the tokens. */
export function formatRecall(result: RecallResult, budgetChars: number): string | undefined {
  if (!result.skills.length && !result.memories.length) return undefined;
  const lines = [
    "ORC found these relevant to the request. Pointers only; read before relying on them.",
  ];
  const per = Math.max(
    Math.floor(budgetChars / Math.max(result.skills.length + result.memories.length, 1)) - 16,
    40,
  );
  if (result.memories.length) {
    lines.push("Memories (orc memory_read name):");
    for (const hit of result.memories) lines.push(`- ${hit.name}: ${clip(hit.description, per)}`);
  }
  if (result.skills.length) {
    lines.push("Skills (orc skill_read name):");
    for (const hit of result.skills) lines.push(`- ${hit.name}: ${clip(hit.description, per)}`);
  }
  return lines.join("\n");
}

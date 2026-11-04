/**
 * identical: equal after normalizing line endings, trailing spaces and blank-line runs.
 * near: a tiny edit (a typo, a changed word); treated as the same item.
 * similar: largely the same text; worth a warning before keeping both.
 */
export type SimilarityLevel = "identical" | "near" | "similar" | "different";
export type Similarity = { level: SimilarityLevel; score: number };
export type TextProfile = { text: string; grams: Map<string, number>; size: number };

export const NEAR_RATIO = 0.97;
export const NEAR_MAX_EDITS = 3;
export const NEAR_MIN_LENGTH = 24;
export const SIMILAR_RATIO = 0.85;
const EDIT_DISTANCE_MAX_LENGTH = 20_000;

export function normalizeText(text: string): string {
  return text
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function textProfile(text: string): TextProfile {
  const normalized = normalizeText(text);
  const lower = normalized.toLowerCase();
  const grams = new Map<string, number>();
  for (let index = 0; index + 3 <= lower.length; index++) {
    const gram = lower.slice(index, index + 3);
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }
  return { text: normalized, grams, size: Math.max(0, lower.length - 2) };
}

function dice(left: TextProfile, right: TextProfile): number {
  if (!left.size && !right.size) return left.text === right.text ? 1 : 0;
  if (!left.size || !right.size) return 0;
  const [small, large] = left.grams.size <= right.grams.size ? [left, right] : [right, left];
  let shared = 0;
  for (const [gram, count] of small.grams) shared += Math.min(count, large.grams.get(gram) ?? 0);
  return (2 * shared) / (left.size + right.size);
}

/** Levenshtein distance when it is at most `limit`, otherwise limit + 1 (banded, O(n * limit)). */
export function boundedEditDistance(left: string, right: string, limit: number): number {
  if (Math.abs(left.length - right.length) > limit) return limit + 1;
  if (left === right) return 0;
  const width = right.length;
  let previous = new Array<number>(width + 1);
  let current = new Array<number>(width + 1);
  for (let column = 0; column <= width; column++) previous[column] = column;
  for (let row = 1; row <= left.length; row++) {
    const from = Math.max(1, row - limit);
    const to = Math.min(width, row + limit);
    current.fill(limit + 1);
    current[0] = row;
    let best = from === 1 ? row : limit + 1;
    for (let column = from; column <= to; column++) {
      const cost = left.charCodeAt(row - 1) === right.charCodeAt(column - 1) ? 0 : 1;
      const value = Math.min(
        (previous[column - 1] ?? limit + 1) + cost,
        (previous[column] ?? limit + 1) + 1,
        (current[column - 1] ?? limit + 1) + 1,
      );
      current[column] = value;
      if (value < best) best = value;
    }
    if (best > limit) return limit + 1;
    [previous, current] = [current, previous];
  }
  return Math.min(previous[width] ?? limit + 1, limit + 1);
}

export function compareProfiles(left: TextProfile, right: TextProfile): Similarity {
  if (left.text === right.text) return { level: "identical", score: 1 };
  const longest = Math.max(left.text.length, right.text.length);
  const shortest = Math.min(left.text.length, right.text.length);
  if (!longest || shortest / longest < SIMILAR_RATIO - 0.05)
    return { level: "different", score: 0 };
  const grams = dice(left, right);
  if (longest > 200 && grams < 0.8) return { level: "different", score: round(grams) };
  if (longest <= EDIT_DISTANCE_MAX_LENGTH) {
    const limit = Math.max(NEAR_MAX_EDITS, Math.floor(longest * (1 - NEAR_RATIO)));
    const distance = boundedEditDistance(left.text, right.text, limit);
    if (distance <= limit) {
      const ratio = 1 - distance / longest;
      const tiny = distance <= NEAR_MAX_EDITS && shortest >= NEAR_MIN_LENGTH;
      if (ratio >= NEAR_RATIO || tiny) return { level: "near", score: round(ratio) };
    }
  } else if (grams >= 0.985) return { level: "near", score: round(grams) };
  return grams >= SIMILAR_RATIO
    ? { level: "similar", score: round(grams) }
    : { level: "different", score: round(grams) };
}

export function compareText(left: string, right: string): Similarity {
  return compareProfiles(textProfile(left), textProfile(right));
}

const RANK: Record<SimilarityLevel, number> = { identical: 3, near: 2, similar: 1, different: 0 };

/** The closest candidate that is at least similar, preferring a stronger level, then a higher score. */
export function closestMatch<T>(
  profile: TextProfile,
  candidates: Iterable<{ key: T; profile: TextProfile }>,
): (Similarity & { key: T }) | null {
  let best: (Similarity & { key: T }) | null = null;
  for (const candidate of candidates) {
    const result = compareProfiles(profile, candidate.profile);
    if (result.level === "different") continue;
    if (
      !best ||
      RANK[result.level] > RANK[best.level] ||
      (RANK[result.level] === RANK[best.level] && result.score > best.score)
    )
      best = { ...result, key: candidate.key };
  }
  return best;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

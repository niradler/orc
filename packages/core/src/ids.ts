import { randomBytes } from "node:crypto";

const ENCODING = "0123456789abcdefghijklmnopqrstuvwxyz";
export const ID_LEN = 6;

export function ulid(): string {
  const bytes = randomBytes(ID_LEN);
  let str = "";
  for (let i = 0; i < ID_LEN; i++) {
    str += ENCODING[(bytes[i] ?? 0) % ENCODING.length];
  }
  return str;
}

export function shortId(id: string): string {
  return id.slice(-ID_LEN);
}

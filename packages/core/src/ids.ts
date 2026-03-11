import { randomBytes } from "crypto";

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ENCODING_LEN = ENCODING.length;
const TIME_LEN = 10;
const RANDOM_LEN = 16;

function encodeTime(now: number, len: number): string {
  let str = "";
  for (let i = len - 1; i >= 0; i--) {
    const mod = now % ENCODING_LEN;
    str = ENCODING[mod] + str;
    now = Math.floor(now / ENCODING_LEN);
  }
  return str;
}

function encodeRandom(len: number): string {
  const bytes = randomBytes(len);
  let str = "";
  for (let i = 0; i < len; i++) {
    str += ENCODING[(bytes[i] ?? 0) % ENCODING_LEN];
  }
  return str;
}

export function ulid(): string {
  return encodeTime(Date.now(), TIME_LEN) + encodeRandom(RANDOM_LEN);
}

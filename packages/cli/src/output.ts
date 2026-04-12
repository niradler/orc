export function isJson(): boolean {
  return process.argv.includes("--json");
}

export function jsonOut(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

export function jsonErr(msg: string): never {
  console.error(JSON.stringify({ error: msg }));
  process.exit(1);
}

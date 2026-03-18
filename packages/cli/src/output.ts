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

export function isDryRun(): boolean {
  return process.argv.includes("--dry-run");
}

export function dryRunMsg(action: string, resource: string, details?: unknown): void {
  console.log(`[dry-run] Would ${action} ${resource}`);
  if (details) console.log(JSON.stringify(details, null, 2));
}

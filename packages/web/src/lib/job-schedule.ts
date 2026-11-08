export function dailyCron(time: string, days: number[]): string {
  const [hour, minute] = time.split(":").map(Number);
  return `${minute} ${hour} * * ${[...days].sort().join(",")}`;
}

export function parseDailyCron(cron: string): { time: string; days: number[] } | null {
  const match = /^(\d{1,2}) (\d{1,2}) \* \* (\*|[0-6](?:,[0-6])*)$/.exec(cron);
  if (!match || Number(match[1]) > 59 || Number(match[2]) > 23) return null;
  return {
    time: `${match[2].padStart(2, "0")}:${match[1].padStart(2, "0")}`,
    days: match[3] === "*" ? [0, 1, 2, 3, 4, 5, 6] : match[3].split(",").map(Number),
  };
}

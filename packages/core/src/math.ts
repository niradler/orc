export function clamp(value: number, min: number, max: number): number {
  if (min > max) {
    throw new Error("clamp: min must be <= max");
  }
  return Math.min(Math.max(value, min), max);
}

export function roundTo(value: number, decimals: number): number {
  if (decimals < 0) {
    throw new Error("roundTo: decimals must be >= 0");
  }
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

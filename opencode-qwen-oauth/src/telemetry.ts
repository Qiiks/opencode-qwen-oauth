const counters = new Map<string, number>();

export function incrementCounter(name: string, amount = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + amount);
}

export function getCounter(name: string): number {
  return counters.get(name) ?? 0;
}

export function resetCounters(): void {
  counters.clear();
}

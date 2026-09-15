export function budgetItems<T>(items: readonly T[], budget: number, envelope: (selected: T[]) => unknown): { items: T[]; omitted: number } {
  const selected: T[] = [];
  for (const item of items) {
    const next = [...selected, item];
    if (Buffer.byteLength(JSON.stringify(envelope(next)), "utf8") > budget) break;
    selected.push(item);
  }
  return { items: selected, omitted: items.length - selected.length };
}

export function compact<T>(value: T): T {
  if (Array.isArray(value)) return value.map(compact).filter(v => v !== undefined) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && v !== null && v !== "" && (!Array.isArray(v) || v.length)).map(([k, v]) => [k, compact(v)])) as T;
  }
  return value;
}

export function truncateUtf8(value: string, maximumBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return { text: value, truncated: false };
  let text = "";
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maximumBytes) break;
    text += character;
    bytes += size;
  }
  return { text, truncated: true };
}

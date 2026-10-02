export class TemporaryResultCache<T> {
  private readonly entries = new Map<string, { value: T; expires: number; bytes: number }>();
  private bytes = 0;
  private context: string | undefined;
  private timer: NodeJS.Timeout | undefined;
  constructor(private readonly ttlMs = 120_000, private readonly maxEntries = 32, private readonly maxBytes = 16 * 1024 * 1024) {}
  get size(): number { return this.entries.size; }
  get byteSize(): number { return this.bytes; }
  get(key: string, context: string): T | undefined {
    this.useContext(context); this.evictExpired();
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key); this.entries.set(key, entry);
    return entry.value;
  }
  set(key: string, value: T, context: string): boolean {
    this.useContext(context); this.evictExpired(); this.delete(key);
    const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    if (bytes > this.maxBytes || this.maxEntries < 1) return false;
    while (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) this.delete(this.entries.keys().next().value!);
    this.entries.set(key, { value, expires: Date.now() + this.ttlMs, bytes }); this.bytes += bytes;
    this.scheduleExpiry();
    return true;
  }
  clear(): void {
    this.entries.clear(); this.bytes = 0;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
  private delete(key: string): void {
    const entry = this.entries.get(key);
    if (entry) { this.bytes -= entry.bytes; this.entries.delete(key); }
  }
  private useContext(context: string): void {
    if (this.context !== context) { this.clear(); this.context = context; }
  }
  private evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) if (entry.expires <= now) this.delete(key);
  }
  private scheduleExpiry(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.entries.size) return;
    const next = Math.min(...Array.from(this.entries.values(), entry => entry.expires));
    this.timer = setTimeout(() => { this.timer = undefined; this.evictExpired(); this.scheduleExpiry(); }, Math.max(1, next - Date.now()));
    this.timer.unref();
  }
}

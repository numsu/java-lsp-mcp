import type { Diagnostic } from "./protocol.js";
export interface DiagnosticSet { uri: string; version?: number; epoch: number; diagnostics: Diagnostic[]; receivedAt: number }
export class DiagnosticStore {
  private readonly sets = new Map<string, DiagnosticSet>();
  private epoch = 0;
  publish(uri: string, diagnostics: Diagnostic[], version?: number): void { this.sets.set(uri, { uri, diagnostics, ...(version !== undefined && { version }), epoch: ++this.epoch, receivedAt: Date.now() }); }
  get(uri: string): DiagnosticSet | undefined { return this.sets.get(uri); }
  all(): DiagnosticSet[] { return [...this.sets.values()]; }
  currentEpoch(): number { return this.epoch; }
  clear(): void { this.sets.clear(); }
  async waitFor(uri: string, version: number, timeoutMs: number, synchronizedAt = 0, signal?: AbortSignal): Promise<DiagnosticSet | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw signal.reason ?? new Error("Request cancelled");
      const set = this.get(uri);
      if (set && (set.version !== undefined ? set.version >= version : set.receivedAt >= synchronizedAt)) return set;
      await new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
    }
    return undefined;
  }

  async settleAfter(epoch: number, timeoutMs: number, quietMs = 100, signal?: AbortSignal): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let observed = this.epoch > epoch;
    let changedAt = observed ? Date.now() : 0;
    let current = this.epoch;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw signal.reason ?? new Error("Request cancelled");
      if (this.epoch !== current) { current = this.epoch; observed = true; changedAt = Date.now(); }
      if (observed && Date.now() - changedAt >= quietMs) return true;
      await new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
    }
    return observed;
  }
}

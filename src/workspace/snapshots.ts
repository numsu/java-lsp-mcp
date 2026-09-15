import { stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { sha256 } from "../results/edits.js";
import type { Snapshot } from "../types.js";
import type { WorkspacePaths } from "./paths.js";
import { SourceDecoder } from "./encoding.js";

export class SnapshotStore {
  private readonly values = new Map<string, Snapshot>();
  private sequence = 0;
  private readonly decoder: SourceDecoder;
  constructor(private readonly paths: WorkspacePaths, sourceEncoding?: string) { this.decoder = new SourceDecoder(paths, sourceEncoding); }
  async verify(relativePath: string): Promise<{ snapshot: Snapshot; changed: boolean }> {
    const absolute = this.paths.resolve(relativePath);
    const [content, metadata] = await Promise.all([this.decoder.read(absolute), stat(absolute)]);
    const normalized = this.paths.relative(absolute);
    const hash = sha256(content);
    const old = this.values.get(normalized);
    if (old?.hash === hash) return { snapshot: old, changed: false };
    const snapshot: Snapshot = { path: normalized, uri: pathToFileURL(absolute).href, content, hash, version: ++this.sequence, mtimeMs: metadata.mtimeMs };
    this.values.set(normalized, snapshot);
    return { snapshot, changed: true };
  }
  get(path: string): Snapshot | undefined { return this.values.get(path); }
  getByUri(uri: string): Snapshot | undefined { return [...this.values.values()].find(v => v.uri === uri); }
  delete(path: string): Snapshot | undefined { const old = this.values.get(path); this.values.delete(path); return old; }
  all(): Snapshot[] { return [...this.values.values()]; }
}

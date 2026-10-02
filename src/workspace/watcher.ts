import chokidar, { type FSWatcher } from "chokidar";
import { existsSync } from "node:fs";
import type { Snapshot } from "../types.js";
import type { Logger } from "../logging.js";
import type { LspClient } from "../jdtls/client.js";
import { SnapshotStore } from "./snapshots.js";
import type { WorkspacePaths } from "./paths.js";
import { ignoredDirectories, watchedProjectFiles } from "./files.js";

const descriptors = new Set<string>(watchedProjectFiles);
export class WorkspaceSynchronizer {
  readonly snapshots: SnapshotStore;
  indexGeneration = 0;
  private watcher?: FSWatcher;
  private readonly pending = new Map<string, boolean>();
  private timer: NodeJS.Timeout | undefined;
  private chain = Promise.resolve();
  constructor(private readonly paths: WorkspacePaths, private readonly client: LspClient, private readonly logger: Logger, sourceEncoding?: string) { this.snapshots = new SnapshotStore(paths, sourceEncoding, logger); }
  async start(): Promise<void> {
    this.watcher = chokidar.watch(["**/*.java", ...watchedProjectFiles.filter(name => !name.endsWith(".java")).map(name => `**/${name}`)], {
      cwd: this.paths.root, ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 25 },
      ignored: ignoredDirectories.map(directory => `**/${directory}/**`),
    });
    this.watcher.on("all", (_event, path) => this.queue(path.replaceAll("\\", "/")));
  }
  private queue(path: string): void {
    this.pending.set(path, true);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush(); }, 75);
  }
  async flush(relevant?: string[]): Promise<void> { await this.flushBatch(relevant); }
  private async flushBatch(relevant?: string[]): Promise<Map<string, Snapshot | Error>> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    for (const path of relevant ?? []) if (!this.pending.has(path)) this.pending.set(path, false);
    const batch = [...this.pending]; this.pending.clear();
    const verified = new Map<string, Snapshot | Error>();
    const pending = this.chain.then(async () => {
      for (const [path, externalChange] of batch) { const result = await this.sync(path, externalChange); if (result) verified.set(path, result); }
    });
    this.chain = pending;
    await pending;
    return verified;
  }
  async verify(path: string): Promise<Snapshot> {
    const verified = (await this.flushBatch([path])).get(path);
    if (verified instanceof Error) throw verified;
    return verified ?? (await this.snapshots.verify(path)).snapshot;
  }
  private async sync(path: string, externalChange: boolean): Promise<Snapshot | Error | undefined> {
    let verified: Snapshot | undefined;
    try {
      const absolute = this.paths.resolve(path, false);
      const old = this.snapshots.get(this.paths.relative(absolute));
      if (!existsSync(absolute)) {
        if (old) { this.snapshots.delete(old.path); await this.client.closeDocument(old); }
        await this.client.watchedFile(path, 3); if (old || externalChange) this.indexGeneration++; return;
      }
      let sourceChanged = false;
      if (path.endsWith(".java")) {
        const { snapshot, changed } = await this.snapshots.verify(path);
        verified = snapshot; sourceChanged = changed;
        if (changed && (old !== undefined || externalChange)) this.indexGeneration++;
        // Always offer the current snapshot to the client. syncDocument is
        // idempotent, and this retries didOpen when an earlier startup-race
        // attempt failed after the snapshot had already been cached.
        await this.client.syncDocument(snapshot, changed ? old : snapshot);
      }
      if (!path.endsWith(".java") || sourceChanged || externalChange) await this.client.watchedFile(path, old ? 2 : 1);
      if (externalChange && descriptors.has(path.split("/").at(-1)!)) { this.indexGeneration++; await this.client.refreshProjects(); }
      return verified;
    } catch (error) { this.logger.warn(`Failed to synchronize ${path}`, String(error)); return verified ?? (error instanceof Error ? error : new Error(String(error))); }
  }
  async close(): Promise<void> { if (this.timer) clearTimeout(this.timer); await this.flush(); await this.watcher?.close(); }
}

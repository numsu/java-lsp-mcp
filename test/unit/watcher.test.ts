import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Snapshot } from "../../src/types.js";
import type { LspClient } from "../../src/jdtls/client.js";
import { Logger } from "../../src/logging.js";
import { WorkspacePaths } from "../../src/workspace/paths.js";
import { WorkspaceSynchronizer } from "../../src/workspace/watcher.js";

test("an unchanged snapshot retries didOpen after a startup-race failure", async () => {
  let attempts = 0;
  const client = {
    async syncDocument(): Promise<void> {
      attempts++;
      if (attempts === 1) throw new Error("JDT LS is not running");
    },
    async watchedFile(): Promise<void> {},
    async closeDocument(): Promise<void> {},
    async refreshProjects(): Promise<void> {},
  } as unknown as LspClient;
  const sync = new WorkspaceSynchronizer(new WorkspacePaths(resolve("test/fixtures/unmanaged")), client, new Logger("error"));

  await sync.verify("src/Overloads.java");
  await sync.verify("src/Overloads.java");

  assert.equal(attempts, 2);
  assert.equal(sync.indexGeneration, 0, "observing an existing file for the first time is not a workspace change");
});

test("unconfigured legacy source is synchronized to JDT as decoded text", async t => {
  const root = await mkdtemp(join(tmpdir(), "java-lsp-mcp-sync-encoding-"));
  try {
    const source = 'class Legacy { String value = "\u00e4\u00f6"; }\r\n';
    await writeFile(join(root, "Legacy.java"), Buffer.from(source, "latin1"));
    const received: Snapshot[] = []; const logger = new Logger("warn");
    const warn = t.mock.method(logger, "warn", () => {});
    const client = {
      syncDocument: async (snapshot: Snapshot) => { received.push(snapshot); },
      watchedFile: async () => {},
    } as unknown as LspClient;
    const sync = new WorkspaceSynchronizer(new WorkspacePaths(root), client, logger);
    const snapshot = await sync.verify("Legacy.java");
    assert.equal(snapshot.content, source); assert.equal(received[0]?.content, source);
    assert.ok(warn.mock.calls.some(call => (call.arguments[0] ?? "").includes("Windows-1252")));
    assert.equal(sync.indexGeneration, 0);
    await sync.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("verification reads and hashes each file once while offering unchanged snapshots to JDT", async t => {
  const changes: number[] = []; const received: Snapshot[] = [];
  const client = { syncDocument: async (snapshot: Snapshot) => { received.push(snapshot); }, watchedFile: async (_path: string, kind: number) => { changes.push(kind); } } as unknown as LspClient;
  const sync = new WorkspaceSynchronizer(new WorkspacePaths(resolve("test/fixtures/unmanaged")), client, new Logger("error"));
  const verify = t.mock.method(sync.snapshots, "verify");
  const first = await sync.verify("src/Overloads.java");
  const second = await sync.verify("src/Overloads.java");
  assert.equal(verify.mock.callCount(), 2, "one read/decode/hash per verification");
  assert.equal(first, second); assert.deepEqual(received, [first, second]); assert.deepEqual(changes, [1]);
});

test("source changes invalidate the generation even when synchronization must be retried", async t => {
  const root = await mkdtemp(join(tmpdir(), "java-lsp-mcp-sync-change-"));
  try {
    const path = join(root, "A.java"); await writeFile(path, "class A {}\n");
    let fail = false;
    const client = { syncDocument: async () => { if (fail) throw new Error("offline"); }, watchedFile: async () => {} } as unknown as LspClient;
    const sync = new WorkspaceSynchronizer(new WorkspacePaths(root), client, new Logger("error"));
    const verify = t.mock.method(sync.snapshots, "verify");
    const before = await sync.verify("A.java");
    fail = true; await writeFile(path, "class A { int changed; }\n");
    const after = await sync.verify("A.java");
    assert.notEqual(before.hash, after.hash); assert.equal(sync.indexGeneration, 1); assert.equal(verify.mock.callCount(), 2);
    fail = false; assert.equal((await sync.verify("A.java")).hash, after.hash); assert.equal(sync.indexGeneration, 1);
    await sync.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("verification propagates source-read errors instead of returning a stale snapshot", async t => {
  const client = { syncDocument: async () => {}, watchedFile: async () => {} } as unknown as LspClient;
  const sync = new WorkspaceSynchronizer(new WorkspacePaths(resolve("test/fixtures/unmanaged")), client, new Logger("error"));
  await sync.verify("src/Overloads.java");
  const failure = new Error("source decoding failed");
  const verify = t.mock.method(sync.snapshots, "verify", async () => { throw failure; });
  await assert.rejects(sync.verify("src/Overloads.java"), error => error === failure);
  assert.equal(verify.mock.callCount(), 1);
});

test("verification detects equal-sized edits even when timestamps are unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "java-lsp-mcp-sync-same-stat-"));
  try {
    const path = join(root, "A.java"); const time = new Date("2025-01-01T00:00:00Z");
    await writeFile(path, "class A { int a; }\n"); await utimes(path, time, time);
    const client = { syncDocument: async () => {}, watchedFile: async () => {} } as unknown as LspClient;
    const sync = new WorkspaceSynchronizer(new WorkspacePaths(root), client, new Logger("error"));
    const first = await sync.verify("A.java");
    await writeFile(path, "class A { int b; }\n"); await utimes(path, time, time);
    const second = await sync.verify("A.java");
    assert.notEqual(first.hash, second.hash); assert.equal(first.mtimeMs, second.mtimeMs); assert.equal(sync.indexGeneration, 1);
    await sync.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

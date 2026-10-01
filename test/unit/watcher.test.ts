import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

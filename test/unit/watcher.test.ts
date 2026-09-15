import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
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

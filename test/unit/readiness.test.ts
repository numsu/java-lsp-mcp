import test from "node:test";
import assert from "node:assert/strict";
import { LspClient } from "../../src/jdtls/client.js";
import { Logger } from "../../src/logging.js";
import type { MessageConnection } from "vscode-jsonrpc/node.js";

const config = { workspace: "/workspace", offline: true, trustWorkspace: false, maxHeap: "1g", resultMode: "structured", logLevel: "error", timeoutMs: 1000, resultBudget: 12_000 } as const;

test("readiness wait completes on ready and terminal failure states", async () => {
  const ready = new LspClient(undefined, config, new Logger("error"));
  ready.state = "indexing";
  setTimeout(() => { ready.state = "ready"; }, 10);
  assert.equal(await ready.waitReady(1_000), true);

  const failed = new LspClient(undefined, config, new Logger("error"));
  failed.state = "indexing";
  setTimeout(() => { failed.state = "failed"; }, 10);
  assert.equal(await failed.waitReady(1_000), false);
});

test("semantic readiness waits for JDT progress and one shared workspace probe", async () => {
  const notifications = new Map<string, (params: any) => void>(); let probes = 0;
  const connection = {
    onRequest: () => ({ dispose() {} }), onNotification: (method: string, handler: (params: any) => void) => { notifications.set(method, handler); return { dispose() {} }; },
    sendRequest: async (method: string) => { if (method === "workspace/symbol") probes++; return []; }, sendNotification: () => {},
  } as unknown as MessageConnection;
  const client = new LspClient(undefined, config, new Logger("error")); client.attach(connection);
  notifications.get("language/status")?.({ type: "ServiceReady", message: "ServiceReady" }); notifications.get("language/progressReport")?.({ id: "build", task: "Building", complete: false });
  const waiting = Promise.all([client.waitReady(1_000), client.waitReady(1_000)]); await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(probes, 0); assert.equal(client.state, "building");
  notifications.get("language/progressReport")?.({ id: "build", task: "Building", complete: true }); assert.deepEqual(await waiting, [true, true]); assert.equal(probes, 1); assert.equal(client.state, "ready");

  notifications.get("language/progressReport")?.({ id: "rebuild", task: "Building", complete: false });
  assert.equal(client.state, "busy"); assert.equal(client.ready, true); assert.equal(client.activity, "Building");
  const rebuilding = client.waitReady(1_000); assert.equal(await rebuilding, true);
  notifications.get("language/progressReport")?.({ id: "rebuild", task: "Building", complete: true });
  assert.equal(client.state, "ready");
});

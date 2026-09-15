import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageConnection } from "vscode-jsonrpc/node.js";
import { LspClient } from "../../src/jdtls/client.js";
import { Logger } from "../../src/logging.js";
import type { Snapshot } from "../../src/types.js";

const config = { workspace: resolve("test/fixtures/unmanaged"), offline: true, trustWorkspace: false, maxHeap: "1g", resultMode: "structured", logLevel: "error", timeoutMs: 1000, resultBudget: 12_000 } as const;

function connection(requests: Array<{ method: string; params: unknown }>, notifications: Array<{ method: string; params: unknown }>, handlers = new Map<string, (params: any) => unknown>()): MessageConnection {
  return {
    onRequest: (method: string, handler: (params: any) => unknown) => { handlers.set(method, handler); return { dispose() {} }; },
    onNotification: () => ({ dispose() {} }),
    sendRequest: async (method: string, params: unknown) => { requests.push({ method, params }); return method === "initialize" ? { serverInfo: { version: "test" } } : {}; },
    sendNotification: (method: string, params: unknown) => { notifications.push({ method, params }); },
    dispose: () => {},
  } as unknown as MessageConnection;
}

test("JDT capabilities return edits to the MCP server and advertise resolvable code actions", async () => {
  const requests: Array<{ method: string; params: unknown }> = []; const notifications: Array<{ method: string; params: unknown }> = [];
  const client = new LspClient(undefined, config, new Logger("error")); client.attach(connection(requests, notifications));
  await client.initialize(pathToFileURL(config.workspace).href, 1, 1000);
  const initialize = requests.find(request => request.method === "initialize")!.params as any;
  assert.equal(initialize.capabilities.workspace.applyEdit, false);
  assert.equal(initialize.capabilities.workspace.workspaceEdit.resourceOperations, undefined);
  assert.equal(initialize.initializationOptions.extendedClientCapabilities.moveRefactoringSupport, false);
  assert.equal(initialize.initializationOptions.extendedClientCapabilities.advancedOrganizeImportsSupport, false);
  assert.equal(initialize.capabilities.textDocument.codeAction.dataSupport, true);
  assert.deepEqual(initialize.capabilities.textDocument.codeAction.resolveSupport.properties, ["edit", "command"]);
});

test("workspace configuration responses return the requested section", () => {
  const handlers = new Map<string, (params: any) => unknown>(); const client = new LspClient(undefined, config, new Logger("error")); client.attach(connection([], [], handlers));
  const result = handlers.get("workspace/configuration")?.({ items: [{ section: "java" }, { section: "java.configuration" }, { section: "missing" }, {}] }) as any[];
  assert.equal(result[0].autobuild.enabled, false); assert.equal(result[0].java, undefined); assert.equal(result[1].updateBuildConfiguration, "disabled"); assert.equal(result[2], undefined); assert.equal(result[3].java.autobuild.enabled, false);
});

test("project JDK settings use JDT's versioned execution-environment name", async () => {
  const jdk = await mkdtemp(join(tmpdir(), "java-lsp-mcp-jdk-"));
  try {
    await writeFile(join(jdk, "release"), 'JAVA_VERSION="25.0.2"\n'); const requests: Array<{ method: string; params: unknown }> = [];
    const client = new LspClient(undefined, { ...config, projectJdk: jdk }, new Logger("error")); client.attach(connection(requests, [])); await client.initialize(pathToFileURL(config.workspace).href, 1, 1000);
    const initialize = requests.find(request => request.method === "initialize")!.params as any;
    assert.deepEqual(initialize.initializationOptions.settings.java.configuration.runtimes, [{ name: "JavaSE-25", path: jdk, default: true }]);
  } finally { await rm(jdk, { recursive: true, force: true }); }
});

test("watched file notifications encode filesystem characters as file URIs", async () => {
  const requests: Array<{ method: string; params: unknown }> = []; const notifications: Array<{ method: string; params: unknown }> = [];
  const client = new LspClient(undefined, config, new Logger("error")); client.attach(connection(requests, notifications));
  await client.watchedFile("src/A#B.java", 2);
  const change = (notifications[0]!.params as any).changes[0];
  assert.equal(change.uri, pathToFileURL(resolve(config.workspace, "src/A#B.java")).href);
  assert.match(change.uri, /A%23B\.java$/u);
});

test("reattaching clears connection-specific documents and diagnostics", async () => {
  const firstNotifications: Array<{ method: string; params: unknown }> = []; const client = new LspClient(undefined, config, new Logger("error"));
  client.attach(connection([], firstNotifications));
  const snapshot: Snapshot = { path: "src/A.java", uri: pathToFileURL(resolve(config.workspace, "src/A.java")).href, content: "class A {}", hash: "one", version: 1, mtimeMs: 1 };
  await client.syncDocument(snapshot); client.diagnostics.publish(snapshot.uri, [], 1);
  const secondNotifications: Array<{ method: string; params: unknown }> = []; client.attach(connection([], secondNotifications)); await client.syncDocument(snapshot);
  assert.equal(secondNotifications[0]?.method, "textDocument/didOpen");
  assert.equal(client.diagnostics.get(snapshot.uri), undefined);
});

test("an unchanged open document does not acquire a false synchronization timestamp", async () => {
  const notifications: Array<{ method: string; params: unknown }> = []; const client = new LspClient(undefined, config, new Logger("error")); client.attach(connection([], notifications));
  const snapshot: Snapshot = { path: "src/A.java", uri: pathToFileURL(resolve(config.workspace, "src/A.java")).href, content: "class A {}", hash: "one", version: 1, mtimeMs: 1 };
  await client.syncDocument(snapshot); const synchronizedAt = snapshot.syncedAt;
  await new Promise(resolveDelay => setTimeout(resolveDelay, 5)); await client.syncDocument(snapshot, snapshot);
  assert.equal(snapshot.syncedAt, synchronizedAt); assert.equal(notifications.filter(item => item.method === "textDocument/didOpen").length, 1); assert.equal(notifications.some(item => item.method === "textDocument/didChange"), false);
});

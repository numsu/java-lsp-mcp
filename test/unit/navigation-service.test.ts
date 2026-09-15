import test from "node:test";
import assert from "node:assert/strict";
import type { LspClient } from "../../src/jdtls/client.js";
import { JavaService, resolveTestClasspathEntries, symbolNameMatches } from "../../src/mcp/service.js";
import type { Snapshot } from "../../src/types.js";
import type { WorkspacePaths } from "../../src/workspace/paths.js";
import type { WorkspaceSynchronizer } from "../../src/workspace/watcher.js";
import { WorkspacePaths as RealWorkspacePaths } from "../../src/workspace/paths.js";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const content = ["class A {", "  int x;", "  void m() {", "    x = x + 1;", "  }", "}"].join("\n");
const snapshot: Snapshot = { path: "src/A.java", uri: "file:///workspace/src/A.java", content, hash: "hash", version: 1, mtimeMs: 1 };
const fieldRange = { start: { line: 1, character: 2 }, end: { line: 1, character: 8 } };
const methodRange = { start: { line: 2, character: 2 }, end: { line: 4, character: 3 } };
const writeRange = { start: { line: 3, character: 4 }, end: { line: 3, character: 5 } };
const readRange = { start: { line: 3, character: 8 }, end: { line: 3, character: 9 } };
const outline = [{ name: "A", kind: 5, range: { start: { line: 0, character: 0 }, end: { line: 5, character: 1 } }, selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } }, children: [
  { name: "x", kind: 8, range: fieldRange, selectionRange: { start: { line: 1, character: 6 }, end: { line: 1, character: 7 } } },
  { name: "m()", kind: 6, range: methodRange, selectionRange: { start: { line: 2, character: 7 }, end: { line: 2, character: 8 } } },
] }];
const paths = { resolve: () => "C:/workspace/src/A.java", fromUri: () => ({ path: snapshot.path, origin: "workspace", editable: true }) } as unknown as WorkspacePaths;
const sync = { indexGeneration: 1, verify: async () => snapshot, flush: async () => {}, snapshots: { get: () => snapshot, getByUri: () => snapshot, all: () => [snapshot] } } as unknown as WorkspaceSynchronizer;
const config = { workspace: "/workspace", offline: true, trustWorkspace: false, maxHeap: "1g", resultMode: "structured", logLevel: "error", timeoutMs: 1000, resultBudget: 12_000 } as const;

test("additional test classpath entries resolve from the selected JDT project root", () => {
  const workspace = resolve("test/fixtures/unmanaged");
  const projectRoot = pathToFileURL(workspace).href;
  const sourceDirectory = resolve(workspace, "src");
  assert.deepEqual(resolveTestClasspathEntries(["src", sourceDirectory, "src"], projectRoot, resolve("test/fixtures")), [sourceDirectory]);
});

test("additional test classpath entries fail explicitly when a path is missing", () => {
  const workspace = resolve("test/fixtures/unmanaged");
  assert.throws(() => resolveTestClasspathEntries(["missing-test-resources"], pathToFileURL(workspace).href, workspace), /Additional test classpath entry does not exist/u);
});

test("symbol search modes have distinct matching semantics", () => {
  assert.equal(symbolNameMatches("getYTunnus", "getYTunnus", "exact"), true);
  assert.equal(symbolNameMatches("getYTunnusValue", "getYTunnus", "exact"), false);
  assert.equal(symbolNameMatches("getYTunnusValue", "getYTunnus", "prefix"), true);
  assert.equal(symbolNameMatches("getYTunnus", "gYT", "camelCase"), true);
  assert.equal(symbolNameMatches("forgetYourTunnus", "gYT", "camelCase"), false);
  assert.equal(symbolNameMatches("getYTunnus", "gytn", "fuzzy"), true);
  assert.equal(symbolNameMatches("getYTunnus", "xyz", "fuzzy"), false);
});

test("fuzzy symbol search broadens the JDT query and filters its candidates", async () => {
  let query = "";
  const location = { uri: snapshot.uri, range: fieldRange };
  const client = { state: "ready", waitReady: async () => true, symbols: async (value: string) => { query = value; return [{ name: "getYTunnus", kind: 6, location }, { name: "unrelated", kind: 6, location }]; } } as unknown as LspClient;
  const result = await new JavaService(config, paths, sync, client).search({ query: "gytn", mode: "fuzzy", scope: "workspace", includeImplementation: false, limit: 50, includeTotal: true }) as { symbols: Array<{ name: string }>; total: number };
  assert.equal(query, "*g*y*t*n*");
  assert.deepEqual(result.symbols.map(symbol => symbol.name), ["getYTunnus"]);
  assert.equal(result.total, 1);
});

test("reference filters use semantic read/write highlights and can include bounded context", async () => {
  const client = { state: "ready", waitReady: async () => true, references: async () => [{ uri: snapshot.uri, range: writeRange }, { uri: snapshot.uri, range: readRange }], documentHighlights: async () => [{ range: writeRange, kind: 3 }, { range: readRange, kind: 2 }], extendedOutline: async () => outline } as unknown as LspClient;
  const result = await new JavaService(config, paths, sync, client).references({ target: { path: snapshot.path, line: 2, column: 7 }, includeDeclaration: false, scope: "workspace", usageKinds: ["read"], includeEnclosing: true, includeText: false, contextLines: 1, maxSnippetCharacters: 1000, limit: 50, includeTotal: false }) as { references: Array<Record<string, unknown>> };
  assert.equal(result.references.length, 1);
  assert.equal(result.references[0]!.usageKind, "read");
  assert.deepEqual(result.references[0]!.enclosing, { kind: "method", name: "m()", startLine: 3, endLine: 5 });
  assert.deepEqual(result.references[0]!.snippet, { startLine: 3, endLine: 5, text: "  void m() {\n    x = x + 1;\n  }" });
  assert.equal("text" in result.references[0]!, false);
});

test("incoming call hierarchy filters test callers before applying per-node limits", async () => {
  const root = { name: "m()", kind: 6, uri: snapshot.uri, range: methodRange, selectionRange: methodRange };
  const testCaller = { name: "testCaller()", kind: 6, uri: "file:///workspace/test/ATest.java", range: methodRange, selectionRange: methodRange };
  const productionCaller = { name: "productionCaller()", kind: 6, uri: "file:///workspace/src/B.java", range: methodRange, selectionRange: methodRange };
  const client = {
    state: "ready", waitReady: async () => true, prepareCall: async () => [root], callIncoming: async () => [{ from: testCaller }, { from: productionCaller }],
    isTestFile: async (uri: string) => uri === testCaller.uri,
  } as unknown as LspClient;
  const localPaths = { resolve: () => "C:/workspace/src/A.java", fromUri: (uri: string) => ({ path: uri.split("/workspace/")[1] ?? uri, origin: "workspace", editable: true }) } as unknown as WorkspacePaths;
  const service = new JavaService(config, localPaths, sync, client);
  const request = { target: { path: snapshot.path, line: 3, column: 8 }, direction: "incoming" as const, depth: 1, limitPerNode: 1, limit: 50, includeTotal: true };

  const production = await service.callHierarchy({ ...request, callerScope: "production" }) as { nodes: Array<{ name: string }> };
  const tests = await service.callHierarchy({ ...request, callerScope: "tests" }) as { nodes: Array<{ name: string }> };
  const all = await service.callHierarchy({ ...request, callerScope: "all" }) as { nodes: Array<{ name: string }> };

  assert.deepEqual(production.nodes.map(node => node.name), ["productionCaller()"]);
  assert.deepEqual(tests.nodes.map(node => node.name), ["testCaller()"]);
  assert.deepEqual(all.nodes.map(node => node.name), ["testCaller()"]);
});

test("diagnostics returns pending paths when an empty result is not final", async () => {
  const client = { state: "ready", waitReady: async () => true, isDocumentOpen: () => false, closeDocument: async () => {}, diagnostics: { waitFor: async () => undefined, get: () => undefined, all: () => [] } } as unknown as LspClient;
  const result = await new JavaService(config, paths, sync, client).diagnostics({ scope: "path", path: snapshot.path, minimumSeverity: "warning", waitForCurrentVersion: true, includeText: false, timeoutMs: 1, limit: 50, includeTotal: false }) as Record<string, unknown>;
  assert.equal(result.status, "partial");
  assert.deepEqual(result.pendingPaths, [snapshot.path]);
  assert.match(String(result.message), /shared deadline/u);
  assert.equal("state" in result, false);
  assert.equal("complete" in result, false);
});

test("workspace diagnostics do not duplicate already synchronized files", async () => {
  const diagnostic = { range: writeRange, severity: 1, message: "once" }; const set = { uri: snapshot.uri, version: snapshot.version, epoch: 1, diagnostics: [diagnostic], receivedAt: 1 };
  const client = { state: "ready", waitReady: async () => true, isDocumentOpen: () => true, closeDocument: async () => {}, diagnostics: { waitFor: async () => set, get: () => set, all: () => [set] } } as unknown as LspClient;
  const result = await new JavaService(config, paths, sync, client).diagnostics({ scope: "workspace", minimumSeverity: "warning", waitForCurrentVersion: true, includeText: false, timeoutMs: 1000, limit: 50, includeTotal: true }) as { diagnostics: object[]; total: number };
  assert.equal(result.diagnostics.length, 1); assert.equal(result.total, 1);
});

test("multiple diagnostic paths share one parallel deadline", async () => {
  const second = { ...snapshot, path: "src/B.java", uri: "file:///workspace/src/B.java", hash: "other", version: 2 };
  const client = { state: "ready", waitReady: async () => true, isDocumentOpen: () => false, closeDocument: async () => {}, diagnostics: { waitFor: async (_uri: string, _version: number, timeoutMs: number) => { await new Promise(resolveDelay => setTimeout(resolveDelay, timeoutMs)); return undefined; }, get: () => undefined, all: () => [] } } as unknown as LspClient;
  const localSync = { indexGeneration: 1, verify: async (path: string) => path.endsWith("B.java") ? second : snapshot, flush: async () => {}, snapshots: { all: () => [snapshot, second] } } as unknown as WorkspaceSynchronizer;
  const started = Date.now(); const result = await new JavaService(config, paths, localSync, client).diagnostics({ scope: "paths", paths: [snapshot.path, second.path], minimumSeverity: "warning", waitForCurrentVersion: true, includeText: false, timeoutMs: 50, limit: 50, includeTotal: false }) as { status: string; pendingPaths: string[] };
  assert.ok(Date.now() - started < 80, "path waits should run concurrently"); assert.equal(result.status, "partial"); assert.deepEqual(result.pendingPaths, [snapshot.path, second.path]);
});

test("compile explains JDT WITH_ERROR when no diagnostics were published", async () => {
  const client = { state: "ready", waitReady: async () => true, build: async () => 2, diagnostics: { currentEpoch: () => 0, settleAfter: async () => false, all: () => [] } } as unknown as LspClient;
  const result = await new JavaService(config, paths, sync, client).compile({ kind: "incremental", minimumSeverity: "error", includeText: false, timeoutMs: 1000, limit: 100, includeTotal: true }) as Record<string, unknown>;
  assert.equal(result.buildStatus, "with-errors");
  assert.equal(result.success, false);
  assert.equal(result.diagnosticsComplete, false);
  assert.equal(result.complete, true);
  assert.match(String(result.message), /did not publish/u);
  assert.equal("buildFailures" in result, false);
});

test("compile collects diagnostics published immediately after a with-errors build", async () => {
  const diagnostic = { range: writeRange, severity: 1, message: "must be final or effectively final" }; let sets: object[] = [];
  const client = { state: "ready", waitReady: async () => true, build: async () => 2, diagnostics: { currentEpoch: () => 0, settleAfter: async () => { sets = [{ uri: snapshot.uri, epoch: 1, diagnostics: [diagnostic], receivedAt: Date.now() }]; return true; }, all: () => sets } } as unknown as LspClient;
  const result = await new JavaService(config, paths, sync, client).compile({ kind: "incremental", minimumSeverity: "error", includeText: false, timeoutMs: 1000, limit: 100, includeTotal: false }) as Record<string, unknown>;
  assert.equal(result.success, false); assert.equal(result.diagnosticsComplete, true); assert.equal((result.diagnostics as object[]).length, 1); assert.equal(result.message, undefined);
});

test("compilation pagination reuses the build result", async () => {
  let builds = 0; const diagnostics = [writeRange, readRange].map((range, index) => ({ range, severity: 2, message: `warning ${index}` }));
  const client = { state: "ready", waitReady: async () => true, build: async () => { builds++; return 1; }, diagnostics: { currentEpoch: () => 1, all: () => [{ uri: snapshot.uri, epoch: 1, diagnostics, receivedAt: 1 }] } } as unknown as LspClient;
  const service = new JavaService(config, paths, sync, client);
  const first = await service.compile({ kind: "incremental", minimumSeverity: "warning", includeText: false, timeoutMs: 1000, limit: 1, includeTotal: false }) as { diagnostics: object[]; nextCursor?: string };
  const second = await service.compile({ kind: "incremental", minimumSeverity: "warning", includeText: false, timeoutMs: 1000, limit: 50, includeTotal: true, cursor: first.nextCursor }) as { diagnostics: object[]; total: number };
  assert.equal(builds, 1); assert.equal(first.diagnostics.length, 1); assert.equal(second.diagnostics.length, 1); assert.equal(second.total, 2);
});

test("test runs reuse one successful compilation per workspace generation", async () => {
  const builds: boolean[] = [];
  const client = { state: "ready", waitReady: async () => true, isTestFile: async () => true, build: async (clean: boolean) => { builds.push(clean); return 1; }, diagnostics: { all: () => [] }, testClasspaths: async () => ({}) } as unknown as LspClient;
  const mutableSync = { indexGeneration: 7, verify: async () => snapshot, flush: async () => {}, snapshots: { get: () => snapshot, getByUri: () => snapshot, all: () => [snapshot] } };
  const service = new JavaService({ ...config, trustWorkspace: true }, paths, mutableSync as unknown as WorkspaceSynchronizer, client);
  const request = { path: snapshot.path, compile: "incremental" as const, compileProjectOnly: false, vmArgs: [], systemProperties: {}, timeoutMs: 1000, includeOutput: false, includeStackTrace: false, limit: 50, includeTotal: false };
  const run = (compile: "incremental" | "clean" = "incremental"): Promise<object> => service.runTests({ ...request, compile });
  await assert.rejects(run(), /no test runtime classpath/u);
  await assert.rejects(run(), /no test runtime classpath/u);
  assert.deepEqual(builds, [false]);
  await assert.rejects(run("clean"), /no test runtime classpath/u);
  await assert.rejects(run(), /no test runtime classpath/u);
  assert.deepEqual(builds, [false, true]);
  mutableSync.indexGeneration++;
  await assert.rejects(run(), /no test runtime classpath/u);
  assert.deepEqual(builds, [false, true, false]);
});

test("concurrent test runs share the same compilation", async () => {
  let builds = 0;
  const client = { state: "ready", waitReady: async () => true, isTestFile: async () => true, build: async () => { builds++; await new Promise(resolve => setTimeout(resolve, 20)); return 1; }, diagnostics: { all: () => [] }, testClasspaths: async () => ({}) } as unknown as LspClient;
  const service = new JavaService({ ...config, trustWorkspace: true }, paths, sync, client); const request = { path: snapshot.path, compile: "incremental" as const, compileProjectOnly: false, vmArgs: [], systemProperties: {}, timeoutMs: 1000, includeOutput: false, includeStackTrace: false, limit: 50, includeTotal: false };
  await Promise.allSettled([service.runTests(request), service.runTests(request)]); assert.equal(builds, 1);
});

test("compileProjectOnly builds only the JDT project containing the selected test", async () => {
  const workspace = resolve("test/fixtures/unmanaged"); const logicUri = pathToFileURL(resolve(workspace, "logic")).href; const testsUri = pathToFileURL(resolve(workspace, "tests")).href; const localSnapshot = { ...snapshot, path: "tests/src/A.java", uri: pathToFileURL(resolve(workspace, "tests/src/A.java")).href }; let built: string[] = [];
  const client = { state: "ready", waitReady: async () => true, isTestFile: async () => true, projects: async () => [logicUri, testsUri], buildProjects: async (uris: string[]) => { built = uris; return 1; }, diagnostics: { all: () => [] }, testClasspaths: async () => ({}) } as unknown as LspClient;
  const localSync = { indexGeneration: 1, verify: async () => localSnapshot, flush: async () => {}, snapshots: { all: () => [localSnapshot] } } as unknown as WorkspaceSynchronizer;
  const localPaths = { root: workspace, fromUri: () => ({ path: localSnapshot.path, origin: "workspace", editable: true }) } as unknown as WorkspacePaths;
  const request = { path: localSnapshot.path, compile: "incremental" as const, compileProjectOnly: true, vmArgs: [], systemProperties: {}, timeoutMs: 1000, includeOutput: false, includeStackTrace: false, limit: 50, includeTotal: false };
  await assert.rejects(new JavaService({ ...config, workspace, trustWorkspace: true }, localPaths, localSync, client).runTests(request), /no test runtime classpath/u); assert.deepEqual(built, [testsUri]);
});

test("failed test compilation is not reused", async () => {
  let builds = 0;
  const client = { state: "ready", waitReady: async () => true, isTestFile: async () => true, build: async () => { builds++; return 2; }, diagnostics: { all: () => [] } } as unknown as LspClient;
  const service = new JavaService({ ...config, trustWorkspace: true }, paths, sync, client);
  const request = { path: snapshot.path, compile: "incremental" as const, compileProjectOnly: false, vmArgs: [], systemProperties: {}, timeoutMs: 1000, includeOutput: false, includeStackTrace: false, limit: 50, includeTotal: false };
  assert.equal((await service.runTests(request) as { status: string }).status, "compile-failed");
  assert.equal((await service.runTests(request) as { status: string }).status, "compile-failed");
  assert.equal(builds, 2);
});

test("unused-code analysis closes documents that it opened", async () => {
  let closes = 0;
  const client = { state: "ready", waitReady: async () => true, isDocumentOpen: () => false, extendedOutline: async () => outline, closeDocument: async () => { closes++; } } as unknown as LspClient;
  const result = await new JavaService(config, paths, sync, client).unusedCode({ path: snapshot.path, kinds: ["method"], includeWriteOnly: true, timeoutMs: 1000, limit: 50, includeTotal: false }) as { complete: boolean };
  assert.equal(result.complete, true); assert.equal(closes, 1);
});

test("compile builds only JDT projects not excluded at startup", async () => {
  const workspace = resolve("test/fixtures/unmanaged"); const realPaths = new RealWorkspacePaths(workspace); const logicUri = pathToFileURL(resolve(workspace, "logic")).href; const testsUri = pathToFileURL(resolve(workspace, "tests")).href; let built: string[] = [];
  const diagnostic = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, severity: 1, message: "excluded error" };
  const client = { state: "ready", waitReady: async () => true, projects: async () => [logicUri, testsUri], build: async () => { throw new Error("whole-workspace build must not be used"); }, buildProjects: async (uris: string[]) => { built = uris; return 1; }, diagnostics: { currentEpoch: () => 1, all: () => [{ uri: testsUri, epoch: 1, diagnostics: [diagnostic], receivedAt: 1 }] } } as unknown as LspClient;
  const localSync = { indexGeneration: 1, flush: async () => {}, snapshots: { get: () => undefined, getByUri: () => undefined, all: () => [] } } as unknown as WorkspaceSynchronizer;
  const result = await new JavaService({ ...config, workspace, excludedProjects: ["tests"] }, realPaths, localSync, client).compile({ kind: "incremental", minimumSeverity: "error", includeText: false, timeoutMs: 1000, limit: 100, includeTotal: true }) as Record<string, unknown>;
  assert.deepEqual(built, [logicUri]);
  assert.deepEqual(result.excludedProjects, ["tests"]);
  assert.equal(result.success, true);
  assert.deepEqual(result.diagnostics, []);
});

test("an unknown excluded project fails instead of silently building it", async () => {
  const workspace = resolve("test/fixtures/unmanaged"); const realPaths = new RealWorkspacePaths(workspace); const logicUri = pathToFileURL(resolve(workspace, "logic")).href;
  const client = { state: "ready", waitReady: async () => true, projects: async () => [logicUri], buildProjects: async () => 1, diagnostics: { currentEpoch: () => 0, all: () => [] } } as unknown as LspClient;
  const localSync = { indexGeneration: 1, flush: async () => {}, snapshots: { all: () => [] } } as unknown as WorkspaceSynchronizer;
  const result = await new JavaService({ ...config, workspace, excludedProjects: ["typo"] }, realPaths, localSync, client).compile({ kind: "incremental", minimumSeverity: "error", includeText: false, timeoutMs: 1000, limit: 100, includeTotal: false }) as { success: boolean; buildFailures?: string[] };
  assert.equal(result.success, false);
  assert.match(result.buildFailures?.[0] ?? "", /EXCLUDED_PROJECT_NOT_FOUND|Excluded project not found/u);
});

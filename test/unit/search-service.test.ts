import test from "node:test";
import assert from "node:assert/strict";
import type { LspClient } from "../../src/jdtls/client.js";
import { JavaService } from "../../src/mcp/service.js";
import type { WorkspacePaths } from "../../src/workspace/paths.js";
import type { WorkspaceSynchronizer } from "../../src/workspace/watcher.js";
import type { Snapshot } from "../../src/types.js";
import { JavaLspMcpError } from "../../src/types.js";
import { WorkspacePaths as RealWorkspacePaths } from "../../src/workspace/paths.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

test("symbol search returns one line anchor instead of a declaration range", async () => {
  const client = {
    state: "ready",
    waitReady: async () => true,
    symbols: async () => [{
      name: "MaksuService",
      kind: 5,
      containerName: "fi.om.x.service",
      location: { uri: "file:///workspace/src/MaksuService.java", range: { start: { line: 17, character: 0 }, end: { line: 246, character: 1 } } },
    }],
  } as unknown as LspClient;
  const paths = { fromUri: () => ({ path: "src/MaksuService.java", origin: "workspace", editable: true }) } as unknown as WorkspacePaths;
  const sync = { indexGeneration: 1, flush: async () => {} } as unknown as WorkspaceSynchronizer;
  const config = { workspace: "/workspace", offline: true, trustWorkspace: false, maxHeap: "1g", resultMode: "structured", logLevel: "error", timeoutMs: 1000, resultBudget: 12_000 } as const;
  const service = new JavaService(config, paths, sync, client);

  const result = await service.search({ query: "Maksu", scope: "workspace", mode: "fuzzy", includeImplementation: false, limit: 50, includeTotal: false }) as { symbols: Record<string, unknown>[] };
  assert.deepEqual(result.symbols, [{ name: "MaksuService", kind: "class", container: "fi.om.x.service", path: "src/MaksuService.java", line: 18 }]);
});

test("a unique method search can include its complete implementation range", async () => {
  const content = ["class Company {", "  String getYTunnus() {", "    return \"löytyi\";", "  }", "}"].join("\n");
  const snapshot: Snapshot = { path: "src/Company.java", uri: "file:///workspace/src/Company.java", content, hash: "hash", version: 1, mtimeMs: 1 };
  const methodRange = { start: { line: 1, character: 2 }, end: { line: 3, character: 3 } }; const selectionRange = { start: { line: 1, character: 9 }, end: { line: 1, character: 19 } };
  const symbol = { name: "getYTunnus", kind: 6, containerName: "Company", location: { uri: snapshot.uri, range: selectionRange } };
  const client = { state: "ready", waitReady: async () => true, symbols: async () => [symbol], extendedOutline: async () => [{ name: "Company", kind: 5, range: { start: { line: 0, character: 0 }, end: { line: 4, character: 1 } }, selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } }, children: [{ name: "getYTunnus()", kind: 6, range: methodRange, selectionRange }] }] } as unknown as LspClient;
  const paths = { fromUri: () => ({ path: snapshot.path, origin: "workspace", editable: true }) } as unknown as WorkspacePaths;
  const sync = { indexGeneration: 1, flush: async () => {}, verify: async () => snapshot } as unknown as WorkspaceSynchronizer;
  const config = { workspace: "/workspace", offline: true, trustWorkspace: false, maxHeap: "1g", resultMode: "structured", logLevel: "error", timeoutMs: 1000, resultBudget: 12_000 } as const;
  const result = await new JavaService(config, paths, sync, client).search({ query: "getYTunnus", scope: "workspace", mode: "exact", kinds: ["method"], includeImplementation: true, limit: 50, includeTotal: false }) as { symbols: Array<Record<string, unknown>> };
  assert.deepEqual(result.symbols[0], { name: "getYTunnus", kind: "method", container: "Company", path: snapshot.path, startLine: 2, endLine: 4, implementation: "  String getYTunnus() {\n    return \"löytyi\";\n  }" });
});

test("implementation lookup tolerates a signature in the workspace symbol name", async () => {
  const content = ["class Company {", "  String getYTunnus() {", "    return \"löytyi\";", "  }", "}"].join("\n");
  const snapshot: Snapshot = { path: "src/Company.java", uri: "file:///workspace/src/Company.java", content, hash: "hash", version: 1, mtimeMs: 1 };
  const methodRange = { start: { line: 1, character: 2 }, end: { line: 3, character: 3 } }; const selectionRange = { start: { line: 1, character: 9 }, end: { line: 1, character: 19 } };
  const symbol = { name: "getYTunnus(java.lang.String)", kind: 6, containerName: "Company", location: { uri: snapshot.uri, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } } } };
  const client = { state: "ready", waitReady: async () => true, symbols: async () => [symbol], extendedOutline: async () => [{ name: "Company", kind: 5, range: { start: { line: 0, character: 0 }, end: { line: 4, character: 1 } }, selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } }, children: [{ name: "getYTunnus()", kind: 6, range: methodRange, selectionRange }] }] } as unknown as LspClient;
  const paths = { fromUri: () => ({ path: snapshot.path, origin: "workspace", editable: true }) } as unknown as WorkspacePaths;
  const sync = { indexGeneration: 1, flush: async () => {}, verify: async () => snapshot } as unknown as WorkspaceSynchronizer;
  const config = { workspace: "/workspace", offline: true, trustWorkspace: false, maxHeap: "1g", resultMode: "structured", logLevel: "error", timeoutMs: 1000, resultBudget: 12_000 } as const;
  const result = await new JavaService(config, paths, sync, client).search({ query: "getYTunnus", scope: "workspace", mode: "exact", kinds: ["method"], includeImplementation: true, limit: 50, includeTotal: false }) as { symbols: Array<Record<string, unknown>> };
  assert.equal(result.symbols[0]?.startLine, 2); assert.equal(result.symbols[0]?.endLine, 4);
  assert.match(String(result.symbols[0]?.implementation), /return "löytyi";/u);
});

test("a unique class search includes at most 200 source lines", async () => {
  const content = ["class Large {", ...Array.from({ length: 203 }, (_, index) => `  int field${index};`), "}"].join("\n");
  const snapshot: Snapshot = { path: "src/Large.java", uri: "file:///workspace/src/Large.java", content, hash: "hash", version: 1, mtimeMs: 1 };
  const classRange = { start: { line: 0, character: 0 }, end: { line: 204, character: 1 } }; const selectionRange = { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } };
  const symbol = { name: "Large", kind: 5, containerName: "example", location: { uri: snapshot.uri, range: selectionRange } };
  const client = { state: "ready", waitReady: async () => true, symbols: async () => [symbol], extendedOutline: async () => [{ name: "Large", kind: 5, range: classRange, selectionRange }] } as unknown as LspClient;
  const paths = { fromUri: () => ({ path: snapshot.path, origin: "workspace", editable: true }) } as unknown as WorkspacePaths;
  const sync = { indexGeneration: 1, flush: async () => {}, verify: async () => snapshot } as unknown as WorkspaceSynchronizer;
  const config = { workspace: "/workspace", offline: true, trustWorkspace: false, maxHeap: "1g", resultMode: "structured", logLevel: "error", timeoutMs: 1000, resultBudget: 20_000 } as const;
  const result = await new JavaService(config, paths, sync, client).search({ query: "Large", scope: "workspace", mode: "exact", kinds: ["class"], includeImplementation: true, limit: 50, includeTotal: false }) as { symbols: Array<Record<string, unknown>> };
  assert.equal(result.symbols[0]?.startLine, 1); assert.equal(result.symbols[0]?.endLine, 205); assert.equal(String(result.symbols[0]?.implementation).split("\n").length, 200); assert.equal(result.symbols[0]?.implementationTruncated, true); assert.equal("line" in result.symbols[0]!, false);
});

test("implementation is omitted when the filtered search is ambiguous", async () => {
  const location = { uri: "file:///workspace/src/A.java", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } };
  const client = { state: "ready", waitReady: async () => true, symbols: async () => [{ name: "find", kind: 6, location }, { name: "find", kind: 6, location: { ...location, uri: "file:///workspace/src/B.java" } }] } as unknown as LspClient;
  const paths = { fromUri: (uri: string) => ({ path: uri.endsWith("A.java") ? "src/A.java" : "src/B.java", origin: "workspace", editable: true }) } as unknown as WorkspacePaths;
  const sync = { indexGeneration: 1, flush: async () => {} } as unknown as WorkspaceSynchronizer;
  const config = { workspace: "/workspace", offline: true, trustWorkspace: false, maxHeap: "1g", resultMode: "structured", logLevel: "error", timeoutMs: 1000, resultBudget: 12_000 } as const;
  const result = await new JavaService(config, paths, sync, client).search({ query: "find", scope: "workspace", mode: "exact", includeImplementation: true, limit: 1, includeTotal: true }) as { symbols: Array<Record<string, unknown>>; total: number };
  assert.equal(result.total, 2); assert.equal(result.symbols.length, 1); assert.equal("implementation" in result.symbols[0]!, false);
});

test("exact method search tolerates signatures in indexed names", async () => {
  let query = "";
  const location = { uri: "file:///workspace/src/A.java", range: { start: { line: 1, character: 2 }, end: { line: 1, character: 6 } } };
  const client = { state: "ready", waitReady: async () => true, symbols: async (value: string) => { query = value; return [{ name: "work(java.lang.String)", kind: 6, containerName: "com.example.A", location }]; } } as unknown as LspClient;
  const paths = { fromUri: () => ({ path: "src/A.java", origin: "workspace", editable: true }) } as unknown as WorkspacePaths;
  const sync = { indexGeneration: 1, flush: async () => {} } as unknown as WorkspaceSynchronizer;
  const config = { workspace: "/workspace", offline: true, trustWorkspace: false, maxHeap: "1g", resultMode: "structured", logLevel: "error", timeoutMs: 1000, resultBudget: 12_000 } as const;
  const result = await new JavaService(config, paths, sync, client).search({ query: "work", scope: "workspace", mode: "exact", kinds: ["method"], includeImplementation: false, limit: 50, includeTotal: true }) as { symbols: Array<Record<string, unknown>>; total: number };
  assert.equal(query, "work");
  assert.equal(result.total, 1);
  assert.equal(result.symbols[0]?.name, "work(java.lang.String)");
});

test("exact and prefix searches include workspace enum constants", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "java-lsp-mcp-enums-"));
  try {
    await writeFile(join(workspace, "Language.java"), "enum Language { FINNISH, SWEDISH; }\n");
    const realPaths = new RealWorkspacePaths(workspace); const client = { state: "ready", waitReady: async () => true, symbols: async () => [] } as unknown as LspClient;
    const localSync = { indexGeneration: 0, flush: async () => {} } as unknown as WorkspaceSynchronizer;
    const service = new JavaService({ workspace, offline: true, trustWorkspace: false, maxHeap: "1g", resultMode: "structured", logLevel: "error", timeoutMs: 1000, resultBudget: 12_000 }, realPaths, localSync, client);
    const exact = await service.search({ query: "FINNISH", scope: "workspace", mode: "exact", kinds: ["enumMember"], includeImplementation: false, limit: 50, includeTotal: true }) as { symbols: Array<Record<string, unknown>>; total: number };
    const prefix = await service.search({ query: "SWE", scope: "workspace", mode: "prefix", kinds: ["enumMember"], includeImplementation: false, limit: 50, includeTotal: true }) as { symbols: Array<Record<string, unknown>>; total: number };
    assert.deepEqual(exact.symbols, [{ name: "FINNISH", kind: "enumMember", container: "Language", path: "Language.java", line: 1 }]); assert.equal(exact.total, 1);
    assert.deepEqual(prefix.symbols.map(item => item.name), ["SWEDISH"]); assert.equal(prefix.total, 1);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("optional implementation decoding failure returns the symbol and a warning", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "java-lsp-mcp-encoding-warning-"));
  try {
    const realPaths = new RealWorkspacePaths(workspace); const uri = pathToFileURL(join(workspace, "Legacy.java")).href;
    const symbol = { name: "Legacy", kind: 5, location: { uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } } } };
    const client = { state: "ready", waitReady: async () => true, symbols: async () => [symbol] } as unknown as LspClient;
    const localSync = { indexGeneration: 0, flush: async () => {}, verify: async () => { throw new JavaLspMcpError("SOURCE_ENCODING_REQUIRED", "Source file is not valid UTF-8"); } } as unknown as WorkspaceSynchronizer;
    const result = await new JavaService({ workspace, offline: true, trustWorkspace: false, maxHeap: "1g", resultMode: "structured", logLevel: "error", timeoutMs: 1000, resultBudget: 12_000 }, realPaths, localSync, client).search({ query: "Legacy", scope: "workspace", mode: "exact", kinds: ["class"], includeImplementation: true, limit: 50, includeTotal: false }) as { symbols: object[]; warnings: Array<Record<string, unknown>> };
    assert.equal(result.symbols.length, 1); assert.equal(result.warnings[0]?.code, "SOURCE_ENCODING_REQUIRED"); assert.match(String(result.warnings[0]?.message), /implementation was omitted/u);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

import test from "node:test";
import assert from "node:assert/strict";
import type { LspClient } from "../../src/jdtls/client.js";
import { JavaService } from "../../src/mcp/service.js";
import type { WorkspacePaths } from "../../src/workspace/paths.js";
import type { WorkspaceSynchronizer } from "../../src/workspace/watcher.js";
import type { Snapshot } from "../../src/types.js";

test("definition omits whitespace-only documentation", async () => {
  const snapshot: Snapshot = { path: "src/A.java", uri: "file:///workspace/src/A.java", content: "class A {}", hash: "hash", version: 1, mtimeMs: 1 };
  const location = { uri: snapshot.uri, range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } } };
  const outline = [{ name: "A", kind: 5, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } }, selectionRange: location.range }];
  const client = { state: "ready", waitReady: async () => true, definition: async () => location, hover: async () => ({ contents: { kind: "markdown", value: "\n  \n" } }), extendedOutline: async () => outline } as unknown as LspClient;
  const paths = { fromUri: () => ({ path: snapshot.path, origin: "workspace", editable: true }) } as unknown as WorkspacePaths;
  const sync = { indexGeneration: 1, verify: async () => snapshot, flush: async () => {}, snapshots: { get: () => snapshot, getByUri: () => snapshot } } as unknown as WorkspaceSynchronizer;
  const config = { workspace: "/workspace", offline: true, trustWorkspace: false, maxHeap: "1g", resultMode: "structured", logLevel: "error", timeoutMs: 1000, resultBudget: 12_000 } as const;
  const result = await new JavaService(config, paths, sync, client).definition({ target: { path: snapshot.path, line: 1, column: 7 }, expand: [], contextLines: 10, maxSourceCharacters: 4000, includeDocumentation: true, maxDocumentationCharacters: 1000, limit: 50, includeTotal: false }) as { documentation?: string; definitions: Array<Record<string, unknown>> };
  assert.equal(result.documentation, undefined);
  assert.deepEqual(result.definitions[0], { path: snapshot.path, line: 1, column: 7, endLine: 1, endColumn: 8, kind: "class", name: "A", declarationStartLine: 1, declarationEndLine: 1 });
});

test("qualified targets query the member name before a parameter signature", async () => {
  const snapshot: Snapshot = { path: "src/A.java", uri: "file:///workspace/src/A.java", content: "class A {}", hash: "hash", version: 1, mtimeMs: 1 }; let query = "";
  const location = { uri: snapshot.uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } };
  const client = { state: "ready", waitReady: async () => true, symbols: async (value: string) => { query = value; return [{ name: "work", containerName: "com.example.Other", kind: 6, location }, { name: "work", containerName: "com.example.A", kind: 6, location }, { name: "work", containerName: "com.example.A", kind: 6, location }]; }, definition: async () => null } as unknown as LspClient;
  const paths = { fromUri: () => ({ path: snapshot.path, origin: "workspace", editable: true }) } as unknown as WorkspacePaths; const sync = { indexGeneration: 1, verify: async () => snapshot, flush: async () => {} } as unknown as WorkspaceSynchronizer;
  const config = { workspace: "/workspace", offline: true, trustWorkspace: false, maxHeap: "1g", resultMode: "structured", logLevel: "error", timeoutMs: 1000, resultBudget: 12_000 } as const;
  await new JavaService(config, paths, sync, client).definition({ target: { qualifiedName: "com.example.A#work(java.lang.String)" }, expand: [], contextLines: 0, maxSourceCharacters: 1000, includeDocumentation: false, maxDocumentationCharacters: 0, limit: 10, includeTotal: false });
  assert.equal(query, "work");
});

test("qualified resolution tolerates a signature in the indexed symbol name", async () => {
  const snapshot: Snapshot = { path: "src/A.java", uri: "file:///workspace/src/A.java", content: "class A {}", hash: "hash", version: 1, mtimeMs: 1 }; let query = "";
  const location = { uri: snapshot.uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } };
  const client = { state: "ready", waitReady: async () => true, symbols: async (value: string) => { query = value; return [{ name: "work(java.lang.String)", containerName: "com.example.A", kind: 6, location }]; }, definition: async () => null } as unknown as LspClient;
  const paths = { fromUri: () => ({ path: snapshot.path, origin: "workspace", editable: true }) } as unknown as WorkspacePaths; const sync = { indexGeneration: 1, verify: async () => snapshot, flush: async () => {} } as unknown as WorkspaceSynchronizer;
  const config = { workspace: "/workspace", offline: true, trustWorkspace: false, maxHeap: "1g", resultMode: "structured", logLevel: "error", timeoutMs: 1000, resultBudget: 12_000 } as const;
  await new JavaService(config, paths, sync, client).definition({ target: { qualifiedName: "com.example.A#work" }, expand: [], contextLines: 0, maxSourceCharacters: 1000, includeDocumentation: false, maxDocumentationCharacters: 0, limit: 10, includeTotal: false });
  assert.equal(query, "work");
});

test("qualified resolution falls back to a trailing container match", async () => {
  const snapshot: Snapshot = { path: "src/A.java", uri: "file:///workspace/src/A.java", content: "class A {}", hash: "hash", version: 1, mtimeMs: 1 }; let query = "";
  const location = { uri: snapshot.uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } };
  const client = { state: "ready", waitReady: async () => true, symbols: async (value: string) => { query = value; return [{ name: "work", containerName: "Inner", kind: 6, location }]; }, definition: async () => null } as unknown as LspClient;
  const paths = { fromUri: () => ({ path: snapshot.path, origin: "workspace", editable: true }) } as unknown as WorkspacePaths; const sync = { indexGeneration: 1, verify: async () => snapshot, flush: async () => {} } as unknown as WorkspaceSynchronizer;
  const config = { workspace: "/workspace", offline: true, trustWorkspace: false, maxHeap: "1g", resultMode: "structured", logLevel: "error", timeoutMs: 1000, resultBudget: 12_000 } as const;
  await new JavaService(config, paths, sync, client).definition({ target: { qualifiedName: "com.example.Outer.Inner.work" }, expand: [], contextLines: 0, maxSourceCharacters: 1000, includeDocumentation: false, maxDocumentationCharacters: 0, limit: 10, includeTotal: false });
  assert.equal(query, "work");
});

test("qualified resolution prefers an exact container over a trailing match", async () => {
  const snapshot: Snapshot = { path: "src/A.java", uri: "file:///workspace/src/A.java", content: "class A {}", hash: "hash", version: 1, mtimeMs: 1 };
  const exact = { uri: snapshot.uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } } };
  const partial = { uri: snapshot.uri, range: { start: { line: 5, character: 0 }, end: { line: 5, character: 4 } } };
  const client = {
    state: "ready", waitReady: async () => true,
    symbols: async () => [{ name: "work", containerName: "com.example.A", kind: 6, location: exact }, { name: "work", containerName: "A", kind: 6, location: partial }],
    references: async (_uri: string, position: { line: number }) => position.line === 0 ? [{ uri: snapshot.uri, range: exact.range }] : [],
  } as unknown as LspClient;
  const paths = { fromUri: () => ({ path: snapshot.path, origin: "workspace", editable: true }) } as unknown as WorkspacePaths;
  const sync = { indexGeneration: 1, verify: async () => snapshot, flush: async () => {}, snapshots: { get: () => snapshot, getByUri: () => snapshot } } as unknown as WorkspaceSynchronizer;
  const config = { workspace: "/workspace", offline: true, trustWorkspace: false, maxHeap: "1g", resultMode: "structured", logLevel: "error", timeoutMs: 1000, resultBudget: 12_000 } as const;
  const result = await new JavaService(config, paths, sync, client).references({ target: { qualifiedName: "com.example.A.work" }, includeDeclaration: false, scope: "workspace", includeEnclosing: false, includeText: false, contextLines: 0, maxSnippetCharacters: 1000, limit: 50, includeTotal: false }) as { references: object[] };
  assert.equal(result.references.length, 1);
});

test("qualified resolution reports ambiguous trailing matches and hints at alternatives", async () => {
  const snapshot: Snapshot = { path: "src/A.java", uri: "file:///workspace/src/A.java", content: "class A {}", hash: "hash", version: 1, mtimeMs: 1 };
  const first = { uri: snapshot.uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } };
  const second = { uri: snapshot.uri, range: { start: { line: 5, character: 0 }, end: { line: 5, character: 1 } } };
  const client = { state: "ready", waitReady: async () => true, symbols: async () => [{ name: "work", containerName: "A", kind: 6, location: first }, { name: "work", containerName: "example.A", kind: 6, location: second }], definition: async () => null } as unknown as LspClient;
  const paths = { fromUri: () => ({ path: snapshot.path, origin: "workspace", editable: true }) } as unknown as WorkspacePaths; const sync = { indexGeneration: 1, verify: async () => snapshot, flush: async () => {} } as unknown as WorkspaceSynchronizer;
  const config = { workspace: "/workspace", offline: true, trustWorkspace: false, maxHeap: "1g", resultMode: "structured", logLevel: "error", timeoutMs: 1000, resultBudget: 12_000 } as const;
  const service = new JavaService(config, paths, sync, client);
  await assert.rejects(service.definition({ target: { qualifiedName: "com.example.A.work" }, expand: [], contextLines: 0, maxSourceCharacters: 1000, includeDocumentation: false, maxDocumentationCharacters: 0, limit: 10, includeTotal: false }), /ambiguous/u);
  const missing = await service.references({ target: { qualifiedName: "com.example.Missing.work" }, includeDeclaration: false, scope: "workspace", includeEnclosing: false, includeText: false, contextLines: 0, maxSnippetCharacters: 1000, limit: 50, includeTotal: false }).then(() => undefined, error => error as Error);
  assert.match(missing?.message ?? "", /java_search_symbols|source position/u);
});

test("qualified definition returns its semantic location when source decoding fails", async () => {
  const location = { uri: "file:///workspace/src/Legacy.java", range: { start: { line: 4, character: 2 }, end: { line: 4, character: 8 } } };
  const client = { state: "ready", waitReady: async () => true, symbols: async () => [{ name: "work", containerName: "com.example.Legacy", kind: 6, location }], definition: async () => location, hover: async () => ({ contents: "Legacy documentation" }) } as unknown as LspClient;
  const paths = { fromUri: () => ({ path: "src/Legacy.java", origin: "workspace", editable: true }) } as unknown as WorkspacePaths;
  const sync = { indexGeneration: 1, verify: async () => { throw new Error("SOURCE_ENCODING_REQUIRED"); }, flush: async () => {}, snapshots: { get: () => undefined } } as unknown as WorkspaceSynchronizer;
  const config = { workspace: "/workspace", offline: true, trustWorkspace: false, maxHeap: "1g", resultMode: "structured", logLevel: "error", timeoutMs: 1000, resultBudget: 12_000 } as const;
  const result = await new JavaService(config, paths, sync, client).definition({ target: { qualifiedName: "com.example.Legacy.work" }, expand: ["body", "context"], contextLines: 10, maxSourceCharacters: 1000, includeDocumentation: true, maxDocumentationCharacters: 1000, limit: 10, includeTotal: true }) as { definitions: Array<Record<string, unknown>>; documentation?: string; total: number };

  assert.equal(result.total, 1);
  assert.equal(result.definitions[0]?.path, "src/Legacy.java");
  assert.equal(result.documentation, "Legacy documentation");
  assert.equal(result.definitions[0]?.body, undefined);
});

import test from "node:test";
import assert from "node:assert/strict";
import type { LspClient } from "../../src/jdtls/client.js";
import type { DocumentSymbol } from "../../src/jdtls/protocol.js";
import { JavaService } from "../../src/mcp/service.js";
import type { WorkspacePaths } from "../../src/workspace/paths.js";
import type { WorkspaceSynchronizer } from "../../src/workspace/watcher.js";
import type { Snapshot } from "../../src/types.js";

const sourceLines = [
  "package example;",
  "public class Example {",
  "  public void firstMaksu() {}",
  "  private void secondMaksu() {}",
  "  protected void hiddenMaksu() {}",
  "  void packageMaksu() {}",
  "}",
];
const source = sourceLines.join("\n");
const snapshot: Snapshot = { path: "src/Example.java", uri: "file:///workspace/src/Example.java", content: source, hash: "source-hash", version: 1, mtimeMs: 1 };
const range = (line: number, name: string) => ({ start: { line, character: 0 }, end: { line, character: sourceLines[line]!.length }, selection: { start: { line, character: sourceLines[line]!.indexOf(name) }, end: { line, character: sourceLines[line]!.indexOf(name) + name.length } } });
const method = (line: number, name: string): DocumentSymbol => { const r = range(line, name); return { name: `${name}()`, kind: 6, range: { start: r.start, end: r.end }, selectionRange: r.selection }; };
const classRange = range(1, "Example");
const symbols: DocumentSymbol[] = [
  { name: "example", kind: 4, range: { start: { line: 0, character: 0 }, end: { line: 0, character: sourceLines[0]!.length } }, selectionRange: { start: { line: 0, character: 8 }, end: { line: 0, character: 15 } } },
  { name: "Example", kind: 5, range: { start: classRange.start, end: { line: 6, character: 1 } }, selectionRange: classRange.selection, children: [method(2, "firstMaksu"), method(3, "secondMaksu"), method(4, "hiddenMaksu"), method(5, "packageMaksu")] },
];

test("compact outline filters and paginates without repeated location metadata", async () => {
  const client = { state: "ready", statusMessage: "ready", serverVersion: "test", waitReady: async () => true, extendedOutline: async () => symbols } as unknown as LspClient;
  const sync = { indexGeneration: 3, verify: async () => snapshot, flush: async () => {}, snapshots: { getByUri: () => snapshot } } as unknown as WorkspaceSynchronizer;
  const config = { workspace: "/workspace", offline: true, trustWorkspace: false, maxHeap: "1g", resultMode: "structured", logLevel: "error", timeoutMs: 1000, resultBudget: 12_000 } as const;
  const service = new JavaService(config, {} as WorkspacePaths, sync, client);
  const input = { path: snapshot.path, depth: 2, visibility: ["public", "package", "private"] as const, kinds: ["method"], format: "compact" as const, limit: 2, includeTotal: false, namePattern: ".*Maksu.*" };

  const first = await service.outline({ ...input, visibility: [...input.visibility] }) as { symbols: Record<string, unknown>[]; total?: number; nextCursor?: string };
  assert.equal(first.symbols.length, 2); assert.equal(first.total, undefined); assert.ok(first.nextCursor);
  assert.deepEqual(Object.keys(first.symbols[0]!), ["kind", "name", "visibility", "depth", "startLine", "endLine"]);
  const second = await service.outline({ ...input, visibility: [...input.visibility], cursor: first.nextCursor, limit: 10, includeTotal: true }) as { symbols: Record<string, unknown>[]; total?: number; nextCursor?: string };
  assert.equal(second.symbols.length, 1); assert.equal(second.total, 3); assert.equal(second.nextCursor, undefined); assert.equal(second.symbols[0]!.name, "packageMaksu()");
  const counted = await service.outline({ ...input, includeTotal: true, visibility: [...input.visibility] }) as { symbols: Record<string, unknown>[]; total?: number };
  assert.equal(counted.total, 3);
  await assert.rejects(service.outline({ ...input, visibility: [...input.visibility], containingLine: 4, cursor: first.nextCursor }), /different query/u);
  const enclosing = await service.outline({ ...input, kinds: ["class", "method"], visibility: [...input.visibility], containingLine: 4, namePattern: undefined, limit: 10 }) as { symbols: Record<string, unknown>[] };
  assert.deepEqual(enclosing.symbols.map(symbol => symbol.name), ["Example", "secondMaksu()"]);
});

import test from "node:test";
import assert from "node:assert/strict";
import { JavaService } from "../../src/mcp/service.js";
import { inputs } from "../../src/mcp/schemas.js";
import type { LspClient } from "../../src/jdtls/client.js";
import type { Snapshot } from "../../src/types.js";
import type { WorkspacePaths } from "../../src/workspace/paths.js";
import type { WorkspaceSynchronizer } from "../../src/workspace/watcher.js";
import type { SymbolInformation, Location } from "../../src/jdtls/protocol.js";

const snapshot: Snapshot = { path: "src/A.java", uri: "file:///workspace/src/A.java", content: "class A {\n int a;\n int b;\n int c;\n}\n", hash: "hash", version: 1, mtimeMs: 1 };
const location = (line: number): Location => ({ uri: snapshot.uri, range: { start: { line, character: 1 }, end: { line, character: 2 } } });
const symbol = (name: string, line: number): SymbolInformation => ({ name, kind: 5, location: location(line) });
const config = { workspace: "/workspace", offline: true, trustWorkspace: false, maxHeap: "1g", resultMode: "structured", logLevel: "error", timeoutMs: 1000, resultBudget: 12_000 } as const;
function fixture() {
  const calls = { symbols: 0, references: 0, outlines: 0, highlights: 0, verifies: 0 };
  let symbols = [symbol("A1", 1), symbol("A2", 2), symbol("A3", 3)];
  const client = { sessionGeneration: 1, state: "ready", waitReady: async () => true,
    symbols: async () => { calls.symbols++; return symbols; }, references: async () => { calls.references++; return [location(1), location(2), location(3)]; },
    documentHighlights: async () => { calls.highlights++; return [1, 2, 3].map(line => ({ range: location(line).range, kind: 2 })); },
    extendedOutline: async () => { calls.outlines++; return [{ name: "A", kind: 5, range: { start: { line: 0, character: 0 }, end: { line: 4, character: 1 } }, selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } } }]; } };
  const sync = { indexGeneration: 1, verify: async () => { calls.verifies++; return snapshot; }, flush: async () => {}, snapshots: { get: () => snapshot, getByUri: () => snapshot, all: () => [snapshot] } };
  const paths = { fromUri: () => ({ path: snapshot.path, origin: "workspace", editable: true }) } as unknown as WorkspacePaths;
  return { calls, sync, client, service: new JavaService(config, paths, sync as unknown as WorkspaceSynchronizer, client as unknown as LspClient), setSymbols: (value: SymbolInformation[]) => { symbols = value; } };
}
const search = () => inputs.java_search_symbols.parse({ queries: [{ query: "A", limit: 1 }] }).queries[0]!;
const references = () => inputs.java_find_references.parse({ target: { path: snapshot.path, line: 1, column: 1 }, limit: 1 });
type Page = { symbols?: Array<{ name: string }>; references?: Array<{ line: number; usageKind?: string }>; total?: number; nextCursor?: string };

for (const kind of ["search", "references"] as const) {
  test(kind + " reuses one collection across changed page sizes and totals", async () => {
    const f = fixture();
    const first = await f.service[kind](kind === "search" ? search() as never : references() as never) as Page;
    assert.ok(first.nextCursor);
    const second = kind === "search" ? await f.service.search({ ...search(), cursor: first.nextCursor, limit: 2, includeTotal: true }) as Page : await f.service.references({ ...references(), cursor: first.nextCursor, limit: 2, includeTotal: true }) as Page;
    assert.equal(second.total, 3); assert.equal(second.nextCursor, undefined);
    assert.equal(f.calls[kind === "search" ? "symbols" : "references"], 1);
    if (kind === "search") assert.deepEqual(second.symbols?.map(item => item.name), ["A2", "A3"]);
    else assert.deepEqual(second.references?.map(item => item.line), [3, 4]);
  });

  test(kind + " returns a restart error after TTL eviction without recalculating", async t => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
    const f = fixture(); const input = kind === "search" ? search() : references();
    const first = await f.service[kind](input as never) as Page;
    t.mock.timers.tick(120_000);
    await assert.rejects(f.service[kind]({ ...input, cursor: first.nextCursor } as never), { code: "STALE_RESULT_SET" });
    assert.equal(f.calls[kind === "search" ? "symbols" : "references"], 1);
  });

  test(kind + " rejects workspace changes and JDT reconnects without recalculating", async () => {
    for (const change of ["workspace", "session"]) {
      const f = fixture(); const input = kind === "search" ? search() : references();
      const first = await f.service[kind](input as never) as Page;
      if (change === "workspace") f.sync.indexGeneration++; else f.client.sessionGeneration++;
      await assert.rejects(f.service[kind]({ ...input, cursor: first.nextCursor } as never), { code: change === "workspace" ? "STALE_CURSOR" : "STALE_RESULT_SET" });
      assert.equal(f.calls[kind === "search" ? "symbols" : "references"], 1);
    }
  });
}

test("fresh identical searches keep independent snapshots for existing cursors", async () => {
  const f = fixture(); const first = await f.service.search(search()) as Page;
  f.setSymbols([symbol("AX", 1), symbol("AY", 2)]);
  const fresh = await f.service.search(search()) as Page;
  assert.equal(fresh.symbols?.[0]?.name, "AX");
  const oldPage = await f.service.search({ ...search(), cursor: first.nextCursor }) as Page;
  const freshPage = await f.service.search({ ...search(), cursor: fresh.nextCursor }) as Page;
  assert.equal(oldPage.symbols?.[0]?.name, "A2"); assert.equal(freshPage.symbols?.[0]?.name, "AY"); assert.equal(f.calls.symbols, 2);
});

test("reference pages reuse target resolution, within outlines, and usage classification", async () => {
  const f = fixture();
  f.setSymbols([symbol("A", 0)]);
  const input = inputs.java_find_references.parse({ target: { qualifiedName: "A" }, within: { path: snapshot.path, line: 1, column: 1 }, usageKinds: ["read"], limit: 1 });
  const first = await f.service.references(input) as Page;
  const second = await f.service.references({ ...input, cursor: first.nextCursor }) as Page;
  assert.equal(second.references?.[0]?.usageKind, "read");
  assert.equal(f.calls.symbols, 1); assert.equal(f.calls.references, 1); assert.equal(f.calls.outlines, 1); assert.equal(f.calls.highlights, 1);
});

test("a changed verified reference target rejects a cached continuation", async () => {
  const f = fixture(); const first = await f.service.references(references()) as Page;
  f.sync.verify = async () => { f.sync.indexGeneration++; return snapshot; };
  await assert.rejects(f.service.references({ ...references(), cursor: first.nextCursor }), { code: "STALE_CURSOR" });
  assert.equal(f.calls.references, 1);
});

test("cache capacity eviction keeps recently accessed result snapshots", async () => {
  const f = fixture(); const pages: Page[] = [];
  for (let index = 0; index < 32; index++) pages.push(await f.service.search(search()) as Page);
  await f.service.search({ ...search(), cursor: pages[0]!.nextCursor });
  await f.service.search(search());
  await assert.rejects(f.service.search({ ...search(), cursor: pages[1]!.nextCursor }), { code: "STALE_RESULT_SET" });
  const retained = await f.service.search({ ...search(), cursor: pages[0]!.nextCursor }) as Page;
  assert.equal(retained.symbols?.[0]?.name, "A2"); assert.equal(f.calls.symbols, 33);
});

test("malformed and mismatched cursors fail before performing navigation work", async () => {
  const f = fixture(); const first = await f.service.search(search()) as Page;
  await assert.rejects(f.service.search({ ...search(), cursor: first.nextCursor, query: "B" }), { code: "CURSOR_QUERY_MISMATCH" });
  await assert.rejects(f.service.references({ ...references(), cursor: "invalid" }), { code: "INVALID_CURSOR" });
  assert.equal(f.calls.symbols, 1); assert.equal(f.calls.references, 0); assert.equal(f.calls.verifies, 0);
});

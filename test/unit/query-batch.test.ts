import test from "node:test";
import assert from "node:assert/strict";
import { runQueryBatch } from "../../src/mcp/server.js";
import { JavaLspMcpError } from "../../src/types.js";

test("batch dispatch preserves order, duplicates, independent options and page metadata", async () => {
  const queries = [{ query: "A", limit: 1, cursor: "page-a" }, { query: "B", limit: 2 }, { query: "A", limit: 3 }];
  const seen: typeof queries = [];
  const result = await runQueryBatch(queries, async query => {
    seen.push(query);
    return { symbols: [query], nextCursor: query.query + query.limit, total: query.limit };
  }, new AbortController().signal);
  assert.deepEqual(seen, queries);
  assert.deepEqual(result.results, queries.map(query => ({ symbols: [query], nextCursor: query.query + query.limit, total: query.limit })));
});

test("batch dispatch retains successful lookups around semantic and unexpected failures", async () => {
  const result = await runQueryBatch(["A", "missing", "broken", "B"], async target => {
    if (target === "missing") throw new JavaLspMcpError("SYMBOL_NOT_FOUND", "missing", { target });
    if (target === "broken") throw new Error("broken");
    return { definitions: [{ target }] };
  }, new AbortController().signal);
  assert.deepEqual(result.results, [{ definitions: [{ target: "A" }] }, { error: { code: "SYMBOL_NOT_FOUND", message: "missing", details: { target: "missing" } } }, { error: { code: "INTERNAL_ERROR", message: "broken" } }, { definitions: [{ target: "B" }] }]);
});

test("cancelling a batch stops dispatching remaining lookups", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled");
  const seen: number[] = [];
  await assert.rejects(runQueryBatch([1, 2], async query => {
    seen.push(query);
    controller.abort(reason);
    return { definitions: [] };
  }, controller.signal), error => error === reason);
  assert.deepEqual(seen, [1]);
});

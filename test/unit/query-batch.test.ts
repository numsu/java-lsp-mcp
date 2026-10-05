import test from "node:test";
import assert from "node:assert/strict";
import { runQueryBatch, textResult } from "../../src/mcp/server.js";
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


for (const name of ["java_find_references", "java_call_hierarchy"] as const) {
  test(name + " batches preserve per-query defaults, pagination and errors", async () => {
    const { inputs, outputs } = await import("../../src/mcp/schemas.js");
    const query = { target: { qualifiedName: "A.work" }, ...(name === "java_call_hierarchy" && { direction: "incoming" as const }) };
    for (const queries of [[], Array(21).fill(query)]) assert.equal(inputs[name].safeParse({ queries }).success, queries.length > 0);
    assert.equal(inputs[name].safeParse(query).success, false);
    assert.equal(inputs[name].safeParse({ queries: [query] }).success, true);
    const parsed = inputs[name].parse({ queries: [query, { ...query, target: { qualifiedName: "missing" } }, { ...query, cursor: "page-2", limit: 2 }] });
    assert.equal(parsed.queries[0]!.limit, 50);
    if (name === "java_call_hierarchy") assert.equal(inputs.java_call_hierarchy.parse({ queries: [query] }).queries[0]!.callerScope, "production");
    const seen: unknown[] = [];
    const batch = await runQueryBatch<(typeof parsed.queries)[number]>(parsed.queries, async value => {
      seen.push(value);
      if ("qualifiedName" in value.target && value.target.qualifiedName === "missing") throw new JavaLspMcpError("SYMBOL_NOT_FOUND", "missing");
      return name === "java_find_references" ? { references: [{ path: "A.java", line: 1, column: 2 }], total: 3, nextCursor: "next" } : { root: { name: "work" }, nodes: [], edges: [], total: 3, nextCursor: "next" };
    }, new AbortController().signal);
    const validated = outputs[name].parse(batch);
    assert.deepEqual(seen, parsed.queries);
    assert.equal(validated.results.length, 3);
    assert.deepEqual(validated.results[1], { error: { code: "SYMBOL_NOT_FOUND", message: "missing" } });
    assert.ok("nextCursor" in validated.results[2]! && validated.results[2].nextCursor === "next");
  });
}

test("batched references render every page and error in text mode", () => {
  assert.equal(textResult("java_find_references", { results: [{ references: [{ path: "A.java", line: 2, column: 3, text: "work();" }] }, { error: { code: "SYMBOL_NOT_FOUND", message: "missing" } }, { references: [] }] }), "1: A.java:2:3: work();\n2: SYMBOL_NOT_FOUND: missing\n3: no results");
});


for (const name of ["java_type_hierarchy", "java_find_affected_tests", "java_code_actions"] as const) {
  test(name + " requires batches and preserves ordered pages, defaults and partial failures", async () => {
    const { inputs, outputs } = await import("../../src/mcp/schemas.js");
    const { normalizeInput } = await import("../../src/mcp/input-normalization.js");
    const query = name === "java_code_actions" ? { path: "A.java", range: { line: 1, column: 1, endLine: 2, endColumn: 1 } } : { target: { qualifiedName: "A" } };
    assert.equal(inputs[name].safeParse(query).success, false);
    assert.equal(inputs[name].safeParse({ queries: [] }).success, false);
    assert.equal(inputs[name].safeParse({ queries: [query] }).success, true);
    const normalized = normalizeInput(inputs[name], { queries: Array(21).fill(query) });
    assert.equal(inputs[name].parse(normalized.input).queries.length, 20);
    assert.deepEqual(normalized.warnings.map(w => [w.path, w.requested, w.applied]), [["queries", 21, 20]]);
    const parsed = inputs[name].parse({ queries: [query, { ...query, limit: 1 }, { ...query, limit: 2, cursor: "page-2", includeTotal: true }] });
    assert.equal(parsed.queries[0]!.limit, 50);
    assert.equal(parsed.queries[2]!.cursor, "page-2");
    if (name === "java_type_hierarchy") {
      const defaults = inputs.java_type_hierarchy.parse({ queries: [query] }).queries[0]!;
      assert.equal(defaults.direction, "both"); assert.equal(defaults.depth, 2);
    } else if (name === "java_find_affected_tests") {
      const defaults = inputs.java_find_affected_tests.parse({ queries: [query] }).queries[0]!;
      assert.equal(defaults.transitive, true); assert.equal(defaults.maxDepth, 10); assert.equal(defaults.timeoutMs, 120000);
    } else {
      const defaults = inputs.java_code_actions.parse({ queries: [query] }).queries[0]!;
      assert.deepEqual(defaults.kinds, ["quickfix"]); assert.deepEqual(defaults.diagnosticCodes, []);
    }
    const page = name === "java_type_hierarchy" ? { root: { name: "A" }, nodes: [], edges: [], total: 3, nextCursor: "next" } : name === "java_find_affected_tests" ? { tests: [{ className: "ATest" }], complete: false, message: "partial", total: 3, nextCursor: "next" } : { actions: [{ id: "action-1" }], total: 3, nextCursor: "next" };
    const seen: unknown[] = [];
    const batch = await runQueryBatch<(typeof parsed.queries)[number]>(parsed.queries, async value => {
      seen.push(value);
      if (value.limit === 1) throw new JavaLspMcpError("SYMBOL_NOT_FOUND", "missing");
      return page;
    }, new AbortController().signal);
    assert.deepEqual(seen, parsed.queries);
    const validated = outputs[name].parse(batch);
    assert.deepEqual(validated.results, [page, { error: { code: "SYMBOL_NOT_FOUND", message: "missing" } }, page]);
  });
}

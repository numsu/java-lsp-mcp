import test from "node:test";
import assert from "node:assert/strict";
import { inputs } from "../../src/mcp/schemas.js";
test("symbol target is a strict discriminated union", () => { assert.equal(inputs.java_find_definition.safeParse({ target: { path: "A.java", line: 1, column: 1 } }).success, true); assert.equal(inputs.java_find_definition.safeParse({ target: { path: "A.java", line: 1, column: 1, qualifiedName: "A" } }).success, false); });
test("limits are bounded", () => assert.equal(inputs.java_search_symbols.safeParse({ query: "A", limit: 201 }).success, false));
test("source ranges are ordered and diagnostic scope parameters are unambiguous", () => {
  assert.equal(inputs.java_code_actions.safeParse({ path: "A.java", range: { line: 2, column: 1, endLine: 1, endColumn: 1 } }).success, false);
  assert.equal(inputs.java_diagnostics.safeParse({ scope: "workspace", path: "A.java" }).success, false);
  assert.equal(inputs.java_diagnostics.safeParse({ scope: "paths", paths: [] }).success, false);
});
test("outline accepts compact filters and a nullable first-page cursor", () => {
  const result = inputs.java_outline.parse({ path: "src/Example.java", depth: 2, visibility: ["public", "package", "private"], kinds: ["class", "constructor", "method"], format: "compact", limit: 100, cursor: null, namePattern: ".*Maksu.*" });
  assert.equal(result.cursor, undefined);
  assert.equal(result.limit, 100);
  assert.equal(result.namePattern, ".*Maksu.*");
  assert.equal(result.includeTotal, false);
});
test("source text, totals, and edit diffs are opt-in", () => {
  const target = { path: "src/Example.java", line: 1, column: 1 };
  const references = inputs.java_find_references.parse({ target });
  assert.equal(references.includeText, false);
  assert.equal(references.contextLines, 0);
  assert.equal(references.includeEnclosing, false);
  assert.equal(references.usageKinds, undefined);
  assert.deepEqual(inputs.java_find_definition.parse({ target }).expand, []);
  assert.equal(inputs.java_diagnostics.parse({ scope: "path", path: "src/Example.java" }).includeText, false);
  assert.equal(inputs.java_compile.parse({}).includeText, false);
  assert.equal(inputs.java_edit_preview.parse({ operation: "format", path: "src/Example.java" }).includeDiff, false);
  assert.equal(inputs.java_search_symbols.parse({ query: "Example" }).includeTotal, false);
  assert.equal(inputs.java_search_symbols.parse({ query: "Example" }).includeImplementation, false);
});
test("status offers a bounded blocking readiness probe", () => {
  assert.deepEqual(inputs.java_status.parse({}), { waitForReady: false, timeoutMs: 120_000 });
  assert.deepEqual(inputs.java_status.parse({ waitForReady: true, timeoutMs: 5_000 }), { waitForReady: true, timeoutMs: 5_000 });
  assert.equal(inputs.java_status.safeParse({ waitForReady: true, timeoutMs: 600_001 }).success, false);
});
test("targeted tests default to incremental compilation and compact output", () => {
  const result = inputs.java_run_tests.parse({ path: "src/test/java/ExampleTest.java", methodName: "works" });
  assert.equal(result.compile, "incremental"); assert.equal(result.compileProjectOnly, false); assert.equal(result.includeOutput, false); assert.equal(result.includeStackTrace, false); assert.equal(result.includeTotal, false); assert.equal(result.coverage, undefined);
  assert.deepEqual(inputs.java_run_tests.parse({ path: "A.java", coverage: {} }).coverage, { enabled: true, includes: [], details: "files", limit: 50, includeTotal: false });
  assert.equal(inputs.java_run_tests.safeParse({ path: "A.java", coverage: { limit: 201 } }).success, false);
  assert.equal(inputs.java_run_tests.safeParse({ tests: [{ path: "A.java", methodName: "a" }, { path: "B.java", methodName: "b" }] }).success, true);
  assert.equal(inputs.java_run_tests.safeParse({ path: "A.java", tests: [{ path: "B.java" }] }).success, false);
});
test("outline containment and read-only analyses have bounded defaults", () => {
  assert.equal(inputs.java_outline.parse({ path: "A.java", containingLine: 42 }).containingLine, 42);
  assert.deepEqual(inputs.java_find_unused_code.parse({}).kinds, ["method", "constructor", "field"]);
  const affected = inputs.java_find_affected_tests.parse({ target: { path: "A.java", line: 1, column: 1 } }); assert.equal(affected.transitive, true); assert.equal(affected.maxDepth, 10);
});
test("debug tools enforce state handles and bounded waits", () => {
  assert.deepEqual(inputs.java_debug_targets.parse({}), { includeUnavailable: false });
  assert.equal(inputs.java_debug_attach.parse({ targetId: "local:123" }).timeoutMs, 10_000);
  assert.equal(inputs.java_debug_variables.safeParse({ sessionId: "s", stopId: "x" }).success, false);
  assert.equal(inputs.java_debug_variables.safeParse({ sessionId: "s", stopId: "x", frameId: "f", valueId: "v" }).success, false);
  assert.equal(inputs.java_debug_variables.parse({ sessionId: "s", stopId: "x", frameId: "f" }).limit, 50);
  assert.equal(inputs.java_debug_execute.safeParse({ sessionId: "s", action: "step_into" }).success, false);
  assert.equal(inputs.java_debug_execute.safeParse({ sessionId: "s", action: "step_into", threadId: 1, stopId: "x" }).success, true);
  assert.equal(inputs.java_debug_set_breakpoints.safeParse({ sessionId: "s", sourcePath: "A.java", breakpoints: [{ line: 0 }] }).success, false);
  assert.deepEqual(inputs.java_debug_hot_swap.parse({ sessionId: "s", sourcePaths: ["src/App.java"] }), { sessionId: "s", sourcePaths: ["src/App.java"], dryRun: false });
});

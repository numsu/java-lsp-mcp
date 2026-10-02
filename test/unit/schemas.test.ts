import test from "node:test";
import assert from "node:assert/strict";
import { inputs, outputs } from "../../src/mcp/schemas.js";
test("symbol target is a strict discriminated union", () => { assert.equal(inputs.java_find_definition.safeParse({ queries: [{ target: { path: "A.java", line: 1 } }] }).success, true); assert.equal(inputs.java_find_definition.safeParse({ queries: [{ target: { path: "A.java", line: 1, column: 5 } }] }).success, true); assert.equal(inputs.java_find_definition.safeParse({ queries: [{ target: { qualifiedName: "A" } }] }).success, true); assert.equal(inputs.java_find_definition.safeParse({ queries: [{ target: { path: "A.java", qualifiedName: "A" } }] }).success, false); });
test("limits are bounded", () => assert.equal(inputs.java_search_symbols.safeParse({ queries: [{ query: "A", limit: 201 }] }).success, false));
test("search line hints are optional and positive integers", () => {
  assert.equal(inputs.java_search_symbols.parse({ queries: [{ query: "A" }] }).queries[0]!.line, undefined);
  assert.equal(inputs.java_search_symbols.parse({ queries: [{ query: "A", line: 42 }] }).queries[0]!.line, 42);
  for (const line of [0, -1, 1.5]) assert.equal(inputs.java_search_symbols.safeParse({ queries: [{ query: "A", line }] }).success, false);
});
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
  const target = { path: "src/Example.java", line: 1 };
  const references = inputs.java_find_references.parse({ target });
  assert.equal(references.includeText, false);
  assert.equal(references.contextLines, 0);
  assert.equal(references.includeEnclosing, false);
  assert.equal(references.usageKinds, undefined);
  assert.deepEqual(inputs.java_find_definition.parse({ queries: [{ target }] }).queries[0]!.expand, []);
  assert.equal(inputs.java_diagnostics.parse({ scope: "path", path: "src/Example.java" }).includeText, false);
  assert.equal(inputs.java_compile.parse({}).includeText, false);
  assert.equal(inputs.java_edit_preview.parse({ operation: "format", path: "src/Example.java" }).includeDiff, false);
  assert.equal(inputs.java_search_symbols.parse({ queries: [{ query: "Example" }] }).queries[0]!.includeTotal, false);
  assert.equal(inputs.java_search_symbols.parse({ queries: [{ query: "Example" }] }).queries[0]!.includeImplementation, false);
});
test("status offers a bounded blocking readiness probe", () => {
  assert.deepEqual(inputs.java_status.parse({}), { waitForReady: false, timeoutMs: 120_000 });
  assert.deepEqual(inputs.java_status.parse({ waitForReady: true, timeoutMs: 5_000 }), { waitForReady: true, timeoutMs: 5_000 });
  assert.equal(inputs.java_status.safeParse({ waitForReady: true, timeoutMs: 600_001 }).success, false);
});
test("targeted tests default to incremental compilation and compact output", () => {
  const result = inputs.java_run_tests.parse({ path: "src/test/java/ExampleTest.java", methodName: "works" });
  assert.equal(result.compile, "incremental"); assert.equal(result.compileProjectOnly, false); assert.equal(result.includeOutput, false); assert.equal(result.includeStackTrace, false); assert.equal(result.includeTotal, false); assert.equal(result.coverage, undefined); assert.equal(result.debug, false);
  assert.equal(inputs.java_run_tests.parse({ path: "A.java", debug: true }).debug, true);
  assert.equal(inputs.java_run_tests.safeParse({ path: "A.java", debug: "true" }).success, false);
  assert.deepEqual(outputs.java_run_tests.parse({ status: "debugging", debugSessions: [{ sessionId: "s", targetId: "local:1", pid: 1, selectors: ["ExampleTest"] }] }).status, "debugging");
  assert.deepEqual(inputs.java_run_tests.parse({ path: "A.java", coverage: {} }).coverage, { enabled: true, includes: [], details: "files", limit: 50, includeTotal: false });
  assert.equal(inputs.java_run_tests.safeParse({ path: "A.java", coverage: { limit: 201 } }).success, false);
  assert.equal(inputs.java_run_tests.safeParse({ tests: [{ path: "A.java", methodName: "a" }, { path: "B.java", methodName: "b" }] }).success, true);
  assert.equal(inputs.java_run_tests.safeParse({ path: "A.java", tests: [{ path: "B.java" }] }).success, false);
  assert.equal(inputs.java_run_tests.safeParse({ className: "com.example.SomethingTest" }).success, true);
  assert.equal(inputs.java_run_tests.safeParse({ methodName: "works" }).success, false);
  assert.equal(inputs.java_run_tests.safeParse({}).success, false);
  assert.equal(inputs.java_run_tests.safeParse({ tests: [{ className: "com.example.SomethingTest" }] }).success, true);
  assert.equal(inputs.java_run_tests.safeParse({ tests: [{ methodName: "works" }] }).success, false);
  assert.equal(inputs.java_run_tests.safeParse({ tests: [{ path: "A.java" }], className: "com.example.SomethingTest" }).success, false);
});
test("outline containment and read-only analyses have bounded defaults", () => {
  assert.equal(inputs.java_outline.parse({ path: "A.java", containingLine: 42 }).containingLine, 42);
  assert.deepEqual(inputs.java_find_unused_code.parse({}).kinds, ["method", "constructor", "field"]);
  const affected = inputs.java_find_affected_tests.parse({ target: { path: "A.java", line: 1 } }); assert.equal(affected.transitive, true); assert.equal(affected.maxDepth, 10);
});
test("debug tools enforce state handles and bounded waits", () => {
  assert.deepEqual(inputs.java_debug_targets.parse({}), { includeUnavailable: false });
  assert.equal(inputs.java_debug_attach.parse({ targetId: "local:123" }).timeoutMs, 10_000);
  assert.equal(inputs.java_debug_variables.safeParse({ sessionId: "s", stopId: "x" }).success, false);
  assert.equal(inputs.java_debug_variables.safeParse({ sessionId: "s", stopId: "x", frameId: "f", valueId: "v" }).success, false);
  assert.equal(inputs.java_debug_variables.parse({ sessionId: "s", stopId: "x", frameId: "f" }).limit, 50);
  assert.equal(inputs.java_debug_execute.safeParse({ sessionId: "s", action: "step_into" }).success, false);
  assert.equal(inputs.java_debug_execute.safeParse({ sessionId: "s", action: "step_into", threadId: 1, stopId: "x" }).success, true);
  assert.equal(inputs.java_debug_execute.safeParse({ sessionId: "s", action: "step_into", threadId: 1 }).success, true);
  assert.equal(inputs.java_debug_stack_trace.parse({ sessionId: "s", threadId: 1 }).stopId, undefined);
  assert.equal(inputs.java_debug_variables.parse({ sessionId: "s", frameId: "f" }).stopId, undefined);
  assert.deepEqual(inputs.java_debug_threads.parse({ sessionId: "s" }), { sessionId: "s", includeSystemThreads: false });
  assert.deepEqual(inputs.java_debug_stack_trace.parse({ sessionId: "s", stopId: "x", threadId: 1 }), { sessionId: "s", stopId: "x", threadId: 1, startFrame: 0, maxFrames: 20, includeInfrastructure: false });
  const variables = inputs.java_debug_variables.parse({ sessionId: "s", stopId: "x", frameId: "f" });
  assert.equal(variables.inlineFields, false); assert.equal(variables.maxInlineFields, 10); assert.equal(variables.includeGetters, false);
  assert.equal(inputs.java_debug_set_breakpoints.safeParse({ sessionId: "s", sourcePath: "A.java", breakpoints: [{ line: 0 }] }).success, false);
  assert.equal(inputs.java_debug_set_breakpoints.parse({ sessionId: "s", sourcePath: "A.java", breakpoints: [] }).timeoutMs, 5_000);
  assert.equal(inputs.java_debug_set_breakpoints.safeParse({ sessionId: "s", sourcePath: "A.java", breakpoints: [], timeoutMs: 60_001 }).success, false);
  assert.deepEqual(inputs.java_debug_hot_swap.parse({ sessionId: "s", sourcePaths: ["src/App.java"] }), { sessionId: "s", sourcePaths: ["src/App.java"], dryRun: false });
  assert.equal(outputs.java_debug_wait_for_stop.parse({ outcome: "timeout", sessionId: "s", targetId: "local:1", state: "stopped", stopId: "stop:1" }).stopId, "stop:1");
  assert.equal(outputs.java_debug_hot_swap.parse({ outcome: "applied", classes: [{ className: "p.App", status: "applied", changeType: "method_body" }], diagnostics: [], breakpoints: { restored: [], pending: [], rejected: [] }, activeFrames: [{ threadId: 1, className: "p.App", methodName: "run", obsolete: false, impact: "continues_old_bytecode" }] }).classes[0]?.changeType, "method_body");
});


test("navigation tools require bounded arrays with independently defaulted entries", () => {
  for (const [schema, query] of [[inputs.java_search_symbols, { query: "A" }], [inputs.java_find_definition, { target: { qualifiedName: "A" } }]] as const) {
    assert.equal(schema.safeParse(query).success, false);
    assert.equal(schema.safeParse({ queries: [] }).success, false);
    assert.equal(schema.safeParse({ queries: Array.from({ length: 21 }, () => query) }).success, false);
    assert.equal(schema.safeParse({ queries: [query], ...query }).success, false);
    assert.equal(schema.safeParse({ queries: [{ ...query, unknownOption: true }] }).success, false);
    assert.equal(schema.safeParse({ queries: [query] }).success, true);
  }
  const search = inputs.java_search_symbols.parse({ queries: [{ query: "A", line: 42, limit: 1, cursor: "cursor-a", scope: "all" }, { query: "B", cursor: null }] }).queries;
  assert.equal(search[0]!.scope, "all"); assert.equal(search[0]!.cursor, "cursor-a"); assert.equal(search[0]!.limit, 1);
  assert.equal(search[1]!.scope, "workspace"); assert.equal(search[1]!.mode, "fuzzy"); assert.equal(search[1]!.limit, 50); assert.equal(search[1]!.cursor, undefined); assert.equal(search[1]!.line, undefined);
  const definitions = inputs.java_find_definition.parse({ queries: [{ target: { qualifiedName: "A" }, expand: ["body"], includeDocumentation: true }, { target: { path: "B.java", line: 2 } }] }).queries;
  assert.deepEqual(definitions[0]!.expand, ["body"]); assert.equal(definitions[0]!.includeDocumentation, true);
  assert.deepEqual(definitions[1]!.expand, []); assert.equal(definitions[1]!.includeDocumentation, false); assert.equal(definitions[1]!.maxSourceCharacters, 4000);
  assert.equal(inputs.java_search_symbols.safeParse({ queries: [{ query: "A" }, { query: "" }] }).success, false);
  assert.equal(inputs.java_find_definition.safeParse({ queries: [{ target: { path: "A.java" } }] }).success, false);
});

test("navigation batch output validates results and per-entry errors", () => {
  const error = { error: { code: "SYMBOL_NOT_FOUND", message: "missing", details: { target: "Missing" } } };
  assert.equal(outputs.java_search_symbols.safeParse({ results: [{ symbols: [], nextCursor: "next", total: 2, warnings: [{ code: "warning" }] }, error] }).success, true);
  assert.equal(outputs.java_find_definition.safeParse({ results: [{ definitions: [], documentation: "docs" }, error] }).success, true);
  assert.equal(outputs.java_search_symbols.safeParse({ symbols: [] }).success, false);
  assert.equal(outputs.java_find_definition.safeParse({ definitions: [] }).success, false);
  assert.equal(outputs.java_search_symbols.safeParse({ results: [{ error: { code: "bad" } }] }).success, false);
  assert.equal(outputs.java_find_definition.safeParse({ results: [{ symbols: [] }] }).success, false);
});

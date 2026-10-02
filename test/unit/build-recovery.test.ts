import test from "node:test";
import assert from "node:assert/strict";
import { JavaService, isSyntaxError } from "../../src/mcp/service.js";
import { inputs, outputs } from "../../src/mcp/schemas.js";
import type { Diagnostic } from "../../src/jdtls/protocol.js";
import type { LspClient } from "../../src/jdtls/client.js";
import { DiagnosticStore } from "../../src/jdtls/diagnostics.js";
import type { WorkspacePaths } from "../../src/workspace/paths.js";
import type { WorkspaceSynchronizer } from "../../src/workspace/watcher.js";
import type { Snapshot } from "../../src/types.js";
import { JavaLspMcpError } from "../../src/types.js";

const snapshot: Snapshot = { path: "src/T.java", uri: "file:///workspace/src/T.java", content: "class T {}", hash: "hash", version: 2, mtimeMs: 2 };
const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
const syntax: Diagnostic = { range, severity: 1, code: "1610612960", source: "Java", message: "insert ;" }; // IProblem.MissingSemiColon
const typeError: Diagnostic = { ...syntax, code: 16777218, message: "Missing cannot be resolved to a type" };
const paths = { root: "/workspace", resolve: () => "C:/workspace/src/T.java", fromUri: () => ({ path: snapshot.path, origin: "workspace", editable: true }) } as unknown as WorkspacePaths;
const sync = { indexGeneration: 1, verify: async () => snapshot, flush: async () => {}, snapshots: { get: () => snapshot, getByUri: (uri: string) => uri === snapshot.uri ? snapshot : undefined, all: () => [snapshot] } } as unknown as WorkspaceSynchronizer;
const config = { workspace: "/workspace", offline: true, trustWorkspace: true, maxHeap: "1g", resultMode: "structured", logLevel: "error", timeoutMs: 1000, resultBudget: 12_000 } as const;
function fixture(build: (clean: boolean, timeout: number, store: DiagnosticStore) => Promise<number>, extra: Record<string, unknown> = {}) {
  const diagnostics = new DiagnosticStore();
  const calls: Array<{ clean: boolean; timeout: number }> = [];
  const client = { state: "ready", waitReady: async () => true, isTestFile: async () => true, testClasspaths: async () => ({}), diagnostics,
    build: async (clean: boolean, timeout: number) => { calls.push({ clean, timeout }); return build(clean, timeout, diagnostics); }, ...extra } as unknown as LspClient;
  return { service: new JavaService(config, paths, sync, client), diagnostics, calls, client };
}
const compile = (kind: "incremental" | "clean" = "incremental") => inputs.java_compile.parse({ kind });
const runTests = () => inputs.java_run_tests.parse({ path: snapshot.path });

test("syntax classification uses ECJ category codes including diagnostic data, never text", () => {
  assert.equal(isSyntaxError(syntax), true);
  assert.equal(isSyntaxError({ ...syntax, code: Number(syntax.code) }), true);
  assert.equal(isSyntaxError({ ...syntax, code: "compiler.err.expected", data: { ecjProblemId: syntax.code! } }), true);
  for (const diagnostic of [{ ...syntax, severity: 2 }, typeError, { ...syntax, code: undefined }, { ...syntax, code: "1073741824oops" }, { ...syntax, code: 1.5 }, { ...syntax, code: 0x140000000 }, { ...syntax, source: "Other" }]) {
    assert.equal(isSyntaxError(diagnostic as Diagnostic), false);
  }
});

test("compile retries failed incremental builds once and returns final diagnostics and attempt metadata", async () => {
  for (const status of [0, 2]) {
    const f = fixture(async (clean, _timeout, store) => { store.publish(snapshot.uri, clean ? [] : [typeError], snapshot.version); return clean ? 1 : status; });
    const result = outputs.java_compile.parse(await f.service.compile(compile()));
    assert.equal(result.success, true);
    assert.deepEqual(f.calls.map(call => call.clean), [false, true]);
    assert.deepEqual(result.buildAttempts, [{ kind: "incremental", buildStatus: status === 0 ? "failed" : "with-errors" }, { kind: "clean", buildStatus: "succeeded" }]);
    assert.deepEqual(result.diagnostics, []);
  }
});

test("compile does not retry syntax errors even outside the returned diagnostic page", async () => {
  const f = fixture(async (_clean, _timeout, store) => { store.publish(snapshot.uri, [typeError, syntax], snapshot.version); return 2; });
  const result = outputs.java_compile.parse(await f.service.compile({ ...compile(), limit: 1 }));
  assert.deepEqual(f.calls.map(call => call.clean), [false]);
  assert.equal(result.success, false); assert.equal(result.diagnostics.length, 1); assert.ok(result.nextCursor);
  await f.service.compile({ ...compile(), limit: 1, cursor: result.nextCursor });
  assert.equal(f.calls.length, 1);
});

test("compile detects syntax diagnostics published after build completion", async () => {
  const f = fixture(async (_clean, _timeout, store) => { setTimeout(() => store.publish(snapshot.uri, [syntax], snapshot.version), 10); return 2; });
  const result = outputs.java_compile.parse(await f.service.compile(compile()));
  assert.equal(result.success, false); assert.equal(result.diagnostics.length, 1); assert.equal(f.calls.length, 1);
});

test("old source-version diagnostics do not suppress clean recovery", async () => {
  const f = fixture(async (clean, _timeout, store) => { store.publish(snapshot.uri, clean ? [] : [syntax], clean ? snapshot.version : snapshot.version - 1); return clean ? 1 : 2; });
  assert.equal((await f.service.compile(compile()) as { success: boolean }).success, true);
  assert.deepEqual(f.calls.map(call => call.clean), [false, true]);
});

test("explicit clean, success, cancelled, and unknown build statuses never trigger a retry", async () => {
  for (const [kind, status] of [["clean", 2], ["incremental", 1], ["incremental", 3], ["incremental", 99]] as const) {
    const f = fixture(async (_clean, _timeout, store) => { store.publish(snapshot.uri, [], snapshot.version); return status; });
    await f.service.compile(compile(kind)); assert.equal(f.calls.length, 1);
  }
});

test("request and configuration failures never trigger clean recovery", async () => {
  for (const code of ["REQUEST_TIMEOUT", "EXCLUDED_PROJECT_NOT_FOUND"]) {
    const f = fixture(async () => { throw new JavaLspMcpError(code, "failure"); });
    const result = outputs.java_compile.parse(await f.service.compile(compile()));
    assert.equal(f.calls.length, 1); assert.equal(result.success, false); assert.match(result.message!, /failure/u);
  }
});

test("no diagnostic events still leave time for a clean retry under the original deadline", async () => {
  const f = fixture(async clean => clean ? 1 : 2);
  const result = outputs.java_compile.parse(await f.service.compile({ ...compile(), timeoutMs: 400 }));
  assert.equal(result.success, true); assert.equal(f.calls.length, 2);
  assert.ok(f.calls[1]!.timeout < f.calls[0]!.timeout);
  assert.ok(f.calls[1]!.timeout > 0);
});

test("an exhausted build timeout does not start clean recovery", async () => {
  const f = fixture(async () => { await new Promise(resolve => setTimeout(resolve, 35)); return 2; });
  await f.service.compile({ ...compile(), timeoutMs: 20 }); assert.equal(f.calls.length, 1);
});

test("a failing clean retry is reported once with its final diagnostics", async () => {
  const f = fixture(async (_clean, _timeout, store) => { store.publish(snapshot.uri, [typeError], snapshot.version); return 2; });
  const result = outputs.java_compile.parse(await f.service.compile(compile()));
  assert.equal(result.success, false); assert.equal(f.calls.length, 2);
  assert.equal(result.diagnostics[0]!.message, typeError.message);
});

test("test runs recover before source classification and reuse the recovered clean build", async () => {
  let classifications = 0;
  const f = fixture(async (clean, _timeout, store) => { store.publish(snapshot.uri, [], snapshot.version); return clean ? 1 : 2; }, { isTestFile: async () => { classifications++; return true; } });
  await assert.rejects(f.service.runTests(runTests()), /no test runtime classpath/u);
  await assert.rejects(f.service.runTests({ ...runTests(), compile: "clean" }), /no test runtime classpath/u);
  assert.deepEqual(f.calls.map(call => call.clean), [false, true]); assert.equal(classifications, 2);
});

test("concurrent test runs share both incremental and clean recovery attempts", async () => {
  const f = fixture(async (clean, _timeout, store) => { await new Promise(resolve => setTimeout(resolve, 10)); store.publish(snapshot.uri, [], snapshot.version); return clean ? 1 : 2; });
  const results = await Promise.allSettled([f.service.runTests(runTests()), f.service.runTests(runTests())]);
  assert.ok(results.every(result => result.status === "rejected"));
  assert.deepEqual(f.calls.map(call => call.clean), [false, true]);
});

test("persistent test compilation failure includes diagnostics without a follow-up compile instruction", async () => {
  const f = fixture(async (_clean, _timeout, store) => { store.publish(snapshot.uri, [typeError], snapshot.version); return 2; });
  const result = outputs.java_run_tests.parse(await f.service.runTests(runTests()));
  assert.ok("status" in result && result.status === "compile-failed");
  assert.deepEqual(f.calls.map(call => call.clean), [false, true]);
  assert.equal(result.compilation!.diagnostics[0]!.message, typeError.message);
  assert.equal(result.compilation!.total, 1); assert.equal(result.compilation!.diagnosticsTruncated, false);
  assert.equal(result.compilation!.buildAttempts.length, 2);
  assert.deepEqual(result.counts, {}); assert.deepEqual(result.failures, []);
  assert.doesNotMatch(result.message!, /call java_compile/u);
});

test("syntax errors suppress recovery for normal and debug test compilation", async () => {
  for (const debug of [false, true]) {
    const f = fixture(async (_clean, _timeout, store) => { store.publish(snapshot.uri, [syntax], snapshot.version); return 2; });
    if (debug) {
      const error = await f.service.debugTestLaunches({ ...runTests(), debug: true }).catch(error => error);
      assert.equal(error.code, "TEST_COMPILATION_FAILED"); assert.equal(error.details.compilation.diagnostics[0].code, syntax.code);
    } else {
      const result = await f.service.runTests(runTests()) as { status: string; compilation: { diagnostics: object[] } };
      assert.equal(result.status, "compile-failed"); assert.equal(result.compilation.diagnostics.length, 1);
    }
    assert.deepEqual(f.calls.map(call => call.clean), [false]);
  }
});

test("compile none continues to bypass automatic builds", async () => {
  const f = fixture(async () => { throw new Error("must not compile"); });
  await assert.rejects(f.service.runTests({ ...runTests(), compile: "none" }), /no test runtime classpath/u);
  assert.deepEqual(f.calls, []);
});

test("test compilation diagnostic samples report truncation", async () => {
  const f = fixture(async (_clean, _timeout, store) => { store.publish(snapshot.uri, Array.from({ length: 201 }, () => syntax), snapshot.version); return 2; });
  const result = outputs.java_run_tests.parse(await f.service.runTests(runTests()));
  if (result.status === "debugging") return;
  assert.equal(result.compilation!.total, 201); assert.equal(result.compilation!.diagnosticsTruncated, true);
});

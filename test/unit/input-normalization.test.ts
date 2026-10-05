import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";
import { inputs, outputs, type ToolName } from "../../src/mcp/schemas.js";
import { normalizeInput, clampSourceValue, withInputWarnings, type InputWarning } from "../../src/mcp/input-normalization.js";
import { buildMcpServer } from "../../src/mcp/server.js";
import type { JavaService } from "../../src/mcp/service.js";
import type { Config } from "../../src/config/config.js";
import type { Logger } from "../../src/logging.js";
import { JavaLspMcpError } from "../../src/types.js";

function parsed<N extends ToolName>(name: N, input: unknown) {
  const normalized = normalizeInput(inputs[name], input);
  return { value: inputs[name].parse(normalized.input) as z.output<(typeof inputs)[N]>, warnings: normalized.warnings };
}

test("reference context and independent batch controls clamp with precise warnings", () => {
  const raw = { queries: [{ target: { qualifiedName: "A" }, contextLines: 100, limit: 999 }, { target: { qualifiedName: "B" }, contextLines: -4, maxSnippetCharacters: 2 }] };
  const result = parsed("java_find_references", raw);
  assert.deepEqual(result.value.queries.map(q => [q.contextLines, q.limit, q.maxSnippetCharacters]), [[20, 200, 1000], [0, 50, 100]]);
  assert.deepEqual(result.warnings.map(w => [w.path, w.requested, w.applied]), [["queries[0].contextLines", 100, 20], ["queries[0].limit", 999, 200], ["queries[1].contextLines", -4, 0], ["queries[1].maxSnippetCharacters", 2, 100]]);
  assert.equal(raw.queries[0]!.contextLines, 100);
});

test("timeouts, depth, coverage, debugger pages and fractional controls normalize", () => {
  assert.equal(parsed("java_status", { timeoutMs: 900000 }).value.timeoutMs, 600000);
  assert.equal(parsed("java_type_hierarchy", { queries: [{ target: { qualifiedName: "A" }, depth: 99 }] }).value.queries[0]!.depth, 3);
  const run = parsed("java_run_tests", { tests: [{ path: "A.java" }], coverage: { limit: 999 }, timeoutMs: 0 });
  assert.equal(run.value.coverage!.limit, 200); assert.equal(run.value.timeoutMs, 1);
  const variables = parsed("java_debug_variables", { sessionId: "s", frameId: "f", start: -10, limit: 2.9, maxInlineFields: 100 });
  assert.deepEqual([variables.value.start, variables.value.limit, variables.value.maxInlineFields], [0, 2, 50]);
  assert.equal(variables.warnings.length, 3);
});

test("oversized arrays warn with explicit omissions; empty arrays and identities remain invalid", () => {
  const result = parsed("java_run_tests", { tests: Array.from({ length: 101 }, (_, index) => ({ path: `${index}.java` })) });
  assert.equal(result.value.tests.length, 100);
  assert.equal(result.value.tests.at(-1)!.path, "99.java");
  assert.deepEqual(result.warnings.map(w => [w.path, w.requested, w.applied]), [["tests", 101, 100]]);
  assert.match(result.warnings[0]!.message, /omitted 1/u);
  for (const raw of [{ tests: [] }, { tests: [{ path: "A.java" }], timeoutMs: "huge" }, { tests: [{ path: "A.java" }], timeoutMs: Infinity }]) assert.throws(() => parsed("java_run_tests", raw), z.ZodError);
  assert.throws(() => parsed("java_debug_stack_trace", { sessionId: "s", threadId: -1 }), z.ZodError);
});

test("reversed ranges collapse to their start after numeric normalization", () => {
  const result = parsed("java_code_actions", { queries: [{ path: "A.java", range: { line: 5, column: 6, endLine: 2, endColumn: 1 } }] });
  assert.deepEqual(result.value.queries[0]!.range, { line: 5, column: 6, endLine: 5, endColumn: 6 });
  assert.equal(result.warnings.length, 2);
});

test("runtime source warnings stay isolated across concurrent requests", async () => {
  const a: InputWarning[] = [], b: InputWarning[] = [];
  await Promise.all([withInputWarnings(a, async () => { await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(clampSourceValue("A.line", 999, 1, 5), 5); }), withInputWarnings(b, async () => { assert.equal(clampSourceValue("B.column", 99, 1, 3), 3); await Promise.resolve(); })]);
  assert.deepEqual(a.map(w => w.path), ["A.line"]);
  assert.deepEqual(b.map(w => w.path), ["B.column"]);
});

test("all tool schemas advertise permissive controls and optional response warnings", () => {
  for (const name of Object.keys(inputs) as ToolName[]) {
    const output = z.toJSONSchema(outputs[name], { io: "output" }) as { properties?: Record<string, unknown>; anyOf?: Array<{ properties: Record<string, unknown> }> };
    const hasWarnings = (schema: typeof output): boolean => Boolean(schema.properties?.inputWarnings || schema.anyOf?.every(branch => hasWarnings(branch)));
    assert.ok(hasWarnings(output), name);
  }
  const schema = z.toJSONSchema(inputs.java_find_references, { io: "input" }) as unknown as { properties: { queries: { "x-cap": number; maxItems?: number; items: { properties: { contextLines: { "x-clamp": number[]; maximum?: number } } } } } };
  assert.deepEqual(schema.properties.queries.items.properties.contextLines["x-clamp"], [0, 20]);
  assert.equal(schema.properties.queries.items.properties.contextLines.maximum, undefined);
  assert.equal(schema.properties.queries["x-cap"], 20);
  assert.equal(schema.properties.queries.maxItems, undefined);
});

test("MCP callbacks warn in both response modes and preserve warnings on genuine failures", async () => {
  type Callback = (input: unknown, context: { mcpReq: { signal: AbortSignal } }) => Promise<{ content: Array<{ text: string }>; structuredContent: Record<string, unknown>; isError?: boolean }>;
  const callbacks = new Map<string, Callback>();
  const original = McpServer.prototype.registerTool;
  McpServer.prototype.registerTool = ((name: string, _config: unknown, callback: Callback) => { callbacks.set(name, callback); }) as unknown as typeof original;
  const seen: number[] = [];
  const service = { references: async (input: { contextLines: number; target: { qualifiedName: string } }) => { seen.push(input.contextLines); if (input.target.qualifiedName === "missing") throw new JavaLspMcpError("SYMBOL_NOT_FOUND", "missing"); return { references: [] }; }, status: async () => { throw new JavaLspMcpError("JDT_NOT_READY", "starting"); } } as unknown as JavaService;
  try {
    for (const resultMode of ["structured", "text"] as const) {
      buildMcpServer(service, { workspace: ".", resultMode, resultBudget: 12000 } as Config, { error: () => {} } as unknown as Logger);
      const raw = { queries: [{ target: { qualifiedName: "A" }, contextLines: 99 }, { target: { qualifiedName: "missing" }, contextLines: 50 }] };
      // Simulate the SDK's validation before our callback; raw values must survive it.
      const result = await callbacks.get("java_find_references")!(inputs.java_find_references.parse(raw), { mcpReq: { signal: new AbortController().signal } });
      assert.notEqual(result.isError, true);
      outputs.java_find_references.parse(result.structuredContent);
      assert.equal((result.structuredContent.inputWarnings as unknown[]).length, 2);
      assert.match(result.content[0]!.text, /Warning: queries\[0\].contextLines: clamped 99 to 20/u);
      const failed = await callbacks.get("java_status")!({ timeoutMs: 999999 }, { mcpReq: { signal: new AbortController().signal } });
      assert.equal(failed.isError, true);
      assert.equal((failed.structuredContent.inputWarnings as unknown[]).length, 1);
      assert.match(failed.content[0]!.text, /Warning: timeoutMs/u);
    }
    assert.deepEqual(seen, [20, 20, 20, 20]);
  } finally { McpServer.prototype.registerTool = original; }
});

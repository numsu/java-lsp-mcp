import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { serverInstructions } from "../../src/mcp/server.js";

test("describe-tools prints complete formatted schemas without a workspace", () => {
  const result = spawnSync(process.execPath, [resolve("dist/server.mjs"), "describe-tools"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes("\n  \"tools\""));
  const described = JSON.parse(result.stdout) as { instructions: string; tools: Array<Record<string, unknown>> };
  assert.equal(described.tools.length, 26);
  assert.equal(described.instructions, serverInstructions);
  assert.ok(described.tools.every(tool => tool.inputSchema && tool.outputSchema));
  const search = described.tools.find(tool => tool.name === "java_search_symbols")!;
  const searchSchema = (search.inputSchema as { properties: { queries: { items: unknown } } }).properties.queries.items as { properties: Record<string, { description?: string }>; required: string[] };
  assert.ok(searchSchema.properties.line);
  assert.equal(searchSchema.required.includes("line"), false);
  assert.match(String(search.description), /before pagination/u);
  assert.match(serverInstructions, /Windows-1252/u);
  for (const name of ["java_find_definition", "java_find_references", "java_call_hierarchy", "java_type_hierarchy", "java_find_affected_tests"]) {
    const tool = described.tools.find(value => value.name === name)!;
    const inputSchema = ["java_find_definition", "java_find_references", "java_call_hierarchy", "java_type_hierarchy", "java_find_affected_tests"].includes(name) ? (tool.inputSchema as { properties: { queries: { items: unknown } } }).properties.queries.items : tool.inputSchema;
    const schema = inputSchema as { properties: { target: { oneOf: Array<{ properties: Record<string, { description?: string }>; required: string[] }> } } };
    const position = schema.properties.target.oneOf.find(value => "path" in value.properties)!;
    assert.deepEqual(position.required, ["path", "line"]);
    assert.match(position.properties.line!.description ?? "", /innermost enclosing declaration/u);
    assert.match(position.properties.column!.description ?? "", /clamped/u);
    assert.match(position.properties.path!.description ?? "", /Workspace-relative/u);
  }
  for (const name of ["java_search_symbols", "java_find_definition", "java_find_references", "java_call_hierarchy", "java_type_hierarchy", "java_find_affected_tests", "java_code_actions"]) {
    const tool = described.tools.find(value => value.name === name)!;
    const input = tool.inputSchema as { required: string[]; properties: { queries: { minItems: number; "x-cap": number } }; additionalProperties: boolean };
    assert.deepEqual(input.required, ["queries"]);
    assert.deepEqual(Object.keys(input.properties), ["queries"]);
    assert.equal(input.additionalProperties, false);
    assert.equal(input.properties.queries.minItems, 1);
    assert.equal(input.properties.queries["x-cap"], 20);
    assert.match(String(tool.description), /Batch .*queries/u);
    const output = tool.outputSchema as { required: string[] };
    assert.deepEqual(output.required, ["results"]);
  }
  const compile = described.tools.find(tool => tool.name === "java_compile")!;
  const compileSchema = compile.outputSchema as { required: string[]; properties: Record<string, unknown> };
  assert.ok(compileSchema.required.includes("buildAttempts"));
  assert.match(String(compile.description), /retry clean once unless current diagnostics confirm syntax errors/u);
  const runTests = described.tools.find(tool => tool.name === "java_run_tests")!;
  const testInput = runTests.inputSchema as { required: string[]; properties: Record<string, unknown> };
  assert.ok(testInput.required.includes("tests"));
  for (const name of ["path", "className", "methodName"]) assert.equal(name in testInput.properties, false);
  assert.match(String(runTests.description), /Batch independent JUnit selectors in tests/u);
  const unused = described.tools.find(tool => tool.name === "java_find_unused_code")!;
  const unusedInput = unused.inputSchema as { properties: Record<string, unknown> };
  assert.ok(unusedInput.properties.paths);
  assert.equal("path" in unusedInput.properties, false);
  assert.match(String(unused.description), /source files in paths/u);
  const testsSchema = runTests.outputSchema as { anyOf: Array<{ properties: Record<string, unknown> }> };
  assert.ok(testsSchema.anyOf.some(schema => schema.properties.compilation && schema.properties.buildAttempts));
  assert.match(String(runTests.description), /compilation diagnostics/u);
  for (const name of ["java_search_symbols", "java_find_references"]) {
    const tool = described.tools.find(value => value.name === name)!;
    const input = ["java_search_symbols", "java_find_references"].includes(name) ? (tool.inputSchema as { properties: { queries: { items: unknown } } }).properties.queries.items : tool.inputSchema;
    const schema = input as { properties: { cursor: { description: string } } };
    assert.match(schema.properties.cursor.description, /STALE_RESULT_SET/u);
    assert.match(serverInstructions, /2 minutes/u);
  }
  const breakpoints = described.tools.find(tool => tool.name === "java_debug_set_breakpoints")!;
  const breakpointSchema = breakpoints.inputSchema as { properties: { sourcePath: { description: string } } };
  assert.match(breakpointSchema.properties.sourcePath.description, /slash and backslash/u);
});

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

test("describe-tools prints complete formatted schemas without a workspace", () => {
  const result = spawnSync(process.execPath, [resolve("dist/server.mjs"), "describe-tools"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes("\n  \"tools\""));
  const described = JSON.parse(result.stdout) as { tools: Array<Record<string, unknown>> };
  assert.equal(described.tools.length, 26);
  assert.ok(described.tools.every(tool => tool.inputSchema && tool.outputSchema));
  const search = described.tools.find(tool => tool.name === "java_search_symbols")!;
  const searchSchema = search.inputSchema as { properties: Record<string, { description?: string }>; required: string[] };
  assert.ok(searchSchema.properties.line);
  assert.equal(searchSchema.required.includes("line"), false);
  assert.match(String(search.description), /before pagination/u);
  assert.match(String(search.description), /Windows-1252/u);
  for (const name of ["java_find_definition", "java_find_references", "java_call_hierarchy", "java_type_hierarchy", "java_find_affected_tests"]) {
    const tool = described.tools.find(value => value.name === name)!;
    const schema = tool.inputSchema as { properties: { target: { oneOf: Array<{ properties: Record<string, { description?: string }>; required: string[] }> } } };
    const position = schema.properties.target.oneOf.find(value => "path" in value.properties)!;
    assert.deepEqual(position.required, ["path", "line"]);
    assert.match(position.properties.line!.description ?? "", /innermost declaration/u);
    assert.match(position.properties.column!.description ?? "", /clamped/u);
    assert.match(position.properties.path!.description ?? "", /Windows-1252/u);
  }
  const breakpoints = described.tools.find(tool => tool.name === "java_debug_set_breakpoints")!;
  const breakpointSchema = breakpoints.inputSchema as { properties: { sourcePath: { description: string } } };
  assert.match(breakpointSchema.properties.sourcePath.description, /slash and backslash/u);
});

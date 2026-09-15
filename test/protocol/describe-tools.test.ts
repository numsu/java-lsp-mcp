import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

test("describe-tools prints complete formatted schemas without a workspace", () => {
  const result = spawnSync(process.execPath, [resolve("dist/server.mjs"), "describe-tools"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes("\n  \"tools\""));
  const described = JSON.parse(result.stdout) as { tools: Array<Record<string, unknown>> };
  assert.equal(described.tools.length, 14);
  assert.ok(described.tools.every(tool => tool.inputSchema && tool.outputSchema));
});

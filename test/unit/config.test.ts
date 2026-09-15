import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config/config.js";

test("TOML configuration parses arrays and preserves hashes inside strings", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "java-lsp-mcp-config-"));
  try {
    await writeFile(join(workspace, "java-lsp-mcp.toml"), 'offline = true\ntimeout-ms = 5000\nexcluded-projects = ["one", "module#two"] # comment\n');
    const config = loadConfig(workspace, {}); assert.equal(config.offline, true); assert.equal(config.timeoutMs, 5000); assert.deepEqual(config.excludedProjects, ["one", "module#two"]);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("invalid configuration is rejected instead of leaking into runtime calls", () => {
  assert.throws(() => loadConfig(process.cwd(), { timeoutMs: Number.NaN }), /expected number/u);
});

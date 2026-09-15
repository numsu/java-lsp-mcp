import test from "node:test";
import assert from "node:assert/strict";
import { enforceToolBudget } from "../../src/mcp/server.js";

test("paged outline results are not structurally trimmed after cursor calculation", () => {
  const methods = Array.from({ length: 110 }, (_, index) => ({
    kind: "method",
    name: `method${index}`,
    signature: `(java.lang.String value${index})`,
    startLine: index * 10 + 10,
    endLine: index * 10 + 18,
  }));
  const outline = { symbols: methods, nextCursor: "signed-cursor" };

  const result = enforceToolBudget("java_outline", outline, 12_000) as typeof outline;
  assert.equal(result.symbols.length, 110);
  assert.equal(result.nextCursor, "signed-cursor");
  assert.equal("returned" in result, false);
});

test("status budget drops only optional verbose fields", () => {
  const status = { state: "ready", ready: true, projectKind: "maven", modules: 1, compiler: "ecj", mcpRevision: "test", jdtVersion: "test", toolingJdk: "configured", projectJdk: "configured", trusted: true, offline: false, excludedProjects: Array.from({ length: 100 }, (_, index) => `module-${index}`) };
  const result = enforceToolBudget("java_status", status, 256) as typeof status;
  assert.equal(result.state, "ready"); assert.equal(result.excludedProjects, undefined);
});

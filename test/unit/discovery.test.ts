import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverProject } from "../../src/workspace/discovery.js";

test("a modular Maven project remains Maven and discovers dotted module directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "java-lsp-mcp-discovery-"));
  try {
    await mkdir(join(root, "src"), { recursive: true }); await mkdir(join(root, "module.with.dots"), { recursive: true });
    await writeFile(join(root, "pom.xml"), "<project/>"); await writeFile(join(root, "src", "module-info.java"), "module example {}"); await writeFile(join(root, "module.with.dots", "pom.xml"), "<project/>");
    const result = discoverProject(root); assert.equal(result.kind, "maven"); assert.equal(result.modules, 2); assert.equal(result.descriptors.length, 3);
  } finally { await rm(root, { recursive: true, force: true }); }
});

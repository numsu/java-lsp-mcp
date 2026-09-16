import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { WorkspacePaths } from "../../src/workspace/paths.js";

test("rejects traversal and normalizes workspace paths", () => {
  const root = mkdtempSync(join(tmpdir(), "java-lsp-mcp-path-")); writeFileSync(join(root, "A.java"), "class A {}\n"); const paths = new WorkspacePaths(root);
  assert.equal(paths.relative(paths.resolve("A.java")), "A.java");
  assert.throws(() => paths.resolve("../outside.java", false), /escapes workspace/u);
});

test("rejects symlink escapes", { skip: process.platform === "win32" && !process.env.CI }, () => {
  const root = mkdtempSync(join(tmpdir(), "java-lsp-mcp-root-")); const outside = mkdtempSync(join(tmpdir(), "java-lsp-mcp-out-")); mkdirSync(join(outside, "dir")); symlinkSync(join(outside, "dir"), join(root, "escape"), "junction");
  assert.throws(() => new WorkspacePaths(root).resolve("escape/file.java", false), /escapes workspace/u);
});

test("fromUri resolves workspace files reached through symlinked path prefixes", { skip: process.platform === "win32" && !process.env.CI }, () => {
  const real = mkdtempSync(join(tmpdir(), "java-lsp-mcp-real-")); const alias = join(tmpdir(), `java-lsp-mcp-alias-${process.pid}-${Date.now()}`);
  try {
    symlinkSync(real, alias, "junction"); writeFileSync(join(real, "A.java"), "class A {}\n");
    const paths = new WorkspacePaths(alias);
    assert.deepEqual(paths.fromUri(pathToFileURL(join(alias, "A.java")).href), { path: "A.java", origin: "workspace", editable: true });
    assert.equal(paths.fromUri(pathToFileURL(join(alias, "missing", "B.java")).href).origin, "workspace");
    const outside = mkdtempSync(join(tmpdir(), "java-lsp-mcp-out-"));
    assert.equal(paths.fromUri(pathToFileURL(join(outside, "C.java")).href).origin, "dependency");
  } finally { rmSync(alias, { force: true }); rmSync(real, { recursive: true, force: true }); }
});

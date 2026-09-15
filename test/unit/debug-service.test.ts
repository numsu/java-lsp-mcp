import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { findClassFiles } from "../../src/debug/service.js";

test("hot swap class discovery chooses the newest matching top-level and nested classes", () => {
  const root = resolve(".tmp-debug-service-test");
  try {
    mkdirSync(join(root, "target", "classes", "p"), { recursive: true });
    mkdirSync(join(root, "old", "p"), { recursive: true });
    writeFileSync(join(root, "App.java"), "class App {}");
    writeFileSync(join(root, "old", "p", "App.class"), "old");
    writeFileSync(join(root, "target", "classes", "p", "App.class"), "new");
    writeFileSync(join(root, "target", "classes", "p", "App$Inner.class"), "inner");
    const old = new Date(Date.now() - 10_000); utimesSync(join(root, "old", "p", "App.class"), old, old);
    const result = findClassFiles(root, [join(root, "App.java")]);
    assert.equal(result.length, 2);
    assert.ok(result.some(path => path.endsWith(join("target", "classes", "p", "App.class"))));
    assert.ok(result.some(path => path.endsWith("App$Inner.class")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

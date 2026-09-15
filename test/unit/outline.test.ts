import test from "node:test";
import assert from "node:assert/strict";
import { outlineNeedsReconcile } from "../../src/jdtls/outline.js";
import type { DocumentSymbol } from "../../src/jdtls/protocol.js";

const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
const symbol = (name: string, kind: number): DocumentSymbol => ({ name, kind, range, selectionRange: range });

test("package-only outlines are transient when the source declares a type", () => {
  const source = "package example; public class Example {}";
  assert.equal(outlineNeedsReconcile([symbol("example", 4)], "src/Example.java", source), true);
  assert.equal(outlineNeedsReconcile([symbol("example", 4), symbol("Example", 5)], "src/Example.java", source), false);
});

test("package-info compilation units may contain only a package symbol", () => {
  assert.equal(outlineNeedsReconcile([symbol("example", 4)], "src/package-info.java", "package example;"), false);
});

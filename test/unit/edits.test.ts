import test from "node:test";
import assert from "node:assert/strict";
import { applyEdits, unifiedDiff, validateAndSortEdits, type TextEdit } from "../../src/results/edits.js";

const r = (start: number, end: number, newText: string): TextEdit => ({ range: { start: { line: 0, character: start }, end: { line: 0, character: end } }, newText });
test("sorts and applies edits in reverse source order", () => {
  const edits = validateAndSortEdits("abcdef", [r(1, 2, "B"), r(4, 5, "E")]); assert.equal(edits[0]!.range.start.character, 4); assert.equal(applyEdits("abcdef", edits), "aBcdEf");
});
test("rejects overlapping edits", () => assert.throws(() => validateAndSortEdits("abcdef", [r(1, 4, "x"), r(3, 5, "y")]), /overlapping/u));
test("rejects edit columns inside a Unicode surrogate pair", () => assert.throws(() => validateAndSortEdits("a😀b", [r(2, 3, "x")]), /surrogate pair/u));
test("generates a standard unified diff", () => assert.match(unifiedDiff("A.java", "abc\n", [r(1, 2, "B")]), /--- a\/A\.java[\s\S]*\+\+\+ b\/A\.java/u));

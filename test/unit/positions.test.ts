import test from "node:test";
import assert from "node:assert/strict";
import { codePointToUtf16Column, lines, utf16ToCodePointColumn } from "../../src/results/positions.js";

test("converts UTF-16 columns to one-based Unicode code-point columns", () => {
  const line = "a😀β";
  assert.equal(utf16ToCodePointColumn(line, 0), 1);
  assert.equal(utf16ToCodePointColumn(line, 1), 2);
  assert.equal(utf16ToCodePointColumn(line, 3), 3);
  assert.equal(utf16ToCodePointColumn(line, 4), 4);
  assert.equal(codePointToUtf16Column(line, 3), 3);
  assert.throws(() => utf16ToCodePointColumn(line, 2), /surrogate/u);
});

test("splits LF and CRLF without leaking carriage returns", () => {
  assert.deepEqual(lines("one\r\ntwo\nthree"), ["one", "two", "three"]);
});

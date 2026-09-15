import test from "node:test";
import assert from "node:assert/strict";
import { enumConstants } from "../../src/workspace/enum-index.js";

test("enum constant indexing handles arguments, annotations, and constant bodies", () => {
  const source = `
    enum Language {
      FI,
      @Deprecated SV("sv") { @Override public String toString() { return "sv"; } },
      EN("en");
      private final String code;
      Language(String code) { this.code = code; }
    }
  `;
  assert.deepEqual(enumConstants(source), [
    { name: "FI", container: "Language", line: 3 },
    { name: "SV", container: "Language", line: 4 },
    { name: "EN", container: "Language", line: 5 },
  ]);
});

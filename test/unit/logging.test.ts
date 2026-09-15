import test from "node:test";
import assert from "node:assert/strict";
import { Logger } from "../../src/logging.js";
test("logging writes no stdout", () => { let stdout = "", stderr = ""; const oldOut = process.stdout.write, oldErr = process.stderr.write; process.stdout.write = ((s: string) => { stdout += s; return true; }) as typeof process.stdout.write; process.stderr.write = ((s: string) => { stderr += s; return true; }) as typeof process.stderr.write; try { new Logger("debug").info("hello"); } finally { process.stdout.write = oldOut; process.stderr.write = oldErr; } assert.equal(stdout, ""); assert.match(stderr, /hello/u); });

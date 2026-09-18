import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import type { Logger } from "../../src/logging.js";
import { outputs } from "../../src/mcp/schemas.js";
import { outputValidationError } from "../../src/mcp/server.js";

function loggedLogger(calls: Array<{ message: string; details: unknown }>): Logger {
  return { error: (message: string, details?: unknown) => { calls.push({ message, details }); } } as unknown as Logger;
}

const incidentStopped = {
  sessionId: "session:1", targetId: "local:123", outcome: "stopped", state: "terminated",
  stopId: "stop:7", reason: "step", threadId: 13,
  location: { className: "com.example.Worker", methodName: "run", sourcePath: "src/com/example/Worker.java", line: 42 },
};

test("output validation failures become a clean error with the raw issues logged", () => {
  let failure: unknown; try { outputs.java_debug_execute.parse(incidentStopped); } catch (error) { failure = error; }
  assert.ok(failure instanceof z.ZodError, "the incident payload must fail output validation");
  const calls: Array<{ message: string; details: unknown }> = [];
  const error = outputValidationError("java_debug_execute", failure, loggedLogger(calls));
  assert.equal(error.code, "INTERNAL_ERROR");
  assert.match(error.message, /failed output validation/u);
  assert.doesNotMatch(error.message, /invalid_union/u);
  assert.equal(calls.length, 1);
  assert.ok(Array.isArray((calls[0]!.details as { issues: unknown }).issues));
});

test("non-validation output failures keep a clean error without validation logging", () => {
  const calls: Array<{ message: string; details: unknown }> = [];
  const error = outputValidationError("java_debug_execute", new Error("boom"), loggedLogger(calls));
  assert.equal(error.code, "INTERNAL_ERROR");
  assert.match(error.message, /failed output validation/u);
  assert.deepEqual(calls, []);
});

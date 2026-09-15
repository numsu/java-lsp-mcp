import test from "node:test";
import assert from "node:assert/strict";
import { inputs, outputs } from "../../src/mcp/schemas.js";
test("registry exposes exactly the required static tools with output schemas", () => { const expected = ["java_status", "java_outline", "java_search_symbols", "java_find_definition", "java_find_references", "java_call_hierarchy", "java_type_hierarchy", "java_diagnostics", "java_compile", "java_run_tests", "java_find_affected_tests", "java_find_unused_code", "java_code_actions", "java_edit_preview"]; assert.deepEqual(Object.keys(inputs), expected); assert.deepEqual(Object.keys(outputs), expected); });

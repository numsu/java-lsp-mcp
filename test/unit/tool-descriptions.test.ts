import test from "node:test";
import assert from "node:assert/strict";
import { descriptions, serverInstructions } from "../../src/mcp/server.js";
import { inputs, type ToolName } from "../../src/mcp/schemas.js";

test("agent descriptions stay compact and shared rules appear once", () => {
  assert.deepEqual(Object.keys(descriptions), Object.keys(inputs));
  const size = Object.values(descriptions).reduce((sum, value) => sum + value.length, serverInstructions.length);
  assert.ok(size < 8500, `description/instruction size: ${size}`);
  for (const description of Object.values(descriptions)) {
    assert.ok(description.length > 0);
    assert.doesNotMatch(description, /Numeric limits\/array caps clamp|Windows-1252/u);
  }
  for (const rule of [/workspace-relative/u, /one-based Unicode/u, /range ends are exclusive/u, /per-entry errors/u, /inputWarnings/u, /stale\/expired cursors/u, /sessionId from java_debug_attach/u, /refresh stop\/frame\/value handles/u]) assert.match(serverInstructions, rule);
  assert.doesNotMatch(serverInstructions, /Every Java tool automatically waits/u);
});

test("descriptions retain the decisions needed to avoid invalid or misleading calls", () => {
  const required: Partial<Record<ToolName, RegExp[]>> = {
    java_status: [/waitForReady=true/u, /busy.*ready=true/u],
    java_outline: [/containingLine/u, /method bodies are omitted/u],
    java_search_symbols: [/scope defaults to workspace/u, /nearest declaration before pagination/u, /one workspace match/u],
    java_find_definition: [/expand/u, /includeDocumentation/u, /Dependency.*workspace source position/u],
    java_find_references: [/within/u, /contextLines>0/u, /Declarations are excluded/u],
    java_call_hierarchy: [/direction is required/u, /production/u, /ignored for outgoing/u],
    java_type_hierarchy: [/direction defaults to both/u, /root, nodes, and edges/u],
    java_diagnostics: [/without building/u, /scope=path requires path/u, /cached diagnostics/u, /pendingPaths/u],
    java_compile: [/incremental/u, /retry clean once unless.*syntax errors/u, /cursor.*without recompiling/u],
    java_run_tests: [/each needs path or className/u, /workspace trust/u, /exclusive resources/u, /compile=none/u, /compilation diagnostics/u, /Debug excludes coverage/u, /continue without stopId/u],
    java_update_projects: [/all=true without paths/u, /force=true.*ignoring selectors/u, /workspace trust/u],
    java_find_affected_tests: [/complete=false/u, /do not prove coverage/u],
    java_find_unused_code: [/omit paths for the workspace/u, /complete=false/u, /reflection\/framework/u],
    java_code_actions: [/kinds defaults to quickfix/u, /java_edit_preview/u, /STALE_ACTION/u],
    java_edit_preview: [/rename requires target\+newName/u, /codeAction requires an ID/u, /baseHash/u, /Command-based/u],
    java_debug_targets: [/attachable targetId/u],
    java_debug_attach: [/targetId from java_debug_targets/u, /return a sessionId/u],
    java_debug_sessions: [/stoppedThreads/u, /activeRequest/u],
    java_debug_set_breakpoints: [/Replace all breakpoints/u, /breakpoints=\[\] clears/u, /unloaded classes/u],
    java_debug_threads: [/full-match Java regex/u, /threadId from a stop event/u],
    java_debug_wait_for_stop: [/Timeout is a normal outcome/u, /stopId and threadId/u],
    java_debug_stack_trace: [/stopped threadId from a stop event/u, /zero-based/u, /nextStartFrame/u],
    java_debug_variables: [/exactly one frameId or valueId/u, /nextStart/u, /includeGetters invokes target code/u],
    java_debug_execute: [/Steps require.*threadId/u, /continue without stopId/u, /pending.*java_debug_wait_for_stop/u],
    java_debug_detach: [/leave the JVM running/u],
    java_debug_hot_swap: [/dryRun still compiles but skips replacement/u, /method-body changes/u],
  };
  assert.equal(Object.keys(required).length, Object.keys(inputs).length);
  for (const [name, rules] of Object.entries(required)) for (const rule of rules!) assert.match(descriptions[name as ToolName], rule, name);
});

test("documented compound input forms match schemas", () => {
  for (const input of [
    { operation: "rename", target: { qualifiedName: "A" }, newName: "B" },
    { operation: "codeAction", id: "returned-action-id" },
    { operation: "organizeImports", path: "A.java" },
    { operation: "format", path: "A.java" },
  ]) assert.equal(inputs.java_edit_preview.safeParse(input).success, true);
  assert.equal(inputs.java_update_projects.safeParse({ all: true }).success, true);
  assert.equal(inputs.java_update_projects.safeParse({ all: true, paths: ["pom.xml"] }).success, false);
  assert.equal(inputs.java_debug_variables.safeParse({ sessionId: "s", frameId: "f" }).success, true);
  assert.equal(inputs.java_debug_variables.safeParse({ sessionId: "s", frameId: "f", valueId: "v" }).success, false);
  assert.equal(inputs.java_debug_execute.safeParse({ sessionId: "s", action: "continue" }).success, true);
  assert.equal(inputs.java_debug_execute.safeParse({ sessionId: "s", action: "step_over" }).success, false);
});

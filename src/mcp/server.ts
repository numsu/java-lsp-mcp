import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Config } from "../config/config.js";
import type { Logger } from "../logging.js";
import { JavaLspMcpError } from "../types.js";
import type { JavaService } from "./service.js";
import { DebugService } from "../debug/service.js";
import { inputs, outputs, type ToolName } from "./schemas.js";
import { application } from "../version.js";

export const descriptions: Record<ToolName, string> = {
  java_status: "Probe JDT readiness. ready=true means semantic requests are accepted; state=busy and activity describe current background work without revoking readiness. Before the first Java semantic request, call with waitForReady=true instead of using a fixed startup delay.",
  java_outline: "Return a filtered, paginated compact Java outline with declaration start/end lines and no method bodies. Set containingLine to return only its enclosing declaration chain.",
  java_search_symbols: "Search JDT workspace/dependency symbols, supplemented by a cached workspace enum-constant index. Set includeImplementation=true to include up to the first 200 source lines and the full declaration start/end lines when exactly one workspace symbol matches. Optional source decoding failures return the symbol plus warnings. Use ordinary text search for strings, comments, configuration, and reflection names.",
  java_find_definition: "Resolve the exact semantic declaration and its full declaration line range. Source context, body, direct class members, and documentation are opt-in. Qualified targets still return the semantic location when source decoding fails; source-derived expansion is then omitted.",
  java_find_references: "Find semantic usages with optional call/read/write filtering, enclosing declarations, containing-symbol scope, and source snippets. Use text search for comments, strings, templates, configuration, and reflection names.",
  java_call_hierarchy: "Find incoming callers or outgoing callees of a method or constructor as a bounded semantic graph. Incoming hierarchies exclude test callers by default; set callerScope=tests for test callers only or callerScope=all for both.",
  java_type_hierarchy: "Find semantic supertypes, subtypes, implementations, interfaces, and permitted subclasses.",
  java_diagnostics: "Return JDT/ECJ diagnostics for the exact synchronized content. All requested paths share one deadline; status=partial identifies paths whose current-version diagnostics were not published in time. Use immediately after applying external patches.",
  java_compile: "Run an Eclipse workspace build with ECJ in private state. Builds automatically build loaded prerequisite projects and retry blocked dependents. Build status is authoritative; diagnosticsComplete says whether error details were published by JDT. Use before declaring a Java change complete; Maven/Gradle lifecycle tests remain separate.",
  java_run_tests: "Run one selector with path/className/methodName or batch up to 100 selectors in tests. Batch selectors, distinct classpath groups, and concurrent calls run in parallel after sharing compilation; do not batch tests that require exclusive shared resources. Set debug=true to launch the selected tests in a suspended JDWP JVM and return debug session ids immediately; set breakpoints first, then call java_debug_execute with action=continue and no stopId to release the initial startup suspension. Use the java_debug_* tools to inspect and continue, then run the same test normally for its result. Set compileProjectOnly=true to compile only selected JDT projects. Pass coverage={} to opt into JaCoCo; coverage.details=summary omits files, while files are independently paginated with coverage.limit/cursor. Prefer this for targeted unit tests; use Maven/Gradle when lifecycle plugins or integration-test setup matters.",
  java_find_affected_tests: "Find JUnit/TestNG test methods that can statically reach a target through JDT call relationships. This selects fast candidate tests; it does not prove runtime coverage.",
  java_find_unused_code: "Find private methods, constructors, and fields with no semantic references, plus optionally write-only fields. Results are candidates because reflection and frameworks may access members implicitly.",
  java_code_actions: "List JDT quick fixes/refactorings and mint short-lived handles. Does not apply changes.",
  java_edit_preview: "Calculate rename, code-action, import, or formatting edits without modifying files. Apply the preview with the normal patch tool.",
  java_debug_targets: "Discover local Java processes that were started with the JDWP agent. This is read-only and does not attach; call java_debug_attach with a selected targetId.",
  java_debug_attach: "Attach a JDI debug session to one selected local JDWP target. A target normally accepts only one debugger, so detach Eclipse or another debugger first.",
  java_debug_sessions: "List debug sessions owned by this MCP server and their running, stopped, terminated, or disconnected state.",
  java_debug_set_breakpoints: "Idempotently replace all source-line breakpoints for one workspace-relative Java source file. Unloaded classes remain pending until class preparation.",
  java_debug_threads: "List target JVM threads and the current location of suspended threads. System JVM threads are omitted by default.",
  java_debug_wait_for_stop: "Wait for a breakpoint or step event with a bounded timeout. A timeout is a normal outcome. Use the returned stopId for stack and variable inspection.",
  java_debug_stack_trace: "Read a bounded stack trace for the thread suspended at the current stop. Frame handles become stale as soon as execution resumes.",
  java_debug_variables: "Read arguments, locals, this, or lazily expand an object/array value. Handles are scoped to stopId and become stale on resume.",
  java_debug_execute: "Continue the target or step over, into, or out on the stopped thread. Step actions require the current stopId and threadId; waitTimeoutMs can atomically await the next stop.",
  java_debug_detach: "Detach this MCP debug session without terminating the target JVM. Any event-set suspension owned by the session is resumed first.",
  java_debug_hot_swap: "Compile selected workspace Java sources with ECJ and redefine their loaded classes through JDI Hot Code Replace. Standard JVMs generally support method-body changes only; breakpoints are restored after replacement.",
};

export function buildMcpServer(service: JavaService, config: Config, logger: Logger, debug?: DebugService): McpServer {
  const debuggerService = debug ?? new DebugService(config, logger, service);
  const server = new McpServer({ name: application.name, version: application.version }, { capabilities: { tools: { listChanged: false } }, instructions: "Every Java tool automatically waits on the same shared JDT semantic-readiness gate; do not use a fixed startup delay. java_status with waitForReady=true observes that gate explicitly. Use semantic tools for Java symbols and ordinary file/search/patch tools for source changes. Use java_find_affected_tests to select fast candidate tests, then batch independent selectors in java_run_tests: selected tests and concurrent calls execute in parallel after sharing compilation, so do not batch tests requiring exclusive shared resources. Set compileProjectOnly=true when compiling only the selected JDT projects is safe. Use Maven/Gradle when lifecycle plugins, code generation, packaging, integration-test setup, or full-suite assurance matters. Run diagnostics after patches and ECJ compilation before completion. For runtime debugging, discover a local JDWP target, attach one session, set breakpoints, and treat stopId/frameId/valueId handles as invalid after continue or step; detach without terminating the target when done." });
  const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  type Registration = (name: string, config: { description: string; inputSchema: object; annotations: object }, callback: (input: unknown, context: { mcpReq: { signal: AbortSignal } }) => Promise<object>) => unknown;
  const registerTool = server.registerTool.bind(server) as unknown as Registration;
  type ToolInput<N extends ToolName> = z.output<(typeof inputs)[N]>;
  const register = <N extends ToolName>(name: N, handler: (input: ToolInput<N>, signal: AbortSignal) => Promise<object> | object): void => {
    const annotations = name === "java_compile" || name === "java_debug_attach" || name === "java_debug_set_breakpoints" || name === "java_debug_execute" || name === "java_debug_detach" || name === "java_debug_hot_swap" ? { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } : name === "java_run_tests" ? { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } : readAnnotations;
    registerTool(name, { description: descriptions[name], inputSchema: inputs[name], annotations }, async (input, context) => {
      try {
        const parsed = inputs[name].parse(input) as ToolInput<N>;
        const value = await abortable(Promise.resolve(handler(parsed, context.mcpReq.signal)), context.mcpReq.signal);
        const structuredContent = outputs[name].parse(enforceToolBudget(name, value, config.resultBudget)) as Record<string, unknown>;
        const text = config.resultMode === "text" ? textResult(name, structuredContent) : summary(structuredContent);
        return { content: [{ type: "text" as const, text }], structuredContent };
      } catch (error) {
        if (context.mcpReq.signal.aborted) throw context.mcpReq.signal.reason;
        const e = error instanceof JavaLspMcpError ? error : new JavaLspMcpError("INTERNAL_ERROR", error instanceof Error ? error.message : String(error));
        logger.error(`${name} failed`, { code: e.code, message: e.message });
        return { isError: true, content: [{ type: "text" as const, text: `${e.code}: ${e.message}` }] };
      }
    });
  };
  register("java_status", i => service.status(i));
  register("java_outline", i => service.outline(i));
  register("java_search_symbols", i => service.search(i));
  register("java_find_definition", i => service.definition(i));
  register("java_find_references", i => service.references(i));
  register("java_call_hierarchy", i => service.callHierarchy(i));
  register("java_type_hierarchy", i => service.typeHierarchy(i));
  register("java_diagnostics", (i, signal) => service.diagnostics(i, signal));
  register("java_compile", i => service.compile(i));
  register("java_run_tests", (i, signal) => i.debug ? debuggerService.runTests(i, signal) : service.runTests(i, signal));
  register("java_find_affected_tests", (i, signal) => service.affectedTests(i, signal));
  register("java_find_unused_code", (i, signal) => service.unusedCode(i, signal));
  register("java_code_actions", i => service.codeActions(i));
  register("java_edit_preview", i => service.editPreview(i));
  register("java_debug_targets", i => debuggerService.targets(i));
  register("java_debug_attach", i => debuggerService.attach(i));
  register("java_debug_sessions", () => debuggerService.sessions());
  register("java_debug_set_breakpoints", i => debuggerService.setBreakpoints(i));
  register("java_debug_threads", i => debuggerService.threads(i));
  register("java_debug_wait_for_stop", i => debuggerService.wait(i));
  register("java_debug_stack_trace", i => debuggerService.stack(i));
  register("java_debug_variables", i => debuggerService.variables(i));
  register("java_debug_execute", i => debuggerService.execute(i));
  register("java_debug_detach", i => debuggerService.detach(i));
  register("java_debug_hot_swap", (i, signal) => debuggerService.hotSwap(i, signal));
  return server;
}

export function describeTools(): object {
  return { tools: (Object.keys(inputs) as ToolName[]).map(name => ({ name, description: descriptions[name], inputSchema: z.toJSONSchema(inputs[name], { io: "input" }), outputSchema: z.toJSONSchema(outputs[name], { io: "output" }) })) };
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const aborted = (): void => reject(signal.reason ?? new Error("Request cancelled"));
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(value => { signal.removeEventListener("abort", aborted); resolve(value); }, error => { signal.removeEventListener("abort", aborted); reject(error); });
  });
}

export function enforceToolBudget(name: ToolName, value: object, budget: number): object {
  if (name !== "java_status") return value;
  const result = structuredClone(value) as Record<string, unknown>;
  for (const key of ["testClasspathEntries", "excludedProjects", "problems", "message"] as const) {
    if (Buffer.byteLength(JSON.stringify(result), "utf8") <= budget) break;
    delete result[key];
  }
  return result;
}

function summary(value: Record<string, unknown>): string { if (value.status === "partial") return "partial; retry pending paths"; const count = ["symbols", "definitions", "references", "actions", "diagnostics", "files", "edges", "tests", "candidates"].map(key => value[key]).find(Array.isArray)?.length; if (typeof count === "number") return `${count} result${count === 1 ? "" : "s"}`; if (typeof value.state === "string") return value.state; return "complete"; }
function textResult(name: ToolName, value: Record<string, unknown>): string {
  if (name === "java_find_references") return ((value.references as Array<Record<string, unknown>> | undefined) ?? []).map(item => `${String(item.path)}:${String(item.line)}:${String(item.column)}: ${String(item.text ?? "")}`).join("\n") || "no results";
  if (name === "java_diagnostics") {
    if (value.status === "partial") return "partial; retry pending paths";
    const out: string[] = [];
    for (const item of (value.diagnostics as Array<Record<string, unknown>> | undefined) ?? []) out.push(`${String(item.path)}:${String(item.line)}:${String(item.column)}: ${String(item.text ?? item.message ?? "")}`);
    return out.join("\n") || "no results";
  }
  return JSON.stringify(value);
}

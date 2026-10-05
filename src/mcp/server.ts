import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Config } from "../config/config.js";
import type { Logger } from "../logging.js";
import { JavaLspMcpError } from "../types.js";
import type { JavaService } from "./service.js";
import { DebugService } from "../debug/service.js";
import { inputs, outputs, type ToolName } from "./schemas.js";
import { normalizeInput, withInputWarnings } from "./input-normalization.js";
import { application } from "../version.js";

export const descriptions: Record<ToolName, string> = {
  java_status: "Check readiness, startup failures, and background activity. waitForReady=true waits for semantic readiness; busy activity may coexist with ready=true.",
  java_outline: "List declarations in one file, with line ranges and nested members. containingLine selects its enclosing declaration chain. Filters and depth control the outline; method bodies are omitted.",
  java_search_symbols: "Batch symbol searches in queries. scope defaults to workspace; all includes dependencies. line keeps the nearest declaration before pagination; omit for all matches. includeImplementation adds up to 200 source lines only when one workspace match remains. Use text search for non-symbol text.",
  java_find_definition: "Batch declaration lookups in queries. expand enables context, body, or direct members; includeDocumentation adds documentation. Dependency symbols require a workspace source position that references them. If source decoding fails, qualified workspace targets can still return locations without source expansions.",
  java_find_references: "Batch semantic usages in queries. Declarations are excluded and scope is workspace by default. usageKinds filters calls/reads/writes; within limits usages to an enclosing declaration. includeEnclosing adds owners, includeText adds the usage line, and contextLines>0 adds snippets.",
  java_call_hierarchy: "Batch method/constructor call graphs in queries; direction is required. Incoming callerScope defaults to production; tests selects tests only, all includes both. callerScope is ignored for outgoing graphs. depth and limitPerNode bound traversal.",
  java_type_hierarchy: "Batch type graphs in queries: supertypes, subtypes, implementations, and interfaces. direction defaults to both; depth bounds traversal. Returns root, nodes, and edges per query.",
  java_diagnostics: "Read compiler diagnostics without building. scope=path requires path; paths requires paths; workspace accepts neither. Current-version checks are on by default. waitForCurrentVersion=false allows cached diagnostics. JDT_BUSY or status=partial reports pendingPaths; inspect java_status before retrying. Refresh changed build files with java_update_projects first.",
  java_compile: "Compile with ECJ; kind defaults to incremental. Failed incremental builds retry clean once unless current diagnostics confirm syntax errors. Returns final build status, diagnostics, and buildAttempts; diagnosticsComplete indicates whether diagnostic reporting settled. A cursor pages the saved build without recompiling.",
  java_run_tests: "Batch independent JUnit selectors in tests; each needs path or className, optionally methodName. Ambiguous class names require path. Requires workspace trust. Compiles incrementally by default with clean recovery, reusing successful builds; compile=none skips it. Persistent failures include compilation diagnostics. Runs may execute in parallel: avoid tests requiring exclusive resources. compileProjectOnly selects projects and loaded prerequisites. coverage={} enables coverage; details=summary omits file pages. Cursors page the saved run. debug=true starts attached, suspended sessions; set breakpoints then continue without stopId. Debug excludes coverage and custom JDWP vmArgs.",
  java_update_projects: "Refresh Maven/Gradle configuration after build-file or dependency changes. Requires workspace trust. Pass paths, or all=true without paths; omitted paths or paths containing '*' selects all eligible projects. force=true reimports the whole workspace, ignoring selectors. May download dependencies. Compile afterwards.",
  java_find_affected_tests: "Batch candidate affected-test searches in queries. Traverses incoming calls to JUnit/TestNG tests; transitive defaults to true. complete=false means traversal was cut short. Static candidates do not prove coverage; use them to select tests for java_run_tests.",
  java_find_unused_code: "Analyze source files in paths, or omit paths for the workspace. Finds private methods/constructors/fields with no semantic usages; includeWriteOnly also finds write-only fields. Files share timeout and pagination. complete=false means partial analysis; reflection/framework access makes candidates unsuitable for automatic deletion.",
  java_code_actions: "Batch fixes/refactorings for path+range entries in queries; kinds defaults to quickfix; use refactor or source.* kinds for other actions. Returns action IDs for java_edit_preview(operation=codeAction). IDs expire or become stale after workspace changes; request actions again on STALE_ACTION.",
  java_edit_preview: "Preview edits: rename requires target+newName; codeAction requires an ID from java_code_actions; organizeImports/format require path, with optional range for format. includeDiff adds a diff. Check returned baseHash before applying edits with a file-editing tool. Command-based actions cannot be previewed.",
  java_debug_targets: "Discover local JVMs with JDWP enabled; pass a returned attachable targetId to java_debug_attach. query filters targets; includeUnavailable also shows targets that cannot be attached.",
  java_debug_attach: "Attach to a targetId from java_debug_targets and return a sessionId. A JVM normally accepts one debugger: detach another debugger first. Brief retries handle reattachment after java_debug_detach.",
  java_debug_sessions: "List this server's sessions, states, stopId, stoppedThreads, and activeRequest. Use to recover session/stop handles; external debuggers' sessions are excluded.",
  java_debug_set_breakpoints: "Replace all breakpoints for sessionId+sourcePath. breakpoints=[] clears that file's breakpoints. Lines clamp to source bounds; unloaded classes remain pending until loaded.",
  java_debug_threads: "List JVM threads and suspended locations. System threads are hidden by default. namePattern is a full-match Java regex; packagePrefix filters available declaring-class names. Use threadId from a stop event for stack inspection and stepping.",
  java_debug_wait_for_stop: "Wait for a breakpoint, step, or terminal event. Timeout is a normal outcome; wait again while execution is pending. A stopped response supplies stopId and threadId for inspection.",
  java_debug_stack_trace: "Inspect the current stopped threadId from a stop event. Omit stopId for the current stop. Infrastructure frames are hidden by default. startFrame is zero-based; use nextStartFrame for the next page. Returned frameIds feed java_debug_variables.",
  java_debug_variables: "Inspect exactly one frameId or valueId at the current stop; omit stopId to use it. frameId comes from java_debug_stack_trace; valueId expands an object/array from this tool. start is zero-based; use nextStart to paginate. inlineFields expands fields; includeGetters invokes target code. Handles expire on execution.",
  java_debug_execute: "Continue or step the current stop. Steps require the stopped event's threadId. Omit stopId for the current stop; startup-suspended test sessions use continue without stopId. waitTimeoutMs optionally waits for the next event. If execution is pending, use java_debug_wait_for_stop instead of issuing another action.",
  java_debug_detach: "Detach sessionId, release debugger-owned suspensions, and leave the JVM running.",
  java_debug_hot_swap: "Compile sourcePaths and replace their loaded classes in sessionId. dryRun still compiles but skips replacement. Standard JVMs usually permit only method-body changes. Returns class outcomes, compiler diagnostics, and active-frame impacts; restores breakpoints after replacement.",
};

export const serverInstructions = "Use Java tools for symbols and compiler feedback; edit source with file tools. Paths are workspace-relative. Source lines/columns are one-based Unicode code points; range ends are exclusive. Targets use workspace qualifiedName or path+line: omit column for the innermost enclosing declaration, include it for an exact position. Batch related lookups in queries (cap 20): results preserve order with independent options/cursors and per-entry errors. Tests use tests; unused-code analysis uses paths. To paginate, repeat the same input with nextCursor; stale/expired cursors require restarting without it. Symbol/reference snapshots cache for 2 minutes. Numeric controls clamp to integer ranges; oversized arrays keep their first allowed entries. inputWarnings reports adjustments/omissions. Source coordinates clamp to file bounds; reversed ranges collapse to their start. Source uses configured encoding, otherwise UTF-8 with Windows-1252 fallback. Semantic tools wait for initial JDT readiness; java_status with waitForReady=true observes it without fixed delays. After edits, check diagnostics and compile; use Maven/Gradle for full build lifecycles or integration setup. Debug session operations require sessionId from java_debug_attach or java_run_tests(debug=true); use returned handles and refresh stop/frame/value handles after continue or step.";

export function buildMcpServer(service: JavaService, config: Config, logger: Logger, debug?: DebugService): McpServer {
  const debuggerService = debug ?? new DebugService(config, logger, service);
  const server = new McpServer({ name: application.name, version: application.version }, { capabilities: { tools: { listChanged: false } }, instructions: serverInstructions });
  const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  type Registration = (name: string, config: { description: string; inputSchema: object; annotations: object }, callback: (input: unknown, context: { mcpReq: { signal: AbortSignal } }) => Promise<object>) => unknown;
  const registerTool = server.registerTool.bind(server) as unknown as Registration;
  type ToolInput<N extends ToolName> = z.output<(typeof inputs)[N]>;
  const register = <N extends ToolName>(name: N, handler: (input: ToolInput<N>, signal: AbortSignal) => Promise<object> | object): void => {
    const annotations = name === "java_compile" || name === "java_debug_attach" || name === "java_debug_set_breakpoints" || name === "java_debug_execute" || name === "java_debug_detach" || name === "java_debug_hot_swap" ? { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } : name === "java_run_tests" ? { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } : name === "java_update_projects" ? { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } : readAnnotations;
    registerTool(name, { description: descriptions[name], inputSchema: inputs[name], annotations }, async (input, context) => {
      const normalized = normalizeInput(inputs[name], input);
      const inputWarnings = normalized.warnings;
      try {
        const parsed = inputs[name].parse(normalized.input) as ToolInput<N>;
        const value = await abortable(Promise.resolve(withInputWarnings(inputWarnings, () => handler(parsed, context.mcpReq.signal))), context.mcpReq.signal);
        let structuredContent: Record<string, unknown>;
        try {
          structuredContent = outputs[name].parse(enforceToolBudget(name, inputWarnings.length ? { ...value, inputWarnings } : value, config.resultBudget)) as Record<string, unknown>;
        } catch (error) {
          throw outputValidationError(name, error, logger);
        }
        const resultText = config.resultMode === "text" ? textResult(name, structuredContent) : summary(structuredContent);
        const text = [resultText, ...inputWarnings.map(w => `Warning: ${w.message}`)].join("\n");
        return { content: [{ type: "text" as const, text }], structuredContent };
      } catch (error) {
        if (context.mcpReq.signal.aborted) throw context.mcpReq.signal.reason;
        const e = error instanceof JavaLspMcpError ? error : new JavaLspMcpError("INTERNAL_ERROR", error instanceof Error ? error.message : String(error));
        logger.error(`${name} failed`, { code: e.code, message: e.message });
        return { isError: true, content: [{ type: "text" as const, text: [`${e.code}: ${e.message}`, ...inputWarnings.map(w => `Warning: ${w.message}`)].join("\n") }], structuredContent: { code: e.code, message: e.message, ...(inputWarnings.length && { inputWarnings }), ...(e.details !== undefined && { details: e.details }) } };
      }
    });
  };
  register("java_status", i => service.status(i));
  register("java_outline", i => service.outline(i));
  register("java_search_symbols", (i, signal) => runQueryBatch(i.queries, q => service.search(q), signal));
  register("java_find_definition", (i, signal) => runQueryBatch(i.queries, q => service.definition(q), signal));
  register("java_find_references", (i, signal) => runQueryBatch(i.queries, q => service.references(q), signal));
  register("java_call_hierarchy", (i, signal) => runQueryBatch(i.queries, q => service.callHierarchy(q), signal));
  register("java_type_hierarchy", (i, signal) => runQueryBatch(i.queries, q => service.typeHierarchy(q), signal));
  register("java_diagnostics", (i, signal) => service.diagnostics(i, signal));
  register("java_compile", i => service.compile(i));
  register("java_run_tests", (i, signal) => i.debug ? debuggerService.runTests(i, signal) : service.runTests(i, signal));
  register("java_update_projects", (i, signal) => service.updateProjects(i, signal));
  register("java_find_affected_tests", (i, signal) => runQueryBatch(i.queries, q => service.affectedTests(q, signal), signal));
  register("java_find_unused_code", (i, signal) => service.unusedCode(i, signal));
  register("java_code_actions", (i, signal) => runQueryBatch(i.queries, q => service.codeActions(q), signal));
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

export async function runQueryBatch<T>(queries: readonly T[], handler: (query: T) => Promise<object>, signal: AbortSignal): Promise<{ results: object[] }> {
  const results: object[] = [];
  for (const query of queries) {
    signal.throwIfAborted();
    try {
      results.push(await abortable(handler(query), signal));
    } catch (error) {
      signal.throwIfAborted();
      const e = error instanceof JavaLspMcpError ? error : new JavaLspMcpError("INTERNAL_ERROR", error instanceof Error ? error.message : String(error));
      results.push({ error: { code: e.code, message: e.message, ...(e.details !== undefined && { details: e.details }) } });
    }
  }
  return { results };
}

export function outputValidationError(name: ToolName, error: unknown, logger: Logger): JavaLspMcpError {
  if (error instanceof z.ZodError) logger.error(`${name} returned a result that failed output validation`, { issues: error.issues });
  return new JavaLspMcpError("INTERNAL_ERROR", `${name} returned a result that failed output validation`);
}

export function describeTools(): object {
  return { instructions: serverInstructions, tools: (Object.keys(inputs) as ToolName[]).map(name => ({ name, description: descriptions[name], inputSchema: z.toJSONSchema(inputs[name], { io: "input" }), outputSchema: z.toJSONSchema(outputs[name], { io: "output" }) })) };
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

function summary(value: Record<string, unknown>): string { if (Array.isArray(value.results)) return value.results.map((item, index) => `${index + 1}: ${"error" in item ? `${item.error.code}: ${item.error.message}` : summary(item)}`).join("\n"); if (value.status === "partial") return "partial; retry pending paths"; const count = ["symbols", "definitions", "references", "actions", "diagnostics", "files", "edges", "tests", "candidates"].map(key => value[key]).find(Array.isArray)?.length; if (typeof count === "number") return `${count} result${count === 1 ? "" : "s"}`; if (typeof value.state === "string") return value.state; return "complete"; }
export function textResult(name: ToolName, value: Record<string, unknown>): string {
  if (Array.isArray(value.results)) return value.results.map((item, index) => `${index + 1}: ${"error" in item ? `${item.error.code}: ${item.error.message}` : textResult(name, item)}`).join("\n");
  if (name === "java_find_references") return ((value.references as Array<Record<string, unknown>> | undefined) ?? []).map(item => `${String(item.path)}:${String(item.line)}:${String(item.column)}: ${String(item.text ?? "")}`).join("\n") || "no results";
  if (name === "java_diagnostics") {
    if (value.status === "partial") return "partial; retry pending paths";
    const out: string[] = [];
    for (const item of (value.diagnostics as Array<Record<string, unknown>> | undefined) ?? []) out.push(`${String(item.path)}:${String(item.line)}:${String(item.column)}: ${String(item.text ?? item.message ?? "")}`);
    return out.join("\n") || "no results";
  }
  return JSON.stringify(value);
}

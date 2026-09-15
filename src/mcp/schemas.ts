import { z } from "zod";

const path = z.string().min(1).max(4096).describe("Workspace-relative path");
const position = z.object({ path, line: z.number().int().positive(), column: z.number().int().positive() }).strict();
const qualified = z.object({ qualifiedName: z.string().min(1).max(1000) }).strict();
export const target = z.xor([position, qualified]);
export const range = z.object({ line: z.number().int().positive(), column: z.number().int().positive(), endLine: z.number().int().positive(), endColumn: z.number().int().positive() }).strict().superRefine((value, context) => {
  if (value.endLine < value.line || value.endLine === value.line && value.endColumn < value.column) context.addIssue({ code: "custom", message: "range end must not precede range start" });
});
const cursor = z.union([z.string().max(4096), z.null()]).optional().transform(value => value ?? undefined);
const page = { limit: z.number().int().min(1).max(200).default(50), cursor, includeTotal: z.boolean().default(false) };
const symbolKinds = z.enum(["file", "module", "namespace", "package", "class", "method", "property", "field", "constructor", "enum", "interface", "function", "variable", "constant", "enumMember", "struct", "event", "operator", "typeParameter"]);
const visibility = z.enum(["public", "protected", "package", "private"]);
const namePattern = z.string().max(200).optional();
const testSelector = z.object({ path, className: z.string().min(1).max(1000).optional(), methodName: z.string().min(1).max(1000).optional() }).strict();
const coverageOptions = z.object({ enabled: z.boolean().default(true), includes: z.array(z.string().min(1).max(1000)).max(100).default([]), details: z.enum(["summary", "files"]).default("files"), limit: z.number().int().min(1).max(200).default(50), cursor, includeTotal: z.boolean().default(false) }).strict();
export const inputs = {
  java_status: z.object({ waitForReady: z.boolean().default(false), timeoutMs: z.number().int().min(1).max(600_000).default(120_000) }).strict(),
  java_outline: z.object({ path, depth: z.number().int().min(0).max(20).default(2), visibility: z.array(visibility).min(1).max(4).default(["public", "protected", "package", "private"]), kinds: z.array(symbolKinds).min(1).max(20).default(["class", "interface", "enum", "constructor", "method", "field"]), format: z.literal("compact").default("compact"), containingLine: z.number().int().positive().optional(), ...page, namePattern }).strict(),
  java_search_symbols: z.object({ query: z.string().min(1).max(500), kinds: z.array(symbolKinds).max(20).optional(), scope: z.enum(["workspace", "dependencies", "all"]).default("workspace"), mode: z.enum(["exact", "prefix", "camelCase", "fuzzy"]).default("fuzzy"), includeImplementation: z.boolean().default(false), ...page }).strict(),
  java_find_definition: z.object({ target, expand: z.array(z.enum(["context", "body", "members"])).max(3).default([]), contextLines: z.number().int().min(0).max(50).default(10), maxSourceCharacters: z.number().int().min(100).max(50_000).default(4000), includeDocumentation: z.boolean().default(false), maxDocumentationCharacters: z.number().int().min(0).max(10_000).default(1000), ...page }).strict(),
  java_find_references: z.object({ target, includeDeclaration: z.boolean().default(false), scope: z.enum(["workspace", "all"]).default("workspace"), usageKinds: z.array(z.enum(["call", "read", "write"])).min(1).max(3).optional(), within: target.optional(), includeEnclosing: z.boolean().default(false), includeText: z.boolean().default(false), contextLines: z.number().int().min(0).max(20).default(0), maxSnippetCharacters: z.number().int().min(100).max(10_000).default(1000), ...page }).strict(),
  java_call_hierarchy: z.object({ target, direction: z.enum(["incoming", "outgoing"]), callerScope: z.enum(["production", "tests", "all"]).default("production").describe("Incoming callers to return; ignored for outgoing hierarchies"), depth: z.number().int().min(1).max(3).default(1), limitPerNode: z.number().int().min(1).max(200).default(25), ...page }).strict(),
  java_type_hierarchy: z.object({ target, direction: z.enum(["supertypes", "subtypes", "both"]).default("both"), depth: z.number().int().min(1).max(3).default(2), ...page }).strict(),
  java_diagnostics: z.object({ scope: z.enum(["path", "paths", "workspace"]), path: path.optional(), paths: z.array(path).max(200).optional(), minimumSeverity: z.enum(["error", "warning", "info", "hint"]).default("warning"), waitForCurrentVersion: z.boolean().default(true), includeText: z.boolean().default(false), timeoutMs: z.number().int().min(1).max(120_000).default(30_000), ...page }).strict().superRefine((v, ctx) => {
    if (v.scope === "path" && !v.path) ctx.addIssue({ code: "custom", message: "path is required for path scope" });
    if (v.scope === "paths" && !v.paths?.length) ctx.addIssue({ code: "custom", message: "paths is required for paths scope" });
    if (v.scope !== "path" && v.path) ctx.addIssue({ code: "custom", message: "path is only valid for path scope" });
    if (v.scope !== "paths" && v.paths) ctx.addIssue({ code: "custom", message: "paths is only valid for paths scope" });
  }),
  java_compile: z.object({ kind: z.enum(["incremental", "clean"]).default("incremental"), minimumSeverity: z.enum(["error", "warning", "info", "hint"]).default("warning"), includeText: z.boolean().default(false), timeoutMs: z.number().int().min(1).max(600_000).default(120_000), ...page }).strict(),
  java_run_tests: z.object({ path: path.optional(), className: z.string().min(1).max(1000).optional(), methodName: z.string().min(1).max(1000).optional(), tests: z.array(testSelector).min(1).max(100).optional(), compile: z.enum(["incremental", "clean", "none"]).default("incremental"), compileProjectOnly: z.boolean().default(false), workingDirectory: path.optional(), vmArgs: z.array(z.string().max(2000)).max(50).default([]), systemProperties: z.record(z.string().max(500), z.string().max(4000)).default({}), timeoutMs: z.number().int().min(1).max(600_000).default(120_000), includeOutput: z.boolean().default(false), includeStackTrace: z.boolean().default(false), coverage: coverageOptions.optional(), ...page }).strict().superRefine((value, ctx) => { if (!value.path && !value.tests) ctx.addIssue({ code: "custom", message: "path or tests is required" }); if (value.path && value.tests) ctx.addIssue({ code: "custom", message: "path and tests are mutually exclusive" }); if (!value.path && (value.className || value.methodName)) ctx.addIssue({ code: "custom", message: "top-level className and methodName require path" }); }),
  java_find_affected_tests: z.object({ target, transitive: z.boolean().default(true), maxDepth: z.number().int().min(1).max(20).default(10), timeoutMs: z.number().int().min(1).max(600_000).default(120_000), ...page }).strict(),
  java_find_unused_code: z.object({ path: path.optional(), kinds: z.array(z.enum(["method", "constructor", "field"])).min(1).max(3).default(["method", "constructor", "field"]), includeWriteOnly: z.boolean().default(true), timeoutMs: z.number().int().min(1).max(600_000).default(120_000), ...page }).strict(),
  java_code_actions: z.object({ path, range, diagnosticCodes: z.array(z.union([z.string(), z.number()])).max(100).default([]), kinds: z.array(z.string()).max(20).default(["quickfix"]), ...page }).strict(),
  java_edit_preview: z.discriminatedUnion("operation", [
    z.object({ operation: z.literal("rename"), target, newName: z.string().min(1).max(500), includeDiff: z.boolean().default(false), ...page }).strict(),
    z.object({ operation: z.literal("codeAction"), id: z.string().min(1), includeDiff: z.boolean().default(false), ...page }).strict(),
    z.object({ operation: z.literal("organizeImports"), path, includeDiff: z.boolean().default(false), ...page }).strict(),
    z.object({ operation: z.literal("format"), path, range: range.optional(), includeDiff: z.boolean().default(false), ...page }).strict(),
  ]),
} as const;

const anyObject = z.object({}).catchall(z.unknown());
export const outputs = {
  java_status: z.object({ state: z.string(), ready: z.boolean(), activity: z.string().optional(), projectKind: z.string(), modules: z.number(), compiler: z.literal("ecj"), mcpRevision: z.string(), jdtVersion: z.string(), toolingJdk: z.string(), projectJdk: z.string(), sourceEncoding: z.string().optional(), excludedProjects: z.array(z.string()).optional(), testClasspathEntries: z.array(z.string()).optional(), trusted: z.boolean(), offline: z.boolean(), message: z.string().optional(), problems: z.array(z.string()).optional() }).strict(),
  java_outline: z.object({ symbols: z.array(anyObject), total: z.number().optional(), nextCursor: z.string().optional() }).strict(),
  java_search_symbols: z.object({ symbols: z.array(anyObject), total: z.number().optional(), nextCursor: z.string().optional(), warnings: z.array(anyObject).optional() }).strict(),
  java_find_definition: z.object({ definitions: z.array(anyObject), total: z.number().optional(), nextCursor: z.string().optional(), documentation: z.string().optional() }).strict(),
  java_find_references: z.object({ references: z.array(anyObject), total: z.number().optional(), nextCursor: z.string().optional() }).strict(),
  java_call_hierarchy: z.object({ root: anyObject, nodes: z.array(anyObject), edges: z.array(anyObject), total: z.number().optional(), nextCursor: z.string().optional() }).strict(),
  java_type_hierarchy: z.object({ root: anyObject, nodes: z.array(anyObject), edges: z.array(anyObject), total: z.number().optional(), nextCursor: z.string().optional() }).strict(),
  java_diagnostics: z.object({ status: z.enum(["final", "partial"]), diagnostics: z.array(anyObject), counts: anyObject, pendingPaths: z.array(z.string()).optional(), message: z.string().optional(), total: z.number().optional(), nextCursor: z.string().optional() }).strict(),
  java_compile: z.object({ kind: z.string(), buildStatus: z.enum(["failed", "succeeded", "with-errors", "cancelled", "unknown"]), excludedProjects: z.array(z.string()).optional(), durationMs: z.number(), complete: z.boolean(), success: z.boolean(), diagnosticsComplete: z.boolean(), counts: anyObject, diagnostics: z.array(anyObject), total: z.number().optional(), nextCursor: z.string().optional(), message: z.string().optional(), buildFailures: z.array(z.string()).optional() }).strict(),
  java_run_tests: z.object({ status: z.enum(["passed", "failed", "compile-failed", "error", "timed-out"]), durationMs: z.number(), counts: anyObject, failures: z.array(anyObject), total: z.number().optional(), nextCursor: z.string().optional(), message: z.string().optional(), output: anyObject.optional(), coverage: anyObject.optional() }).strict(),
  java_find_affected_tests: z.object({ tests: z.array(anyObject), complete: z.boolean(), total: z.number().optional(), nextCursor: z.string().optional(), message: z.string().optional() }).strict(),
  java_find_unused_code: z.object({ candidates: z.array(anyObject), complete: z.boolean(), total: z.number().optional(), nextCursor: z.string().optional(), message: z.string().optional() }).strict(),
  java_code_actions: z.object({ actions: z.array(anyObject), total: z.number().optional(), nextCursor: z.string().optional() }).strict(),
  java_edit_preview: z.object({ files: z.array(anyObject), total: z.number().optional(), editCount: z.number(), nextCursor: z.string().optional(), unifiedDiff: z.string().optional() }).strict(),
} as const;
export type ToolName = keyof typeof inputs;

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SerialQueue } from "../async.js";
import type { Config } from "../config/config.js";
import type { LspClient } from "../jdtls/client.js";
import type { CodeAction, Diagnostic, DocumentSymbol, HierarchyItem, Location, SymbolInformation, TextEdit, WorkspaceEdit } from "../jdtls/protocol.js";
import { outlineNeedsReconcile } from "../jdtls/outline.js";
import { budgetItems, compact, truncateUtf8 } from "../results/budget.js";
import { publicEdit, sha256, unifiedDiff, validateAndSortEdits } from "../results/edits.js";
import { CursorSigner, fingerprint } from "../results/pagination.js";
import { codePointToUtf16Column, lines, publicLocation } from "../results/positions.js";
import { resolveCoverageRuntime, resolveTestRuntime } from "../runtime/resolver.js";
import { createCoverageReport, type CoverageReport } from "../testing/coverage.js";
import { runJUnit, type JunitRunOptions, type JunitRunResult } from "../testing/junit.js";
import { JavaLspMcpError, type LspPosition, type LspRange, type PositionTarget, type Snapshot, type SymbolTarget } from "../types.js";
import { discoverProject } from "../workspace/discovery.js";
import type { WorkspacePaths } from "../workspace/paths.js";
import { fileUriWithin, foldPath, pathWithin } from "../workspace/paths.js";
import { normalizeProjectSelector, projectMatches, resolveExcludedProjectRoots } from "../workspace/projects.js";
import type { WorkspaceSynchronizer } from "../workspace/watcher.js";
import { workspaceFiles } from "../workspace/files.js";
import { EnumConstantIndex } from "../workspace/enum-index.js";
import { ActionHandles } from "./actions.js";
import { application } from "../version.js";

const kinds = ["", "file", "module", "namespace", "package", "class", "method", "property", "field", "constructor", "enum", "interface", "function", "variable", "constant", "string", "number", "boolean", "array", "object", "key", "null", "enumMember", "struct", "event", "operator", "typeParameter"];
const severities = ["", "error", "warning", "info", "hint"] as const;
export interface TestSelectorInput { path: string; className?: string | undefined; methodName?: string | undefined }
interface CoverageInput { enabled: boolean; includes: string[]; details: "summary" | "files"; limit: number; includeTotal: boolean; cursor?: string | undefined }
export interface TestInput { path?: string | undefined; className?: string | undefined; methodName?: string | undefined; tests?: TestSelectorInput[] | undefined; compile: "incremental" | "clean" | "none"; compileProjectOnly: boolean; workingDirectory?: string | undefined; vmArgs: string[]; systemProperties: Record<string, string>; timeoutMs: number; includeOutput: boolean; includeStackTrace: boolean; debug?: boolean | undefined; coverage?: CoverageInput | undefined; limit: number; includeTotal: boolean; cursor?: string | undefined }
interface CachedTestRun extends JunitRunResult { coverage?: CoverageReport }
interface AffectedTestsInput { target: SymbolTarget; transitive: boolean; maxDepth: number; timeoutMs: number; limit: number; includeTotal: boolean; cursor?: string | undefined }
interface UnusedCodeInput { path?: string | undefined; kinds: ("method" | "constructor" | "field")[]; includeWriteOnly: boolean; timeoutMs: number; limit: number; includeTotal: boolean; cursor?: string | undefined }
interface AnalysisResult { items: object[]; complete: boolean; message?: string | undefined }
interface CompilationResult { status: "failed" | "succeeded" | "with-errors" | "cancelled" | "unknown"; durationMs: number; complete: boolean; success: boolean; diagnosticsComplete: boolean; entries: Array<{ uri: string; diagnostic: Diagnostic }>; message?: string | undefined; buildFailures?: string[] | undefined }
interface HierarchyInput { depth: number; limit: number; includeTotal: boolean; cursor?: string | undefined }
interface HierarchyStep { item: HierarchyItem; reverse?: boolean; relation?: string }
interface SearchCandidate { symbol: SymbolInformation; value: Record<string, unknown>; warning?: object | undefined }
class GenerationCache<T> {
  private readonly values = new Map<string, { value: T; generation: number; expires: number }>();
  constructor(private readonly ttlMs = 300_000) {}
  get(key: string, generation: number): T | undefined { const cached = this.values.get(key); if (!cached || cached.expires < Date.now() || cached.generation !== generation) { this.values.delete(key); return undefined; } return cached.value; }
  set(key: string, value: T, generation: number): void { const now = Date.now(); for (const [cachedKey, cached] of this.values) if (cached.expires < now) this.values.delete(cachedKey); this.values.set(key, { value, generation, expires: now + this.ttlMs }); }
}
export class JavaService {
  private readonly cursors = new CursorSigner();
  private readonly actions = new ActionHandles();
  private readonly editQueue = new SerialQueue();
  private readonly testRuns = new GenerationCache<CachedTestRun>();
  private readonly compilations = new GenerationCache<CompilationResult>();
  private readonly successfulTestCompilations = new Map<string, { generation: number; clean: boolean }>();
  private readonly pendingTestCompilations = new Map<string, Promise<void>>();
  private readonly buildQueue = new SerialQueue();
  private excludedRootsCache?: { roots: string[]; missing: string[] };
  private readonly analysisQueue = new SerialQueue();
  private readonly analyses = new GenerationCache<AnalysisResult>();
  private readonly enumConstants: EnumConstantIndex;
  constructor(private readonly config: Config, private readonly paths: WorkspacePaths, private readonly sync: WorkspaceSynchronizer, private readonly client: LspClient) { this.enumConstants = new EnumConstantIndex(paths, config.sourceEncoding); }
  async status(input: { waitForReady: boolean; timeoutMs: number }): Promise<object> {
    if (input.waitForReady) await this.client.waitReady(input.timeoutMs);
    const project = discoverProject(this.paths.root);
    const problems: string[] = [];
    if (!this.config.trustWorkspace && ["maven", "gradle", "mixed"].includes(project.kind)) problems.push("Build import disabled: restart with --trust-workspace after reviewing project build logic");
    return compact({ state: this.client.state, ready: this.client.ready, activity: this.client.activity, projectKind: project.kind, modules: project.modules, compiler: "ecj", mcpRevision: application.mcpRevision, jdtVersion: this.client.serverVersion, toolingJdk: this.config.toolingJdk ? "configured" : process.env.JAVA_HOME ? "JAVA_HOME" : "unavailable", projectJdk: this.config.projectJdk ? "configured" : "workspace/default", sourceEncoding: this.config.sourceEncoding, excludedProjects: this.config.excludedProjects?.length ? this.config.excludedProjects : undefined, testClasspathEntries: this.config.testClasspathEntries?.length ? this.config.testClasspathEntries : undefined, trusted: this.config.trustWorkspace, offline: this.config.offline, message: this.client.statusMessage, problems });
  }
  async outline(input: { path: string; depth: number; visibility: ("public" | "protected" | "package" | "private")[]; kinds: string[]; format: "compact"; containingLine?: number | undefined; limit: number; includeTotal: boolean; cursor?: string | undefined; namePattern?: string | undefined }): Promise<object> {
    const snap = await this.prepareFile(input.path);
    if (input.containingLine !== undefined && input.containingLine > lines(snap.content).length) throw new JavaLspMcpError("INVALID_POSITION", "containingLine is outside the file");
    const raw = await this.documentOutline(snap, this.config.timeoutMs);
    const pattern = compileNamePattern(input.namePattern);
    const values: object[] = [];
    const visit = (symbol: DocumentSymbol, depth: number): void => {
      if (depth > input.depth) return;
      const kind = kinds[symbol.kind] ?? `kind${symbol.kind}`;
      const visibility = kind === "package" ? undefined : declarationVisibility(snap, symbol);
      const contains = input.containingLine === undefined || kind !== "package" && symbol.range.start.line + 1 <= input.containingLine && symbol.range.end.line + 1 >= input.containingLine;
      if (contains && input.kinds.includes(kind) && (!visibility || input.visibility.includes(visibility)) && (!pattern || pattern.test(symbol.name))) {
        values.push(compact({ kind, name: symbol.name, visibility, depth, ...(kind === "package" ? {} : { startLine: symbol.range.start.line + 1, endLine: symbol.range.end.line + 1 }) }));
      }
      if (depth < input.depth) for (const child of symbol.children ?? []) visit(child, depth + 1);
    };
    for (const symbol of raw) visit(symbol, 0);
    const query = { tool: "outline", ...queryOf(input), path: snap.path, hash: snap.hash };
    const page = this.paginate(values, input.limit, input.cursor, query, symbols => ({ symbols }));
    return { symbols: page.items, ...(input.includeTotal && { total: values.length }), ...(page.nextCursor && { nextCursor: page.nextCursor }) };
  }
  async search(input: { query: string; kinds?: string[] | undefined; scope: string; mode: string; includeImplementation: boolean; limit: number; includeTotal: boolean; cursor?: string | undefined }): Promise<object> {
    await this.prepare(); const raw = await this.client.symbols(jdtSymbolQuery(input.query, input.mode), this.config.timeoutMs);
    const filtered = raw.filter(s => symbolNameMatches(s.name, input.query, input.mode)).filter(s => input.scope === "all" || this.paths.fromUri(s.location.uri).origin === (input.scope === "workspace" ? "workspace" : "dependency")).filter(s => !input.kinds?.length || input.kinds.includes(kinds[s.kind] ?? ""));
    const candidates: SearchCandidate[] = filtered.map(symbol => ({ symbol, value: this.symbol(symbol) as Record<string, unknown> }));
    if (typeof this.paths.root === "string" && input.scope !== "dependencies" && (input.kinds?.includes("enumMember") || !input.kinds?.length && filtered.length === 0)) {
      const excluded = this.excludedProjectRoots().roots;
      for (const entry of await this.enumConstants.all(this.sync.indexGeneration, excluded)) {
        if (!symbolNameMatches(entry.name, input.query, input.mode)) continue;
        const symbol: SymbolInformation = { name: entry.name, kind: 22, containerName: entry.container, location: { uri: pathToFileURL(this.paths.resolve(entry.path)).href, range: { start: { line: entry.line - 1, character: 0 }, end: { line: entry.line - 1, character: entry.name.length } } } };
        const duplicate = candidates.findIndex(candidate => String(candidate.value.name) === entry.name && String(candidate.value.path) === entry.path);
        const candidate = { symbol, value: this.symbol(symbol) as Record<string, unknown>, warning: entry.warning };
        if (duplicate >= 0) candidates[duplicate] = candidate; else candidates.push(candidate);
      }
    }
    const implementationWarnings: object[] = [];
    if (input.includeImplementation && candidates.length === 1) {
      try { candidates[0]!.value = await this.symbolImplementation(candidates[0]!.symbol, candidates[0]!.value) as Record<string, unknown>; }
      catch (error) {
        if (!(error instanceof JavaLspMcpError) || !["SOURCE_ENCODING_REQUIRED", "SOURCE_DECODING_FAILED"].includes(error.code)) throw error;
        implementationWarnings.push({ code: error.code, path: candidates[0]!.value.path, message: `${error.message}; implementation was omitted` });
      }
    }
    const values = candidates.map(candidate => candidate.value);
    const query = { tool: "search", ...queryOf(input) };
    const page = this.paginate(values, input.limit, input.cursor, query, symbols => ({ symbols }));
    const pageKeys = new Set(page.items.map(searchResultKey)); const warnings = [...candidates.filter(candidate => pageKeys.has(searchResultKey(candidate.value))).flatMap(candidate => candidate.warning ? [candidate.warning] : []), ...implementationWarnings];
    return { symbols: page.items, ...(input.includeTotal && { total: values.length }), ...(page.nextCursor && { nextCursor: page.nextCursor }), ...(warnings.length && { warnings: uniqueWarnings(warnings) }) };
  }
  async definition(input: { target: SymbolTarget; expand: ("context" | "body" | "members")[]; contextLines: number; maxSourceCharacters: number; includeDocumentation: boolean; maxDocumentationCharacters: number; limit: number; includeTotal: boolean; cursor?: string | undefined }): Promise<object> {
    let uri: string, position: LspPosition, hash: string | undefined;
    if ("qualifiedName" in input.target) {
      const symbol = await this.resolveQualifiedSymbol(input.target.qualifiedName); const normalized = this.paths.fromUri(symbol.location.uri);
      if (!normalized.editable) throw new JavaLspMcpError("DEPENDENCY_TARGET", "Qualified dependency targets require a source position");
      uri = symbol.location.uri; position = symbol.location.range.start;
    } else { const target = await this.resolveTarget(input.target); uri = target.snapshot.uri; position = target.position; hash = target.snapshot.hash; }
    const raw = await this.client.definition(uri, position, this.config.timeoutMs); const locations = raw ? (Array.isArray(raw) ? raw : [raw]) : [];
    const definitions = await Promise.all(locations.map(location => this.definitionResult(location, input))); const query = { tool: "definition", ...queryOf(input), ...(hash && { hash }) }; const page = this.paginate(definitions, input.limit, input.cursor, query, selected => ({ definitions: selected }));
    let documentation: string | undefined;
    if (input.includeDocumentation) documentation = hoverText(await this.client.hover(uri, position, this.config.timeoutMs)).trim().slice(0, input.maxDocumentationCharacters);
    return { definitions: page.items, ...(input.includeTotal && { total: definitions.length }), ...(page.nextCursor && { nextCursor: page.nextCursor }), ...(documentation && { documentation }) };
  }
  async references(input: { target: SymbolTarget; includeDeclaration: boolean; scope: string; usageKinds?: ("call" | "read" | "write")[] | undefined; within?: SymbolTarget | undefined; includeEnclosing: boolean; includeText: boolean; contextLines: number; maxSnippetCharacters: number; limit: number; includeTotal: boolean; cursor?: string | undefined }): Promise<object> {
    const target = await this.resolveTarget(input.target); let raw = await this.client.references(target.snapshot.uri, target.position, input.includeDeclaration, this.config.timeoutMs);
    if (input.scope === "workspace") raw = raw.filter(l => this.paths.fromUri(l.uri).origin === "workspace");
    if (input.within) {
      const boundaryTarget = await this.resolveTarget(input.within); const symbols = await this.documentOutline(boundaryTarget.snapshot, this.config.timeoutMs); const boundary = smallestContainingSymbol(symbols, boundaryTarget.position.line, new Set(kinds.filter(kind => kind && kind !== "package")));
      if (!boundary) throw new JavaLspMcpError("SYMBOL_NOT_FOUND", "No enclosing declaration was found for the within target");
      raw = raw.filter(location => location.uri === boundaryTarget.snapshot.uri && rangeContainsRange(boundary.range, location.range));
    }
    const usageByLocation = input.usageKinds ? await this.referenceUsageKinds(target, raw, input.usageKinds) : new Map<string, "call" | "read" | "write">();
    if (input.usageKinds) raw = raw.filter(location => usageByLocation.has(locationKey(location)));
    const query = { tool: "references", ...queryOf(input) }; const fp = fingerprint(query); const offset = input.cursor ? this.cursors.verify(input.cursor, fp, this.sync.indexGeneration) : 0; const candidates = raw.slice(offset, offset + input.limit);
    const outlineCache = new Map<string, Promise<DocumentSymbol[]>>();
    const rows = await Promise.all(candidates.map(async location => {
      const item = await this.compactLocation(location); const snap = this.sync.snapshots.get(item.path as string); let enclosing: object | undefined;
      if (input.includeEnclosing && snap) {
        let pending = outlineCache.get(snap.uri); if (!pending) { pending = this.documentOutline(snap, this.config.timeoutMs); outlineCache.set(snap.uri, pending); }
        const symbol = smallestContainingSymbol(await pending, location.range.start.line, new Set(["class", "interface", "enum", "constructor", "method"]));
        if (symbol) enclosing = { kind: kinds[symbol.kind] ?? `kind${symbol.kind}`, name: symbol.name, startLine: symbol.range.start.line + 1, endLine: symbol.range.end.line + 1 };
      }
      const snippet = snap && input.contextLines > 0 ? sourceExcerpt(snap.content, location.range.start.line - input.contextLines, location.range.end.line + input.contextLines, input.maxSnippetCharacters) : undefined;
      return compact({ ...item, usageKind: usageByLocation.get(locationKey(location)), enclosing, text: input.includeText && snap ? lines(snap.content)[location.range.start.line]?.trim().slice(0, input.maxSnippetCharacters) : undefined, snippet });
    }));
    let selected = budgetItems(rows, Math.max(1024, this.config.resultBudget - 512), references => ({ references })).items; if (!selected.length && rows.length) selected = rows.slice(0, 1); const nextOffset = offset + selected.length;
    return { references: selected, ...(input.includeTotal && { total: raw.length }), ...(nextOffset < raw.length && { nextCursor: this.cursors.sign(fp, nextOffset, this.sync.indexGeneration) }) };
  }
  async callHierarchy(input: { target: SymbolTarget; direction: "incoming" | "outgoing"; callerScope: "production" | "tests" | "all"; depth: number; limitPerNode: number; limit: number; includeTotal: boolean; cursor?: string | undefined }): Promise<object> {
    const target = await this.resolveTarget(input.target); const roots = await this.client.prepareCall(target.snapshot.uri, target.position, this.config.timeoutMs); const root = roots[0]; if (!root) return { root: {}, nodes: [], edges: [], ...(input.includeTotal && { total: 0 }) };
    const testFiles = new Map<string, Promise<boolean>>();
    const isTestCaller = (item: HierarchyItem): Promise<boolean> => {
      const target = this.paths.fromUri(item.uri); if (target.origin !== "workspace") return Promise.resolve(false);
      let classification = testFiles.get(item.uri); if (!classification) { classification = this.client.isTestFile(item.uri, this.config.timeoutMs); testFiles.set(item.uri, classification); }
      return classification;
    };
    return this.hierarchyResult(root, input, { tool: "callHierarchy", ...queryOf(input) }, async item => {
      let calls = input.direction === "incoming" ? await this.client.callIncoming(item, this.config.timeoutMs) : await this.client.callOutgoing(item, this.config.timeoutMs);
      if (input.direction === "incoming" && input.callerScope !== "all") {
        const classifications = await Promise.all(calls.map(call => call.from ? isTestCaller(call.from) : false));
        calls = calls.filter((_, index) => classifications[index] === (input.callerScope === "tests"));
      }
      calls = calls.slice(0, input.limitPerNode);
      return calls.flatMap(call => { const other = input.direction === "incoming" ? call.from : call.to; return other ? [{ item: other, reverse: input.direction === "incoming" }] : []; });
    });
  }
  async typeHierarchy(input: { target: SymbolTarget; direction: string; depth: number; limit: number; includeTotal: boolean; cursor?: string | undefined }): Promise<object> {
    const target = await this.resolveTarget(input.target); const roots = await this.client.prepareType(target.snapshot.uri, target.position, this.config.timeoutMs); const root = roots[0]; if (!root) return { root: {}, nodes: [], edges: [], ...(input.includeTotal && { total: 0 }) };
    return this.hierarchyResult(root, input, { tool: "typeHierarchy", ...queryOf(input) }, async item => {
      const [supertypes, subtypes] = await Promise.all([input.direction !== "subtypes" ? this.client.supertypes(item, this.config.timeoutMs) : [], input.direction !== "supertypes" ? this.client.subtypes(item, this.config.timeoutMs) : []]);
      return [...supertypes.map(other => ({ item: other, relation: "supertype" })), ...subtypes.map(other => ({ item: other, reverse: true, relation: "subtype" }))];
    });
  }
  async diagnostics(input: { scope: string; path?: string | undefined; paths?: string[] | undefined; minimumSeverity: string; waitForCurrentVersion: boolean; includeText: boolean; timeoutMs: number; limit: number; includeTotal: boolean; cursor?: string | undefined }, signal?: AbortSignal): Promise<object> {
    const deadline = operationalDeadline(input.timeoutMs);
    const requested = [...new Set(input.scope === "path" ? [input.path!] : input.scope === "paths" ? input.paths! : this.sync.snapshots.all().map(s => s.path))];
    const prepared: Array<{ snapshot: Snapshot; wasOpen: boolean }> = [];
    try {
      for (const path of requested) { const uri = pathToFileURL(this.paths.resolve(path)).href; const wasOpen = this.client.isDocumentOpen(uri); const snapshot = await this.sync.verify(path); prepared.push({ snapshot, wasOpen }); await this.prepare(); }
      const snapshots = prepared.map(item => item.snapshot); const requestedUris = new Set(snapshots.map(snapshot => snapshot.uri)); const entries: Array<{ uri: string; diagnostic: Diagnostic }> = [];
      const sets = await Promise.all(snapshots.map(async snap => ({ snap, set: input.waitForCurrentVersion ? await this.client.diagnostics.waitFor(snap.uri, snap.version, remaining(deadline), snap.syncedAt ?? snap.mtimeMs, signal) : this.client.diagnostics.get(snap.uri) })));
      const pendingPaths: string[] = [];
      for (const { snap, set } of sets) { if (!set) { pendingPaths.push(snap.path); continue; } for (const diagnostic of set.diagnostics) if (severityRank(diagnostic) <= severityNameRank(input.minimumSeverity)) entries.push({ uri: snap.uri, diagnostic }); }
      if (input.scope === "workspace") for (const set of this.client.diagnostics.all()) if (!requestedUris.has(set.uri)) for (const diagnostic of set.diagnostics) if (severityRank(diagnostic) <= severityNameRank(input.minimumSeverity)) entries.push({ uri: set.uri, diagnostic });
      return await this.diagnosticResult(entries, input.limit, input.cursor, pendingPaths, { tool: "diagnostics", ...queryOf(input) }, input.includeText, input.includeTotal);
    } finally { await Promise.all(prepared.filter(item => !item.wasOpen).map(item => this.client.closeDocument(item.snapshot))); }
  }
  async compile(input: { kind: string; minimumSeverity: string; includeText: boolean; timeoutMs: number; limit: number; includeTotal: boolean; cursor?: string | undefined }): Promise<object> {
    await this.prepare(); const query = { tool: "compile", ...queryOf(input) }; const key = fingerprint(query); let compilation = input.cursor ? this.compilations.get(key, this.sync.indexGeneration) : undefined;
    if (input.cursor && !compilation) throw new JavaLspMcpError("STALE_COMPILATION", "The paged compilation result expired or the workspace changed; compile again without a cursor");
    if (!compilation) {
      const start = Date.now(); const deadline = operationalDeadline(input.timeoutMs); const buildFailures: string[] = []; let buildStatus = -1, excludedRoots: string[] = []; this.successfulTestCompilations.clear(); const diagnosticsEpoch = this.client.diagnostics.currentEpoch();
      try { const build = await this.enqueueBuild(() => this.configuredBuild(input.kind === "clean", remaining(deadline))); buildStatus = build.status; excludedRoots = build.excludedRoots; } catch (error) { buildFailures.push(String(error)); }
      if (buildStatus === 2 && Date.now() < deadline) await this.client.diagnostics.settleAfter?.(diagnosticsEpoch, Math.min(2_000, remaining(deadline)));
      const entries = this.client.diagnostics.all().filter(set => !excludedRoots.some(root => fileUriWithin(set.uri, root))).flatMap(set => set.diagnostics.filter(d => severityRank(d) <= severityNameRank(input.minimumSeverity)).map(diagnostic => ({ uri: set.uri, diagnostic })));
      const status = buildStatusName(buildStatus); const success = status === "succeeded"; const diagnosticsComplete = status === "succeeded" || status === "with-errors" && entries.some(entry => entry.diagnostic.severity === 1);
      if (success) this.successfulTestCompilations.set("workspace", { generation: this.sync.indexGeneration, clean: input.kind === "clean" });
      const message = buildFailures.length ? buildFailures[0] : status === "with-errors" && !diagnosticsComplete ? "Compilation has errors, but JDT did not publish their diagnostic details; the build result is authoritative" : status === "failed" ? "JDT failed to execute the workspace build; check the server output" : status === "cancelled" ? "JDT cancelled the workspace build" : status === "unknown" ? `JDT returned an unknown workspace build status (${buildStatus})` : undefined;
      compilation = { status, durationMs: Date.now() - start, complete: buildFailures.length === 0 && status !== "cancelled", success, diagnosticsComplete, entries, ...(message && { message }), ...(buildFailures.length && { buildFailures }) }; this.compilations.set(key, compilation, this.sync.indexGeneration);
    }
    const result = await this.diagnosticResult(compilation.entries, input.limit, input.cursor, [], query, input.includeText, input.includeTotal) as Record<string, unknown>;
    return { kind: input.kind, buildStatus: compilation.status, ...(this.config.excludedProjects?.length && { excludedProjects: this.config.excludedProjects }), durationMs: compilation.durationMs, complete: compilation.complete, success: compilation.success, diagnosticsComplete: compilation.diagnosticsComplete, counts: result.counts, diagnostics: result.diagnostics, ...(typeof result.total === "number" && { total: result.total }), ...(typeof result.nextCursor === "string" && { nextCursor: result.nextCursor }), ...(compilation.message && { message: compilation.message }), ...(compilation.buildFailures && { buildFailures: compilation.buildFailures }) };
  }
  async runTests(input: TestInput, signal?: AbortSignal): Promise<object> {
    return this.calculateTestRun(input, signal);
  }
  async debugTestLaunches(input: TestInput, signal?: AbortSignal): Promise<JunitRunOptions[]> {
    if (!this.config.trustWorkspace) throw new JavaLspMcpError("UNTRUSTED_WORKSPACE", "Running tests executes workspace code", { hint: "Review the project, then restart java-lsp-mcp with --trust-workspace" });
    if (input.coverage) throw new JavaLspMcpError("DEBUG_COVERAGE_UNSUPPORTED", "Coverage is not supported for a suspended debug test launch; run the test normally with coverage after debugging");
    if (input.vmArgs.some(value => value.includes("jdwp") || value.includes("agentlib:jdwp"))) throw new JavaLspMcpError("DEBUG_VM_ARG_CONFLICT", "Do not pass JDWP arguments in vmArgs when debug=true; the server supplies suspend=y and a local ephemeral debug address");
    if (signal?.aborted) throw signal.reason ?? new Error("Request cancelled");
    const requested = input.tests ?? [{ path: input.path!, ...(input.className && { className: input.className }), ...(input.methodName && { methodName: input.methodName }) }];
    const prepared = await Promise.all(requested.map(async selector => ({ selector, snapshot: await this.prepareFile(selector.path) })));
    const configuredExclusions = this.excludedProjectRoots(); if (configuredExclusions.missing.length) throw new JavaLspMcpError("EXCLUDED_PROJECT_NOT_FOUND", `Excluded project not found in workspace: ${configuredExclusions.missing.join(", ")}`);
    if (prepared.some(item => configuredExclusions.roots.some(root => fileUriWithin(item.snapshot.uri, root)))) throw new JavaLspMcpError("TEST_PROJECT_EXCLUDED", "A selected test belongs to a project excluded at startup");
    const classifications = await Promise.all(prepared.map(item => this.client.isTestFile(item.snapshot.uri, input.timeoutMs))); const invalid = prepared.find((_, index) => !classifications[index]); if (invalid) throw new JavaLspMcpError("NOT_A_TEST_FILE", `JDT does not classify ${invalid.snapshot.path} as a test source`);
    if (input.compile !== "none") await this.ensureTestCompilation(input.compile === "clean", input.compileProjectOnly, prepared.map(item => item.snapshot.uri), input.timeoutMs);
    const launches = await Promise.all(prepared.map(async ({ selector, snapshot }) => {
      const className = selector.className ?? defaultTestClass(snapshot); validateTestSelector(className, selector.methodName); const classpath = await this.client.testClasspaths(snapshot.uri, input.timeoutMs); const additional = resolveTestClasspathEntries(this.config.testClasspathEntries ?? [], classpath.projectRoot, this.paths.root); const classpaths = [...new Set([...(classpath.classpaths ?? []), ...(classpath.modulepaths ?? []), ...additional])]; if (!classpaths.length) throw new JavaLspMcpError("TEST_CLASSPATH_EMPTY", `JDT returned no test runtime classpath for ${snapshot.path}`); const cwd = input.workingDirectory ? this.paths.resolve(input.workingDirectory) : nearestProjectDirectory(dirname(this.paths.resolve(snapshot.path)), this.paths.root); return { key: `${cwd}\0${classpaths.join("\0")}`, cwd, classpaths, selector: { className, ...(selector.methodName && { methodName: selector.methodName }), sourcePath: snapshot.path } };
    }));
    const groups = new Map<string, { cwd: string; classpaths: string[]; selectors: Array<{ className: string; methodName?: string | undefined; sourcePath: string }> }>();
    for (const launch of launches) { const group = groups.get(launch.key) ?? { cwd: launch.cwd, classpaths: launch.classpaths, selectors: [] }; if (!group.selectors.some(selector => selector.className === launch.selector.className && selector.methodName === launch.selector.methodName)) group.selectors.push(launch.selector); groups.set(launch.key, group); }
    const runtime = resolveTestRuntime(this.config);
    return [...groups.values()].map(group => ({ java: runtime.java, console: runtime.console, classpaths: group.classpaths, selectors: group.selectors, cwd: group.cwd, vmArgs: [...input.vmArgs, "-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:0"], systemProperties: input.systemProperties, timeoutMs: input.timeoutMs, includeOutput: false, includeStackTrace: false, outputLimit: Math.min(4_000, Math.max(1_024, Math.floor(this.config.resultBudget / Math.max(1, groups.size * 3)))) }));
  }
  private async calculateTestRun(input: TestInput, signal?: AbortSignal): Promise<object> {
    if (!this.config.trustWorkspace) throw new JavaLspMcpError("UNTRUSTED_WORKSPACE", "Running tests executes workspace code", { hint: "Review the project, then restart java-lsp-mcp with --trust-workspace" });
    if (signal?.aborted) throw signal.reason ?? new Error("Request cancelled");
    const requested = input.tests ?? [{ path: input.path!, ...(input.className && { className: input.className }), ...(input.methodName && { methodName: input.methodName }) }];
    const prepared = await Promise.all(requested.map(async selector => ({ selector, snapshot: await this.prepareFile(selector.path) })));
    const configuredExclusions = this.excludedProjectRoots(); if (configuredExclusions.missing.length) throw new JavaLspMcpError("EXCLUDED_PROJECT_NOT_FOUND", `Excluded project not found in workspace: ${configuredExclusions.missing.join(", ")}`); if (prepared.some(item => configuredExclusions.roots.some(root => fileUriWithin(item.snapshot.uri, root)))) throw new JavaLspMcpError("TEST_PROJECT_EXCLUDED", "A selected test belongs to a project excluded at startup");
    const query = { tool: "runTests", ...testQueryOf(input), hashes: prepared.map(item => [item.snapshot.path, item.snapshot.hash]) };
    const fp = fingerprint(query);
    let run: CachedTestRun;
    if (input.cursor || input.coverage?.cursor) {
      const cached = this.testRuns.get(fp, this.sync.indexGeneration);
      if (!cached) throw new JavaLspMcpError("STALE_TEST_RUN", "The paged test result expired or the workspace changed; rerun without a cursor");
      run = cached;
    } else {
      const classifications = await Promise.all(prepared.map(item => this.client.isTestFile(item.snapshot.uri, input.timeoutMs))); const invalid = prepared.find((_, index) => !classifications[index]);
      if (invalid) throw new JavaLspMcpError("NOT_A_TEST_FILE", `JDT does not classify ${invalid.snapshot.path} as a test source`);
      const started = Date.now();
      if (input.compile !== "none") {
        try { await this.ensureTestCompilation(input.compile === "clean", input.compileProjectOnly, prepared.map(item => item.snapshot.uri), input.timeoutMs); }
        catch (error) { return { status: "compile-failed", durationMs: Date.now() - started, counts: {}, failures: [], message: error instanceof Error ? error.message : String(error) }; }
      }
      if (signal?.aborted) throw signal.reason ?? new Error("Request cancelled");
      const coverageRuntime = input.coverage?.enabled ? resolveCoverageRuntime() : undefined;
      const launches = await Promise.all(prepared.map(async ({ selector, snapshot }) => {
        const className = selector.className ?? defaultTestClass(snapshot); validateTestSelector(className, selector.methodName);
        const classpath = await this.client.testClasspaths(snapshot.uri, input.timeoutMs); const additional = resolveTestClasspathEntries(this.config.testClasspathEntries ?? [], classpath.projectRoot, this.paths.root); const classpaths = [...new Set([...(classpath.classpaths ?? []), ...(classpath.modulepaths ?? []), ...additional])];
        if (!classpaths.length) throw new JavaLspMcpError("TEST_CLASSPATH_EMPTY", `JDT returned no test runtime classpath for ${snapshot.path}`);
        const cwd = input.workingDirectory ? this.paths.resolve(input.workingDirectory) : nearestProjectDirectory(dirname(this.paths.resolve(snapshot.path)), this.paths.root);
        return { key: `${cwd}\0${classpaths.join("\0")}`, cwd, classpaths, selector: { className, ...(selector.methodName && { methodName: selector.methodName }), sourcePath: snapshot.path } };
      }));
      const groups = new Map<string, { cwd: string; classpaths: string[]; selectors: Array<{ className: string; methodName?: string | undefined; sourcePath: string }> }>();
      for (const launch of launches) { const group = groups.get(launch.key) ?? { cwd: launch.cwd, classpaths: launch.classpaths, selectors: [] }; if (!group.selectors.some(selector => selector.className === launch.selector.className && selector.methodName === launch.selector.methodName)) group.selectors.push(launch.selector); groups.set(launch.key, group); }
      const runtime = resolveTestRuntime(this.config);
      const runs = await Promise.all([...groups.values()].map(group => runJUnit({ java: runtime.java, console: runtime.console, classpaths: group.classpaths, selectors: group.selectors, cwd: group.cwd, vmArgs: input.vmArgs, systemProperties: input.systemProperties, timeoutMs: input.timeoutMs, includeOutput: input.includeOutput, includeStackTrace: input.includeStackTrace, ...(coverageRuntime && { coverage: { agent: coverageRuntime.agent, includes: input.coverage?.includes ?? [] } }), ...(signal && { signal }), outputLimit: Math.min(4_000, Math.max(1_024, Math.floor(this.config.resultBudget / Math.max(1, groups.size * 3)))) })));
      const coverage = coverageRuntime ? await createCoverageReport({ java: runtime.java, cli: coverageRuntime.cli, executionData: runs.flatMap(item => item.coverageData ? [item.coverageData] : []), classpaths: launches.flatMap(item => item.classpaths), sourceFiles: workspaceJavaFiles(this.paths.root).filter(isProductionJavaPath), cwd: this.paths.root, timeoutMs: input.timeoutMs, ...(signal && { signal }) }) : undefined;
      run = { ...mergeJunitRuns(runs, Date.now() - started), ...(coverage && { coverage }) };
      this.testRuns.set(fp, run, this.sync.indexGeneration);
    }
    const page = input.coverage?.cursor && !input.cursor ? { items: [] } : this.paginate(run.failures, input.limit, input.cursor, query, failures => ({ failures, ...(!input.cursor && run.output && { output: run.output }) }));
    let coverage: object | undefined;
    if (input.coverage?.enabled && run.coverage) {
      const report = run.coverage; const coveragePage = input.coverage.details === "files" ? this.paginate(report.files, input.coverage.limit, input.coverage.cursor, { ...query, result: "coverage" }, files => ({ files })) : undefined;
      coverage = { complete: report.complete, ...(report.summary && { summary: report.summary }), ...(coveragePage && { files: coveragePage.items }), ...(input.coverage.includeTotal && { total: report.files.length }), ...(coveragePage?.nextCursor && { nextCursor: coveragePage.nextCursor }), ...(report.message && { message: report.message }) };
    }
    return { status: run.status, durationMs: run.durationMs, counts: run.counts, failures: page.items, ...(input.includeTotal && { total: run.failures.length }), ...(page.nextCursor && { nextCursor: page.nextCursor }), ...(run.message && { message: run.message }), ...(!input.cursor && !input.coverage?.cursor && run.output && { output: run.output }), ...(coverage && { coverage }) };
  }
  async affectedTests(input: AffectedTestsInput, signal?: AbortSignal): Promise<object> {
    return this.queueAnalysis(async () => {
      const target = await this.resolveTarget(input.target);
      const query = { tool: "affectedTests", ...queryOf(input), hash: target.snapshot.hash };
      const result = await this.cachedAnalysis(query, input.cursor, () => this.calculateAffectedTests(target, input, signal));
      const page = this.paginate(result.items, input.limit, input.cursor, query, tests => ({ tests }));
      return { tests: page.items, complete: result.complete, ...(input.includeTotal && { total: result.items.length }), ...(page.nextCursor && { nextCursor: page.nextCursor }), ...(result.message && { message: result.message }) };
    });
  }
  private async calculateAffectedTests(target: { snapshot: Snapshot; position: { line: number; character: number } }, input: AffectedTestsInput, signal?: AbortSignal): Promise<AnalysisResult> {
    const deadline = Date.now() + input.timeoutMs;
    let roots = await this.client.prepareCall(target.snapshot.uri, target.position, remaining(deadline)); let rootDepth = 0;
    if (!roots.length) {
      const references = await this.client.references(target.snapshot.uri, target.position, false, remaining(deadline));
      const recovered: HierarchyItem[] = [];
      for (const location of references.slice(0, 2_000)) {
        if (expired(deadline, signal)) break;
        const item = await this.enclosingCallItem(location, deadline);
        if (item) recovered.push(item);
      }
      roots = uniqueHierarchy(recovered); rootDepth = 1;
    }
    const queue = roots.map(item => ({ item, depth: rootDepth }));
    const visited = new Set<string>();
    const found = new Map<string, object>();
    let complete = true;
    const maxDepth = input.transitive ? input.maxDepth : 1;
    while (queue.length) {
      if (expired(deadline, signal)) { complete = false; break; }
      const current = queue.shift()!; const key = itemKey(current.item); if (visited.has(key)) continue; visited.add(key);
      if (visited.size > 5_000) { complete = false; break; }
      const test = await this.testIdentity(current.item, deadline);
      if (test) { found.set(`${String((test as { className: string }).className)}#${String((test as { methodName: string }).methodName)}`, test); continue; }
      if (current.depth >= maxDepth) continue;
      const calls = await this.client.callIncoming(current.item, remaining(deadline));
      for (const call of calls) if (call.from && this.paths.fromUri(call.from.uri).origin === "workspace") queue.push({ item: call.from, depth: current.depth + 1 });
    }
    return { items: [...found.values()].sort(compareLocation), complete, ...(!complete && { message: "Static traversal reached its timeout or 5,000-member safety limit; results are partial" }) };
  }
  async unusedCode(input: UnusedCodeInput, signal?: AbortSignal): Promise<object> {
    return this.queueAnalysis(async () => {
      await this.prepare();
      const query = { tool: "unusedCode", ...queryOf(input) };
      const result = await this.cachedAnalysis(query, input.cursor, () => this.calculateUnusedCode(input, signal));
      const page = this.paginate(result.items, input.limit, input.cursor, query, candidates => ({ candidates }));
      return { candidates: page.items, complete: result.complete, ...(input.includeTotal && { total: result.items.length }), ...(page.nextCursor && { nextCursor: page.nextCursor }), ...(result.message && { message: result.message }) };
    });
  }
  private async calculateUnusedCode(input: UnusedCodeInput, signal?: AbortSignal): Promise<AnalysisResult> {
    const deadline = Date.now() + input.timeoutMs;
    const files = input.path ? [input.path] : await workspaceJavaFiles(this.paths.root);
    const candidates: object[] = []; let complete = true;
    for (const path of files) {
      if (expired(deadline, signal)) { complete = false; break; }
      const uri = pathToFileURL(this.paths.resolve(path)).href; const wasOpen = this.client.isDocumentOpen(uri); let snapshot: Snapshot | undefined;
      try {
        snapshot = await this.sync.verify(path);
        const outline = await this.documentOutline(snapshot, remaining(deadline));
        const symbols = flattenSymbols(outline).filter(symbol => input.kinds.includes(kinds[symbol.kind] as "method" | "constructor" | "field") && declarationVisibility(snapshot!, symbol) === "private" && symbol.name !== "serialVersionUID");
        for (const symbol of symbols) {
          if (expired(deadline, signal)) { complete = false; break; }
          const kind = kinds[symbol.kind]!; const position = symbol.selectionRange.start;
          const references = await this.client.references(snapshot.uri, position, false, remaining(deadline));
          let reason: string | undefined = references.length ? undefined : "no-semantic-references";
          if (!reason && kind === "field" && input.includeWriteOnly) {
            const highlights = await this.client.documentHighlights(snapshot.uri, position, remaining(deadline));
            const uses = highlights.filter(item => !sameRange(item.range, symbol.selectionRange));
            if (uses.length && uses.every(item => item.kind === 3)) reason = "written-never-read";
          }
          if (reason) candidates.push({ kind, name: symbol.name, path: snapshot.path, startLine: symbol.range.start.line + 1, endLine: symbol.range.end.line + 1, reason });
        }
      } catch (error) { if (!snapshot) continue; throw error; }
      finally { if (snapshot && !wasOpen) await this.client.closeDocument(snapshot); }
      if (!complete) break;
    }
    return { items: candidates.sort(compareLocation), complete, ...(!complete && { message: "Analysis reached its timeout; candidates are partial and are not safe-to-delete conclusions" }) };
  }
  async codeActions(input: { path: string; range: { line: number; column: number; endLine: number; endColumn: number }; diagnosticCodes: (string | number)[]; kinds: string[]; limit: number; includeTotal: boolean; cursor?: string | undefined }): Promise<object> {
    const snap = await this.prepareFile(input.path); const r = toLspRange(snap, input.range); const diagnostics = (this.client.diagnostics.get(snap.uri)?.diagnostics ?? []).filter(d => !input.diagnosticCodes.length || input.diagnosticCodes.includes(d.code ?? "")); const raw = await this.client.codeActions(snap.uri, r, diagnostics, input.kinds, this.config.timeoutMs);
    const values = raw.map(action => compact({ id: this.actions.put(action, this.sync.indexGeneration), title: action.title, kind: action.kind, preferred: action.isPreferred || undefined, diagnosticCodes: action.diagnostics?.map(d => d.code).filter(v => v !== undefined) })); const query = { tool: "codeActions", ...queryOf(input), hash: snap.hash };
    const page = this.paginate(values, input.limit, input.cursor, query, actions => ({ actions })); return { actions: page.items, ...(input.includeTotal && { total: values.length }), ...(page.nextCursor && { nextCursor: page.nextCursor }) };
  }
  async editPreview(input: { operation: string; includeDiff: boolean; limit: number; includeTotal: boolean; cursor?: string | undefined; target?: SymbolTarget | undefined; newName?: string | undefined; id?: string | undefined; path?: string | undefined; range?: { line: number; column: number; endLine: number; endColumn: number } | undefined }): Promise<object> {
    return this.editQueue.run(() => this.calculateEdit(input));
  }
  private async calculateEdit(input: { operation: string; includeDiff: boolean; limit: number; includeTotal: boolean; cursor?: string | undefined; target?: SymbolTarget | undefined; newName?: string | undefined; id?: string | undefined; path?: string | undefined; range?: { line: number; column: number; endLine: number; endColumn: number } | undefined }): Promise<object> {
    let edit: WorkspaceEdit = {};
    if (input.operation === "rename") { const target = await this.resolveTarget(input.target!); edit = await this.client.rename(target.snapshot.uri, target.position, input.newName!, this.config.timeoutMs); }
    else if (input.operation === "codeAction") {
      await this.prepare();
      edit = await this.editFromAction(this.actions.take(input.id!, this.sync.indexGeneration));
    }
    else {
      const snap = await this.prepareFile(input.path!);
      if (input.operation === "organizeImports") {
        const source = lines(snap.content); const wholeFile = { start: { line: 0, character: 0 }, end: { line: source.length - 1, character: source.at(-1)!.length } };
        const actions = await this.client.codeActions(snap.uri, wholeFile, [], ["source.organizeImports"], this.config.timeoutMs); const action = actions.find(candidate => candidate.kind === "source.organizeImports");
        if (!action) throw new JavaLspMcpError("ACTION_NOT_AVAILABLE", "JDT did not offer an organize-imports action for this file");
        edit = await this.editFromAction(action);
      } else edit = { changes: { [snap.uri]: await this.client.format(snap.uri, input.range ? toLspRange(snap, input.range) : undefined, this.config.timeoutMs) } };
    }
    return this.normalizeEdit(edit, input);
  }
  private async editFromAction(candidate: CodeAction): Promise<WorkspaceEdit> {
    const action = candidate.data !== undefined && !candidate.edit && !candidate.command ? await this.client.resolveCodeAction(candidate, this.config.timeoutMs) : candidate;
    if (action.command) throw new JavaLspMcpError("ACTION_REQUIRES_APPLY", "This JDT action cannot be previewed without applying its command");
    if (!action.edit) throw new JavaLspMcpError("ACTION_HAS_NO_EDIT", "JDT did not return an edit for this code action");
    return action.edit;
  }
  private async normalizeEdit(edit: WorkspaceEdit, input: { operation: string; includeDiff: boolean; limit: number; includeTotal: boolean; cursor?: string | undefined }): Promise<object> {
    const changes = new Map<string, TextEdit[]>(); for (const [uri, edits] of Object.entries(edit.changes ?? {})) changes.set(uri, edits);
    for (const change of edit.documentChanges ?? []) {
      if (!("textDocument" in change)) throw new JavaLspMcpError("UNSUPPORTED_EDIT", `JDT proposed an unsupported ${change.kind} file operation`);
      changes.set(change.textDocument.uri, [...(changes.get(change.textDocument.uri) ?? []), ...change.edits]);
    }
    const files: object[] = []; const diffs = new Map<string, string>(); let editCount = 0;
    for (const [uri, edits] of changes) { const resolved = this.paths.fromUri(uri); if (!resolved.editable) throw new JavaLspMcpError("EXTERNAL_EDIT", `JDT proposed an edit outside the workspace: ${resolved.path}`); const absolute = this.paths.resolve(resolved.path); const before = await readFile(absolute, "utf8"); const baseHash = sha256(before); const sorted = validateAndSortEdits(before, edits); const again = await readFile(absolute, "utf8"); if (sha256(again) !== baseHash) throw new JavaLspMcpError("STALE_EDIT", `File changed while edit was calculated: ${resolved.path}`); files.push({ path: resolved.path, baseHash, edits: sorted.map(e => publicEdit(before, e)) }); editCount += sorted.length; if (input.includeDiff) diffs.set(resolved.path, unifiedDiff(resolved.path, before, sorted)); }
    const query = { tool: "editPreview", ...queryOf(input), files: files.map(file => (file as { path: string; baseHash: string }).path), hashes: files.map(file => (file as { path: string; baseHash: string }).baseHash) }; const page = this.paginate(files, input.limit, input.cursor, query, selected => ({ files: selected, editCount })); const diff = page.items.map(file => diffs.get((file as { path: string }).path)).filter(Boolean).join("\n");
    return { files: page.items, ...(input.includeTotal && { total: files.length }), editCount, ...(page.nextCursor && { nextCursor: page.nextCursor }), ...(input.includeDiff && diff && Buffer.byteLength(diff, "utf8") <= this.config.resultBudget && { unifiedDiff: diff }) };
  }
  private queueAnalysis(run: () => Promise<object>): Promise<object> {
    return this.analysisQueue.run(run);
  }
  private async cachedAnalysis(query: object, cursor: string | undefined, calculate: () => Promise<AnalysisResult>): Promise<AnalysisResult> {
    const key = fingerprint(query);
    if (cursor) {
      const cached = this.analyses.get(key, this.sync.indexGeneration);
      if (!cached) throw new JavaLspMcpError("STALE_ANALYSIS", "The paged analysis expired or the workspace changed; rerun without a cursor");
      return cached;
    }
    const result = await calculate();
    this.analyses.set(key, result, this.sync.indexGeneration);
    return result;
  }
  private async documentOutline(snapshot: Snapshot, timeoutMs: number): Promise<DocumentSymbol[]> {
    const deadline = Date.now() + timeoutMs;
    let raw = await this.client.extendedOutline(snapshot.uri, remaining(deadline));
    if (outlineNeedsReconcile(raw, snapshot.path, snapshot.content) && Date.now() < deadline) {
      await this.client.closeDocument(snapshot); await this.client.syncDocument(snapshot);
      raw = await this.client.extendedOutline(snapshot.uri, remaining(deadline));
    }
    let delay = 50;
    while (outlineNeedsReconcile(raw, snapshot.path, snapshot.content) && Date.now() < deadline) {
      await new Promise(resolveDelay => setTimeout(resolveDelay, Math.min(delay, Math.max(1, deadline - Date.now())))); delay = Math.min(delay * 2, 500);
      if (Date.now() < deadline) raw = await this.client.extendedOutline(snapshot.uri, remaining(deadline));
    }
    if (outlineNeedsReconcile(raw, snapshot.path, snapshot.content)) throw new JavaLspMcpError("JDT_INDEXING", "JDT LS has not finished reconciling the Java outline", { path: snapshot.path, version: snapshot.version });
    return raw;
  }
  private async enclosingCallItem(location: Location, deadline: number): Promise<HierarchyItem | undefined> {
    const resolved = this.paths.fromUri(location.uri); if (!resolved.editable) return undefined;
    const snapshot = await this.sync.verify(resolved.path); const outline = await this.documentOutline(snapshot, remaining(deadline));
    const symbol = smallestContainingSymbol(outline, location.range.start.line, new Set(["method", "constructor"]));
    if (!symbol) return undefined;
    return (await this.client.prepareCall(snapshot.uri, symbol.selectionRange.start, remaining(deadline)))[0];
  }
  private async testIdentity(item: HierarchyItem, deadline: number): Promise<object | undefined> {
    const resolved = this.paths.fromUri(item.uri); if (!resolved.editable) return undefined;
    const snapshot = await this.sync.verify(resolved.path); const outline = await this.documentOutline(snapshot, remaining(deadline));
    const match = symbolIdentity(outline, item.selectionRange.start.line, item.selectionRange.start.character);
    if (!match || !["method", "constructor"].includes(kinds[match.symbol.kind] ?? "")) return undefined;
    const declaration = sourceRange(snapshot.content, match.symbol.range.start.line, match.symbol.selectionRange.start.line, match.symbol.selectionRange.start.character);
    const classDeclaration = match.classes.length ? sourceRange(snapshot.content, match.classes.at(-1)!.range.start.line, match.classes.at(-1)!.selectionRange.start.line, match.classes.at(-1)!.selectionRange.start.character) : "";
    const methodName = match.symbol.name.replace(/\(.*$/u, "");
    const annotated = /@(?:[\w$.]+\.)?(?:Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate)\b/u.test(declaration) || /@(?:org\.testng\.annotations\.)?Test\b/u.test(classDeclaration);
    const junit3 = /^test[\p{L}\p{N}_$]*$/u.test(methodName) && /\bvoid\b/u.test(declaration) && /\bextends\s+(?:[\w$.]+\.)?TestCase\b/u.test(classDeclaration);
    if (!annotated && !junit3) return undefined;
    const packageName = /^\s*package\s+([\w.]+)\s*;/mu.exec(snapshot.content)?.[1]; const nested = match.classes.map(symbol => symbol.name.replace(/<.*$/u, "")).join("$");
    const className = packageName ? `${packageName}.${nested || basename(snapshot.path, ".java")}` : nested || basename(snapshot.path, ".java");
    const disabled = /@(?:[\w$.]+\.)?(?:Disabled|Ignore)\b/u.test(`${classDeclaration}\n${declaration}`);
    return { path: snapshot.path, className, methodName, line: match.symbol.selectionRange.start.line + 1, ...(disabled && { disabled: true }) };
  }
  private async diagnosticResult(entries: Array<{ uri: string; diagnostic: Diagnostic }>, limit: number, cursor: string | undefined, pendingPaths: string[], query: object, includeText: boolean, includeTotal: boolean): Promise<object> {
    const fp = fingerprint(query); const offset = cursor ? this.cursors.verify(cursor, fp, this.sync.indexGeneration) : 0; const page = entries.slice(offset, offset + limit); const counts = { error: 0, warning: 0, info: 0, hint: 0 };
    for (const { diagnostic } of entries) counts[(severities[diagnostic.severity ?? 3] ?? "info") as keyof typeof counts]++;
    const rows = await Promise.all(page.map(async ({ uri, diagnostic }) => { const location = await this.compactLocation({ uri, range: diagnostic.range }); const snap = this.sync.snapshots.get(location.path as string); return compact({ ...location, severity: severities[diagnostic.severity ?? 3] ?? "info", code: diagnostic.code, message: diagnostic.message, text: includeText && snap ? lines(snap.content)[diagnostic.range.start.line]?.trim().slice(0, 200) : undefined, tags: diagnostic.tags?.map(t => t === 1 ? "unnecessary" : "deprecated") }); }));
    const nonzeroCounts = Object.fromEntries(Object.entries(counts).filter(([, count]) => count > 0)); const status = pendingPaths.length ? "partial" : "final"; let selected = budgetItems(rows, Math.max(1024, this.config.resultBudget - 512), diagnostics => ({ status, diagnostics, counts: nonzeroCounts })).items; if (!selected.length && rows.length) selected = rows.slice(0, 1); const nextOffset = offset + selected.length;
    return { status, diagnostics: selected, counts: nonzeroCounts, ...(pendingPaths.length && { pendingPaths, message: "Current-version diagnostics were not published before the shared deadline; retry the pending paths shortly" }), ...(includeTotal && { total: entries.length }), ...(nextOffset < entries.length && { nextCursor: this.cursors.sign(fp, nextOffset, this.sync.indexGeneration) }) };
  }
  private async hierarchyResult(root: HierarchyItem, input: HierarchyInput, query: object, expand: (item: HierarchyItem) => Promise<HierarchyStep[]>): Promise<object> {
    const fp = fingerprint(query); const offset = input.cursor ? this.cursors.verify(input.cursor, fp, this.sync.indexGeneration) : 0; const wanted = input.includeTotal ? Number.POSITIVE_INFINITY : offset + input.limit + 1;
    const nodes = new Map<string, { id: string; data: object }>();
    const addNode = (item: HierarchyItem): string => { const key = itemKey(item); const found = nodes.get(key); if (found) return found.id; const id = `n${nodes.size}`; nodes.set(key, { id, data: this.hierarchyItem(item) }); return id; };
    const rootId = addNode(root); const edges: Array<{ from: string; to: string; relation?: string }> = []; let frontier = [root]; const expanded = new Set<string>();
    for (let depth = 0; depth < input.depth && frontier.length && edges.length < wanted; depth++) {
      const next: HierarchyItem[] = [];
      for (const item of frontier) {
        const key = itemKey(item); if (expanded.has(key)) continue; expanded.add(key);
        for (const step of await expand(item)) { const itemId = addNode(item), otherId = addNode(step.item); edges.push({ from: step.reverse ? otherId : itemId, to: step.reverse ? itemId : otherId, ...(step.relation && { relation: step.relation }) }); next.push(step.item); if (edges.length >= wanted) break; }
        if (edges.length >= wanted) break;
      }
      frontier = next;
    }
    const selected = edges.slice(offset, offset + input.limit); const ids = new Set(selected.flatMap(edge => [edge.from, edge.to])); const pageNodes = [...nodes.values()].filter(node => node.id !== rootId && ids.has(node.id)).map(node => ({ id: node.id, ...node.data })); const nextOffset = offset + selected.length;
    return { root: { id: rootId, ...this.hierarchyItem(root) }, nodes: pageNodes, edges: selected, ...(input.includeTotal && { total: edges.length }), ...(edges.length > nextOffset && { nextCursor: this.cursors.sign(fp, nextOffset, this.sync.indexGeneration) }) };
  }
  private async definitionResult(location: Location, input: { expand: ("context" | "body" | "members")[]; contextLines: number; maxSourceCharacters: number }): Promise<object> {
    const base = await this.compactLocation(location); const target = this.paths.fromUri(location.uri);
    if (!target.editable) return base;
    let snapshot: Snapshot;
    try { snapshot = await this.prepareFile(target.path); } catch { return base; }
    const symbols = await this.documentOutline(snapshot, this.config.timeoutMs); const match = symbolAtPosition(symbols, location.range.start.line, location.range.start.character);
    if (!match) return base;
    const symbol = match.symbol; const kind = kinds[symbol.kind] ?? `kind${symbol.kind}`; const expanded = new Set(input.expand);
    const declaration = { kind, name: symbol.name, declarationStartLine: symbol.range.start.line + 1, declarationEndLine: symbol.range.end.line + 1 };
    const body = expanded.has("body") ? sourceExcerpt(snapshot.content, symbol.range.start.line, symbol.range.end.line, input.maxSourceCharacters) : undefined;
    const context = expanded.has("context") ? sourceExcerpt(snapshot.content, symbol.range.start.line - input.contextLines, symbol.range.end.line + input.contextLines, input.maxSourceCharacters) : undefined;
    let members: object[] | undefined;
    if (expanded.has("members")) {
      const owner = [symbol, ...match.parents.toReversed()].find(item => ["class", "interface", "enum", "struct"].includes(kinds[item.kind] ?? ""));
      members = owner?.children?.filter(item => (kinds[item.kind] ?? "") !== "package").map(item => compact({ kind: kinds[item.kind] ?? `kind${item.kind}`, name: item.name, detail: item.detail, startLine: item.range.start.line + 1, endLine: item.range.end.line + 1 }));
    }
    return compact({ ...base, ...declaration, body, context, members });
  }
  private async referenceUsageKinds(target: { snapshot: Snapshot; position: { line: number; character: number } }, locations: Location[], wanted: ("call" | "read" | "write")[]): Promise<Map<string, "call" | "read" | "write">> {
    const result = new Map<string, "call" | "read" | "write">(); const requested = new Set(wanted);
    if (requested.has("call")) {
      const roots = await this.client.prepareCall(target.snapshot.uri, target.position, this.config.timeoutMs); const callSites: Location[] = [];
      for (const root of roots.slice(0, 1)) for (const edge of await this.client.callIncoming(root, this.config.timeoutMs)) if (edge.from) for (const range of edge.fromRanges ?? []) callSites.push({ uri: edge.from.uri, range });
      for (const location of locations) if (callSites.some(site => site.uri === location.uri && rangesOverlap(site.range, location.range))) result.set(locationKey(location), "call");
    }
    if (requested.has("read") || requested.has("write")) {
      const byUri = new Map<string, Location[]>();
      for (const location of locations) { const values = byUri.get(location.uri) ?? []; values.push(location); byUri.set(location.uri, values); }
      await Promise.all([...byUri.entries()].map(async ([uri, values]) => {
        const highlights = await this.client.documentHighlights(uri, values[0]!.range.start, this.config.timeoutMs);
        for (const location of values) { const highlight = highlights.find(item => rangesOverlap(item.range, location.range)); const kind = highlight?.kind === 3 ? "write" : highlight?.kind === 2 ? "read" : undefined; if (kind && requested.has(kind) && !result.has(locationKey(location))) result.set(locationKey(location), kind); }
      }));
    }
    return result;
  }
  private async ensureTestCompilation(clean: boolean, projectOnly: boolean, requiredUris: string[], timeoutMs: number): Promise<void> {
    const key = projectOnly ? await this.testProjectCompilationKey(requiredUris, timeoutMs) : "workspace"; const reusable = this.successfulTestCompilations.get(key) ?? (projectOnly ? this.successfulTestCompilations.get("workspace") : undefined);
    if (reusable?.generation === this.sync.indexGeneration && (!clean || reusable.clean)) return;
    const existing = this.pendingTestCompilations.get(key) ?? (projectOnly ? this.pendingTestCompilations.get("workspace") : undefined); if (existing) return existing;
    const pending = this.enqueueBuild(async () => {
      const build = await this.configuredBuild(clean, timeoutMs, requiredUris, projectOnly); const errors = this.client.diagnostics.all().filter(set => !build.excludedRoots.some(root => fileUriWithin(set.uri, root)) && (!build.builtRoots || build.builtRoots.some(root => fileUriWithin(set.uri, root)))).reduce((count, set) => count + set.diagnostics.filter(item => item.severity === 1).length, 0);
      if (build.status !== 1 || errors) throw new JavaLspMcpError("TEST_COMPILATION_FAILED", `JDT/ECJ compilation ${buildStatusName(build.status)}${errors ? ` with ${errors} error diagnostics` : ""}; call java_compile for paginated diagnostics`);
      this.successfulTestCompilations.set(key, { generation: this.sync.indexGeneration, clean });
    });
    this.pendingTestCompilations.set(key, pending); try { await pending; } finally { if (this.pendingTestCompilations.get(key) === pending) this.pendingTestCompilations.delete(key); }
  }
  private async testProjectCompilationKey(requiredUris: string[], timeoutMs: number): Promise<string> {
    const projects = await this.client.projects(timeoutMs); const roots = requiredUris.map(uri => projects.filter(root => fileUriWithin(uri, root)).sort((left, right) => right.length - left.length)[0]);
    if (roots.some(root => !root)) throw new JavaLspMcpError("TEST_PROJECT_NOT_FOUND", "JDT did not return an imported project containing every selected test");
    return `projects:${[...new Set(roots as string[])].sort().join("\0")}`;
  }
  private enqueueBuild<T>(work: () => Promise<T>): Promise<T> { return this.buildQueue.run(work); }
  private async configuredBuild(clean: boolean, timeoutMs: number, requiredUris: string[] = [], projectOnly = false): Promise<{ status: number; excludedRoots: string[]; builtRoots?: string[] }> {
    const selectors = [...new Set((this.config.excludedProjects ?? []).map(normalizeProjectSelector).filter(Boolean))];
    if (!selectors.length && !projectOnly) {
      const deadline = operationalDeadline(timeoutMs); const diagnosticsEpoch = this.client.diagnostics.currentEpoch?.() ?? 0; const status = await this.client.build(clean, remaining(deadline));
      if (status !== 2 || Date.now() >= deadline) return { status, excludedRoots: [] };
      await this.client.diagnostics.settleAfter?.(diagnosticsEpoch, Math.min(2_000, remaining(deadline)));
      if (!this.client.diagnostics.all().some(set => set.diagnostics.some(item => prerequisiteProjectName(item.message)))) return { status, excludedRoots: [] };
      const projects = await this.client.projects(remaining(deadline)); const recovery = await this.buildProjectsWithPrerequisites(projects, projects, clean, remaining(deadline));
      return { status: recovery.status, excludedRoots: [] };
    }
    const projects = await this.client.projects(timeoutMs); const matches = new Map(selectors.map(selector => [selector, false]));
    const importedExcludedRoots = projects.filter(uri => selectors.some(selector => { const matched = projectMatches(this.paths.root, uri, selector); if (matched) matches.set(selector, true); return matched; })); const filesystem = this.excludedProjectRoots(); for (const selector of selectors) if (!filesystem.missing.includes(selector)) matches.set(selector, true); const excludedRoots = [...new Set([...importedExcludedRoots, ...filesystem.roots])];
    const missing = [...matches].filter(([, matched]) => !matched).map(([selector]) => selector);
    if (missing.length) throw new JavaLspMcpError("EXCLUDED_PROJECT_NOT_FOUND", `Excluded project not found in JDT workspace: ${missing.join(", ")}`);
    if (requiredUris.some(requiredUri => excludedRoots.some(root => fileUriWithin(requiredUri, root)))) throw new JavaLspMcpError("TEST_PROJECT_EXCLUDED", "A selected test belongs to a project excluded from compilation");
    const included = projects.filter(uri => !excludedRoots.some(root => fileUriWithin(uri, root)));
    if (!included.length) throw new JavaLspMcpError("NO_INCLUDED_PROJECTS", "Every JDT project is excluded from compilation");
    const selected = projectOnly ? included.filter(root => requiredUris.some(uri => fileUriWithin(uri, root))) : included;
    if (!selected.length) throw new JavaLspMcpError("TEST_PROJECT_NOT_FOUND", "No included JDT project contains the selected tests");
    const build = await this.buildProjectsWithPrerequisites(selected, included, clean, timeoutMs);
    return { status: build.status, excludedRoots, ...(projectOnly && { builtRoots: build.builtRoots }) };
  }
  private async buildProjectsWithPrerequisites(selected: string[], eligible: string[], clean: boolean, timeoutMs: number): Promise<{ status: number; builtRoots: string[] }> {
    const deadline = operationalDeadline(timeoutMs); const builtRoots = new Set(selected); const visiting = new Set<string>(); const attempted = new Set<string>();
    const projectsByName = new Map<string, string[]>();
    for (const uri of eligible) { const name = projectUriName(uri); projectsByName.set(name, [...(projectsByName.get(name) ?? []), uri]); }
    const build = async (roots: string[]): Promise<number> => {
      const diagnosticsEpoch = this.client.diagnostics.currentEpoch?.() ?? 0; const status = await this.client.buildProjects(roots, clean, remaining(deadline));
      if (status !== 2 || Date.now() >= deadline) return status;
      await this.client.diagnostics.settleAfter?.(diagnosticsEpoch, Math.min(2_000, remaining(deadline)));
      let recovered = false;
      for (const root of roots) {
        const names = this.client.diagnostics.all().filter(set => fileUriWithin(set.uri, root)).flatMap(set => set.diagnostics.map(item => prerequisiteProjectName(item.message)).filter((name): name is string => Boolean(name)));
        for (const name of new Set(names)) {
          const matches = projectsByName.get(name) ?? []; const prerequisite = matches.length === 1 ? matches[0] : undefined; const edge = root + "\0" + (prerequisite ?? name);
          if (!prerequisite || visiting.has(prerequisite) || attempted.has(edge)) continue;
          attempted.add(edge); visiting.add(root); builtRoots.add(prerequisite);
          const prerequisiteStatus = await build([prerequisite]); visiting.delete(root);
          if (prerequisiteStatus !== 1) return prerequisiteStatus;
          recovered = true;
        }
      }
      return recovered ? build(roots) : status;
    };
    return { status: await build(selected), builtRoots: [...builtRoots] };
  }
  private excludedProjectRoots(): { roots: string[]; missing: string[] } { return this.excludedRootsCache ??= resolveExcludedProjectRoots(this.paths.root, this.config.excludedProjects ?? []); }
  private paginate<T>(values: T[], limit: number, cursor: string | undefined, query: object, envelope: (items: T[]) => object): { items: T[]; nextCursor?: string } {
    const fp = fingerprint(query); const offset = cursor ? this.cursors.verify(cursor, fp, this.sync.indexGeneration) : 0; const candidates = values.slice(offset, offset + limit); let selected = budgetItems(candidates, Math.max(1024, this.config.resultBudget - 512), envelope).items;
    if (!selected.length && candidates.length) selected = candidates.slice(0, 1);
    const nextOffset = offset + selected.length; return { items: selected, ...(nextOffset < values.length && { nextCursor: this.cursors.sign(fp, nextOffset, this.sync.indexGeneration) }) };
  }
  private async prepare(): Promise<void> { await this.sync.flush(); if (!await this.client.waitReady(this.config.timeoutMs)) throw new JavaLspMcpError("JDT_NOT_READY", `JDT LS did not become semantically ready within ${this.config.timeoutMs}ms`, { state: this.client.state, message: this.client.statusMessage, hint: "The same readiness gate is used by every Java tool; call java_status with waitForReady=true to observe it" }); }
  private async prepareFile(path: string): Promise<Snapshot> { const snap = await this.sync.verify(path); await this.prepare(); return snap; }
  private async resolveTarget(target: SymbolTarget): Promise<{ snapshot: Snapshot; position: { line: number; character: number } }> {
    if ("path" in target) { const snapshot = await this.prepareFile(target.path); return { snapshot, position: toLspPosition(snapshot, target) }; }
    const symbol = await this.resolveQualifiedSymbol(target.qualifiedName); const normalized = this.paths.fromUri(symbol.location.uri); if (!normalized.editable) throw new JavaLspMcpError("DEPENDENCY_TARGET", "Qualified dependency targets require a source position"); const snapshot = await this.prepareFile(normalized.path); return { snapshot, position: symbol.location.range.start };
  }
  private async resolveQualifiedSymbol(qualifiedName: string): Promise<SymbolInformation> {
    await this.prepare(); const base = qualifiedName.replace(/\(.*$/u, ""); const query = base.split(/[.#]/u).filter(Boolean).at(-1)!; const candidates = (await this.client.symbols(query, this.config.timeoutMs)).filter(symbol => qualifiedMatches(qualifiedName, symbol));
    const matches = [...new Map(candidates.map(symbol => [symbolLocationKey(symbol), symbol])).values()];
    if (!matches.length) throw new JavaLspMcpError("SYMBOL_NOT_FOUND", `Qualified symbol not found: ${qualifiedName}`);
    if (matches.length > 1) throw new JavaLspMcpError("AMBIGUOUS_SYMBOL", `Qualified symbol is ambiguous; use a source position: ${qualifiedName}`);
    return matches[0]!;
  }
  private async normalizeLocation(location: Location): Promise<Record<string, unknown>> { const target = this.paths.fromUri(location.uri); let snap = this.sync.snapshots.get(target.path); if (!snap && target.editable) try { snap = await this.sync.verify(target.path); } catch { /* raced deletion */ } return { ...publicLocation(this.paths, snap, location.uri, location.range) }; }
  private async compactLocation(location: Location): Promise<Record<string, unknown>> { const value = await this.normalizeLocation(location); return compact({ path: value.path, line: value.line, column: value.column, endLine: value.endLine, endColumn: value.endColumn, origin: value.origin === "dependency" ? "dependency" : undefined }); }
  private symbol(s: SymbolInformation): object { const target = this.paths.fromUri(s.location.uri); return compact({ name: s.name, kind: kinds[s.kind] ?? `kind${s.kind}`, container: s.containerName, path: target.path, line: s.location.range.start.line + 1, origin: target.origin === "dependency" ? "dependency" : undefined }); }
  private async symbolImplementation(symbol: SymbolInformation, base: object): Promise<object> {
    const kind = kinds[symbol.kind] ?? ""; const target = this.paths.fromUri(symbol.location.uri);
    if (!target.editable) return base;
    const snapshot = await this.sync.verify(target.path); const outline = await this.documentOutline(snapshot, this.config.timeoutMs);
    const located = symbolAtPosition(outline, symbol.location.range.start.line, symbol.location.range.start.character)?.symbol;
    const declaration = located && (kinds[located.kind] ?? "") === kind ? located : flattenSymbols(outline).find(item => (kinds[item.kind] ?? "") === kind && item.selectionRange.start.line === symbol.location.range.start.line && item.name.replace(/\(.*$/u, "") === symbol.name);
    const source = lines(snapshot.content); const range = declaration?.range ?? { start: { line: symbol.location.range.start.line, character: 0 }, end: { line: symbol.location.range.end.line, character: source[symbol.location.range.end.line]?.length ?? symbol.location.range.end.character } };
    const implementation = sourceRange(snapshot.content, range.start.line, range.end.line, range.end.character); const implementationLines = lines(implementation); const lineLimited = implementationLines.slice(0, 200).join("\n"); const lineTruncated = implementationLines.length > 200; const startLine = range.start.line + 1; const endLine = range.end.line + 1; const { line: _line, ...declarationBase } = base as Record<string, unknown>;
    const empty = { ...declarationBase, startLine, endLine, implementation: "" }; const allowance = Math.max(256, this.config.resultBudget - Buffer.byteLength(JSON.stringify({ symbols: [empty] }), "utf8") - 512); const selected = truncateUtf8(lineLimited, allowance);
    return { ...declarationBase, startLine, endLine, implementation: selected.text, ...((lineTruncated || selected.truncated) && { implementationTruncated: true }) };
  }
  private hierarchyItem(item: HierarchyItem): object { const target = this.paths.fromUri(item.uri); return compact({ name: item.name, kind: kinds[item.kind] ?? `kind${item.kind}`, detail: item.detail, path: target.path, startLine: item.range.start.line + 1, endLine: item.range.end.line + 1, origin: target.origin === "dependency" ? "dependency" : undefined }); }
}
function itemKey(item: HierarchyItem): string { return `${item.uri}:${item.range.start.line}:${item.range.start.character}:${item.name}`; }
function symbolLocationKey(symbol: SymbolInformation): string { const start = symbol.location.range.start; return `${symbol.location.uri}:${start.line}:${start.character}:${symbol.kind}`; }
function qualifiedMatches(q: string, s: SymbolInformation): boolean {
  const base = q.replace(/\(.*$/u, ""); const name = base.split(/[.#]/u).at(-1);
  if (!base.includes(".") && !base.includes("#")) return s.name === name;
  return `${s.containerName ?? ""}.${s.name}` === base.replace("#", ".");
}
function hoverText(value: unknown): string { if (!value || typeof value !== "object") return ""; const contents = (value as { contents?: unknown }).contents; if (typeof contents === "string") return contents; if (Array.isArray(contents)) return contents.map(hoverText).join("\n"); if (contents && typeof contents === "object" && "value" in contents) return String((contents as { value: unknown }).value); return ""; }
function severityRank(d: Diagnostic): number { return d.severity ?? 3; }
function severityNameRank(name: string): number { return Math.max(1, severities.indexOf(name as typeof severities[number])); }
function buildStatusName(status: number): "failed" | "succeeded" | "with-errors" | "cancelled" | "unknown" { return (["failed", "succeeded", "with-errors", "cancelled"] as const)[status] ?? "unknown"; }
function prerequisiteProjectName(message: string): string | undefined { return /^The project cannot be built until its prerequisite (.+) is built\.(?: |$)/u.exec(message)?.[1]?.trim(); }
function projectUriName(uri: string): string { try { return basename(fileURLToPath(uri)); } catch { return ""; } }
function jdtSymbolQuery(query: string, mode: string): string {
  if (mode === "prefix") return `${query}*`;
  if (mode === "fuzzy") return `*${[...query].join("*")}*`;
  return query;
}
export function symbolNameMatches(name: string, query: string, mode: string): boolean {
  if (mode === "exact") return name === query;
  if (mode === "prefix") return name.startsWith(query);
  if (mode === "fuzzy") return subsequenceMatches(name, query, false);
  return name.startsWith(query) || subsequenceMatches(name, query, true);
}
function subsequenceMatches(name: string, query: string, camelCase: boolean): boolean {
  const candidate = [...name]; let offset = 0;
  for (const wanted of query) {
    let found = false;
    for (; offset < candidate.length; offset++) {
      const actual = candidate[offset]!;
      if (camelCase && /\p{Lu}/u.test(wanted) && actual !== wanted) continue;
      if (actual.toLocaleLowerCase() !== wanted.toLocaleLowerCase()) continue;
      found = true; offset++; break;
    }
    if (!found) return false;
  }
  return !camelCase || !query || candidate[0]?.toLocaleLowerCase() === [...query][0]?.toLocaleLowerCase();
}
export function resolveTestClasspathEntries(entries: string[], projectRootUri: string | undefined, workspaceRoot: string): string[] {
  let projectRoot = workspaceRoot;
  if (projectRootUri) try { projectRoot = fileURLToPath(projectRootUri); } catch { throw new JavaLspMcpError("INVALID_TEST_PROJECT_ROOT", `JDT returned an invalid test project root: ${projectRootUri}`); }
  const resolved: string[] = [];
  for (const entry of entries) {
    if (!entry.trim() || entry.includes("\0")) throw new JavaLspMcpError("INVALID_TEST_CLASSPATH_ENTRY", "Test classpath entries must be non-empty filesystem paths");
    const path = resolve(projectRoot, entry); if (!existsSync(path)) throw new JavaLspMcpError("TEST_CLASSPATH_ENTRY_MISSING", `Additional test classpath entry does not exist: ${path}`);
    if (!resolved.some(existing => foldPath(existing) === foldPath(path))) resolved.push(path);
  }
  return resolved;
}
function compileNamePattern(pattern: string | undefined): RegExp | undefined { if (!pattern) return undefined; if (/\\[1-9]|\(\?<?[=!]|\([^)]*[*+]\)[*+{]/u.test(pattern)) throw new JavaLspMcpError("INVALID_PATTERN", "namePattern uses an unsafe regular-expression construct"); try { return new RegExp(pattern, "u"); } catch (error) { throw new JavaLspMcpError("INVALID_PATTERN", error instanceof Error ? error.message : String(error)); } }
function declarationVisibility(snapshot: Snapshot, symbol: DocumentSymbol): "public" | "protected" | "package" | "private" { const source = lines(snapshot.content); const fragments = source.slice(symbol.range.start.line, symbol.selectionRange.start.line + 1); if (fragments.length) fragments[fragments.length - 1] = fragments.at(-1)!.slice(0, symbol.selectionRange.start.character); const declaration = fragments.join("\n").replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/gu, " "); const matches = [...declaration.matchAll(/\b(public|protected|private)\b/gu)]; return (matches.at(-1)?.[1] as "public" | "protected" | "private" | undefined) ?? "package"; }
function toLspPosition(snapshot: Snapshot, position: Pick<PositionTarget, "line" | "column">): LspPosition {
  const line = lines(snapshot.content)[position.line - 1];
  if (line === undefined) throw new JavaLspMcpError("INVALID_POSITION", `Line ${position.line} is outside ${snapshot.path}`);
  try { return { line: position.line - 1, character: codePointToUtf16Column(line, position.column) }; }
  catch (error) { throw new JavaLspMcpError("INVALID_POSITION", error instanceof Error ? error.message : String(error)); }
}
function toLspRange(snapshot: Snapshot, range: { line: number; column: number; endLine: number; endColumn: number }): LspRange {
  return { start: toLspPosition(snapshot, range), end: toLspPosition(snapshot, { line: range.endLine, column: range.endColumn }) };
}
function defaultTestClass(snapshot: Snapshot): string {
  const packageName = /^\s*package\s+([\w.]+)\s*;/mu.exec(snapshot.content)?.[1];
  const simpleName = basename(snapshot.path, ".java");
  return packageName ? `${packageName}.${simpleName}` : simpleName;
}
function validateTestSelector(className: string, methodName: string | undefined): void {
  if (!/^(?:[\p{L}_$][\p{L}\p{N}_$]*\.)*[\p{L}_$][\p{L}\p{N}_$]*(?:\$[\p{L}_$][\p{L}\p{N}_$]*)*$/u.test(className)) throw new JavaLspMcpError("INVALID_TEST_SELECTOR", `Invalid Java test class name: ${className}`);
  if (methodName && /[\r\n\0]/u.test(methodName)) throw new JavaLspMcpError("INVALID_TEST_SELECTOR", "Test method selector contains invalid characters");
}
function nearestProjectDirectory(start: string, root: string): string {
  let current = start;
  for (;;) {
    if (["pom.xml", "build.gradle", "build.gradle.kts", ".project"].some(name => existsSync(resolve(current, name)))) return current;
    if (current === root) return root;
    const parent = dirname(current);
    if (parent === current || !pathWithin(parent, root)) return root;
    current = parent;
  }
}
function remaining(deadline: number): number { return Math.max(1, deadline - Date.now()); }
function operationalDeadline(timeoutMs: number): number { return Date.now() + Math.max(1, timeoutMs - Math.min(250, Math.floor(timeoutMs / 10))); }
function expired(deadline: number, signal?: AbortSignal): boolean { if (signal?.aborted) throw signal.reason ?? new Error("Request cancelled"); return Date.now() >= deadline; }
function uniqueWarnings(warnings: object[]): object[] { const values = new Map<string, object>(); for (const warning of warnings) values.set(JSON.stringify(warning), warning); return [...values.values()]; }
function searchResultKey(value: object): string { const item = value as Record<string, unknown>; return `${String(item.path)}\0${String(item.name)}\0${String(item.kind)}`; }
function uniqueHierarchy(items: HierarchyItem[]): HierarchyItem[] { const values = new Map<string, HierarchyItem>(); for (const item of items) values.set(itemKey(item), item); return [...values.values()]; }
function flattenSymbols(symbols: DocumentSymbol[]): DocumentSymbol[] { const values: DocumentSymbol[] = []; const visit = (symbol: DocumentSymbol): void => { values.push(symbol); for (const child of symbol.children ?? []) visit(child); }; for (const symbol of symbols) visit(symbol); return values; }
function symbolAtPosition(symbols: DocumentSymbol[], line: number, character: number): { symbol: DocumentSymbol; parents: DocumentSymbol[] } | undefined {
  const matches: Array<{ symbol: DocumentSymbol; parents: DocumentSymbol[] }> = [];
  const visit = (symbol: DocumentSymbol, parents: DocumentSymbol[]): void => { if (rangeContainsPosition(symbol.range, line, character)) matches.push({ symbol, parents }); for (const child of symbol.children ?? []) visit(child, [...parents, symbol]); };
  for (const symbol of symbols) visit(symbol, []);
  return matches.sort((left, right) => rangeSize(left.symbol.range) - rangeSize(right.symbol.range))[0];
}
function smallestContainingSymbol(symbols: DocumentSymbol[], line: number, wanted: Set<string>): DocumentSymbol | undefined {
  return flattenSymbols(symbols).filter(symbol => wanted.has(kinds[symbol.kind] ?? "") && symbol.range.start.line <= line && symbol.range.end.line >= line).sort((a, b) => (a.range.end.line - a.range.start.line) - (b.range.end.line - b.range.start.line))[0];
}
function symbolIdentity(symbols: DocumentSymbol[], line: number, character: number): { symbol: DocumentSymbol; classes: DocumentSymbol[] } | undefined {
  let exact: { symbol: DocumentSymbol; classes: DocumentSymbol[] } | undefined; let containing: { symbol: DocumentSymbol; classes: DocumentSymbol[] } | undefined;
  const visit = (symbol: DocumentSymbol, parents: DocumentSymbol[]): void => {
    const kind = kinds[symbol.kind] ?? ""; const classes = ["class", "interface", "enum", "struct"].includes(kind) ? [...parents, symbol] : parents;
    if (["method", "constructor"].includes(kind) && symbol.range.start.line <= line && symbol.range.end.line >= line) {
      const candidate = { symbol, classes: parents }; containing = candidate;
      if (symbol.selectionRange.start.line === line && symbol.selectionRange.start.character === character) exact = candidate;
    }
    for (const child of symbol.children ?? []) visit(child, classes);
  };
  for (const symbol of symbols) visit(symbol, []); return exact ?? containing;
}
function sourceRange(content: string, startLine: number, endLine: number, endCharacter: number): string { const source = lines(content); const selected = source.slice(startLine, endLine + 1); if (selected.length) selected[selected.length - 1] = selected.at(-1)!.slice(0, endCharacter); return selected.join("\n"); }
function mergeJunitRuns(runs: JunitRunResult[], durationMs: number): JunitRunResult {
  const rank: Record<JunitRunResult["status"], number> = { passed: 0, failed: 1, "timed-out": 2, error: 3 }; const status = runs.reduce<JunitRunResult["status"]>((current, run) => rank[run.status] > rank[current] ? run.status : current, "passed"); const counts: Record<string, number> = {};
  for (const run of runs) for (const [name, value] of Object.entries(run.counts)) counts[name] = (counts[name] ?? 0) + value;
  const stdout = runs.map(run => run.output?.stdout).filter(Boolean).join("\n"); const stderr = runs.map(run => run.output?.stderr).filter(Boolean).join("\n"); const messages = [...new Set(runs.map(run => run.message).filter((value): value is string => Boolean(value)))];
  const output = runs.some(run => run.output) ? compact({ stdout, stderr, truncated: runs.some(run => run.output?.truncated) || undefined }) as { stdout?: string; stderr?: string; truncated?: boolean } : undefined;
  return { status, durationMs, counts, failures: runs.flatMap(run => run.failures), ...(messages.length && { message: messages.join("; ") }), ...(output && { output }) };
}
function comparePosition(left: LspPosition, right: LspPosition): number { return left.line - right.line || left.character - right.character; }
function sameRange(left: LspRange, right: LspRange): boolean { return comparePosition(left.start, right.start) === 0 && comparePosition(left.end, right.end) === 0; }
function rangeContainsPosition(range: LspRange, line: number, character: number): boolean { const position = { line, character }; return comparePosition(range.start, position) <= 0 && comparePosition(position, range.end) < 0; }
function rangeContainsRange(outer: LspRange, inner: LspRange): boolean { return comparePosition(outer.start, inner.start) <= 0 && comparePosition(inner.end, outer.end) <= 0; }
function rangesOverlap(left: LspRange, right: LspRange): boolean { return comparePosition(left.start, right.end) < 0 && comparePosition(right.start, left.end) < 0; }
function rangeSize(range: LspRange): number { return (range.end.line - range.start.line) * 1_000_000 + range.end.character - range.start.character; }
function rangeKey(range: LspRange): string { return `${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}`; }
function locationKey(location: Location): string { return `${location.uri}:${rangeKey(location.range)}`; }
function sourceExcerpt(content: string, requestedStart: number, requestedEnd: number, maxCharacters: number): object {
  const source = lines(content); const start = Math.max(0, requestedStart); const end = Math.min(source.length - 1, requestedEnd); const full = source.slice(start, end + 1).join("\n"); const truncated = full.length > maxCharacters;
  return { startLine: start + 1, endLine: end + 1, text: truncated ? full.slice(0, maxCharacters) : full, ...(truncated && { truncated: true }) };
}
function compareLocation(left: object, right: object): number { const a = left as { path?: string; line?: number; startLine?: number }; const b = right as { path?: string; line?: number; startLine?: number }; return String(a.path).localeCompare(String(b.path)) || (a.line ?? a.startLine ?? 0) - (b.line ?? b.startLine ?? 0); }
function queryOf<T extends { cursor?: string | undefined; limit: number; includeTotal: boolean }>(input: T): Omit<T, "cursor" | "limit" | "includeTotal"> { const { cursor: _cursor, limit: _limit, includeTotal: _includeTotal, ...query } = input; return query; }
function testQueryOf(input: TestInput): object { const base = queryOf(input); if (!base.coverage) return base; const { cursor: _cursor, limit: _limit, includeTotal: _includeTotal, ...coverage } = base.coverage; return { ...base, coverage }; }
function workspaceJavaFiles(root: string): string[] {
  return workspaceFiles(root, name => name.endsWith(".java")).map(path => relative(root, path).split(sep).join("/")).sort();
}
function isProductionJavaPath(path: string): boolean { const normalized = `/${path.toLowerCase()}/`; return !normalized.includes("/src/test/") && !normalized.includes("/src/integrationtest/") && !normalized.includes("/src/integration-test/"); }

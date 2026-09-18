import type { MessageConnection } from "vscode-jsonrpc/node.js";
import type { Logger } from "../logging.js";
import type { Config } from "../config/config.js";
import type { Snapshot } from "../types.js";
import { DiagnosticStore } from "./diagnostics.js";
import type { CallEdge, CodeAction, Diagnostic, DocumentHighlight, DocumentSymbol, HierarchyItem, Location, SymbolInformation, TextEdit, TypeEdge, WorkspaceEdit } from "./protocol.js";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { projectConfigurationUris } from "../workspace/projects.js";
import { pathWithin } from "../workspace/paths.js";
import { jdkExecutionEnvironment } from "../runtime/resolver.js";

export type JdtState = "starting" | "importing" | "building" | "indexing" | "busy" | "ready" | "degraded" | "failed";

export class LspClient {
  readonly diagnostics = new DiagnosticStore();
  state: JdtState = "starting";
  statusMessage = "Not started";
  serverVersion = "unknown";
  private readonly opened = new Set<string>();
  private serviceReady = false;
  private serviceReadyAt = 0;
  private semanticReady = false;
  private semanticProbe: Promise<void> | undefined;
  private readonly progress = new Map<string, string>();
  constructor(private connection: MessageConnection | undefined, private readonly config: Config, private readonly logger: Logger) {}
  attach(connection: MessageConnection): void { this.connection = connection; this.opened.clear(); this.diagnostics.clear(); this.serviceReady = false; this.serviceReadyAt = 0; this.semanticReady = false; this.semanticProbe = undefined; this.progress.clear(); this.state = "starting"; this.registerHandlers(); }
  private registerHandlers(): void {
    const c = this.requireConnection();
    c.onRequest("workspace/configuration", (params: { items?: { section?: string }[] }) => { const settings = this.settings(); return (params.items ?? []).map(item => item.section ? configurationValue(settings, item.section) : settings); });
    c.onRequest("client/registerCapability", () => null);
    c.onRequest("client/unregisterCapability", () => null);
    c.onRequest("window/workDoneProgress/create", () => null);
    c.onRequest("window/showMessageRequest", () => null);
    c.onRequest("workspace/applyEdit", () => ({ applied: false, failureReason: "java-lsp-mcp only returns edit previews" }));
    c.onNotification("textDocument/publishDiagnostics", (p: { uri: string; version?: number; diagnostics: Diagnostic[] }) => this.diagnostics.publish(p.uri, p.diagnostics, p.version));
    c.onNotification("language/status", (p: { type?: string; message?: string }) => {
      this.statusMessage = p.message ?? p.type ?? "";
      const type = p.type?.toLowerCase();
      if (type === "serviceready") { this.serviceReady = true; this.serviceReadyAt = Date.now(); this.updatePendingState(); }
      else if (type === "starting" || type === "started") this.state = "starting";
      else if (type === "error") this.state = "degraded";
    });
    c.onNotification("language/progressReport", (p: { id?: string; task?: string; subTask?: string; status?: string; complete?: boolean }) => { this.trackProgress(p.id, p.task ?? p.subTask ?? p.status, Boolean(p.complete)); this.logger.debug("JDT progress", p); });
    c.onNotification("$/progress", (p: { token?: string | number; value?: { kind?: string; title?: string; message?: string } }) => { const value = p.value; this.trackProgress(String(p.token ?? "standard"), value?.title ?? value?.message, value?.kind === "end"); this.logger.debug("JDT progress", p); });
    c.onNotification("window/logMessage", (p: unknown) => this.logger.debug("JDT", p));
    c.onNotification("window/showMessage", (p: unknown) => this.logger.info("JDT message", p));
  }
  async initialize(rootUri: string, processId: number, timeoutMs: number): Promise<void> {
    const projectConfigurations = projectConfigurationUris(this.config.workspace, this.config.excludedProjects ?? []);
    const result = await this.request<{ serverInfo?: { version?: string } }>("initialize", {
      processId, rootUri, workspaceFolders: [{ uri: rootUri, name: "workspace" }],
      initializationOptions: { settings: this.settings(), bundles: [], ...(projectConfigurations && { projectConfigurations }), extendedClientCapabilities: { progressReportProvider: true, actionableRuntimeNotificationSupport: false, moveRefactoringSupport: false, advancedOrganizeImportsSupport: false, generateToStringPromptSupport: false } },
      capabilities: {
        workspace: { applyEdit: false, configuration: true, didChangeWatchedFiles: { dynamicRegistration: true }, symbol: { dynamicRegistration: false }, workspaceEdit: { documentChanges: true } },
        textDocument: { synchronization: { didSave: true }, documentSymbol: { hierarchicalDocumentSymbolSupport: true }, documentHighlight: {}, definition: {}, references: {}, hover: { contentFormat: ["markdown", "plaintext"] }, rename: { prepareSupport: true }, codeAction: { dataSupport: true, resolveSupport: { properties: ["edit", "command"] }, codeActionLiteralSupport: { codeActionKind: { valueSet: ["quickfix", "refactor", "source.organizeImports"] } } }, callHierarchy: {}, typeHierarchy: {}, formatting: {}, rangeFormatting: {} },
        window: { workDoneProgress: true },
      },
    }, timeoutMs);
    this.serverVersion = result.serverInfo?.version ?? "unknown";
    this.requireConnection().sendNotification("initialized", {});
    this.requireConnection().sendNotification("workspace/didChangeConfiguration", { settings: this.settings() });
    this.state = "indexing";
  }
  private settings(): object {
    return { java: {
      jdt: { ls: { javac: { enabled: "off" } } }, completion: { engine: "ecj" },
      symbols: { includeSourceMethodDeclarations: true },
      autobuild: { enabled: false }, configuration: { updateBuildConfiguration: this.config.trustWorkspace ? "automatic" : "disabled", ...(this.config.projectJdk && { runtimes: [{ name: jdkExecutionEnvironment(this.config.projectJdk), path: this.config.projectJdk, default: true }] }) },
      import: { exclusions: jdtImportExclusions(this.config.workspace, this.config.excludedProjects ?? []), maven: { enabled: this.config.trustWorkspace, offline: { enabled: this.config.offline } }, gradle: { enabled: this.config.trustWorkspace, offline: { enabled: this.config.offline }, wrapper: { enabled: this.config.trustWorkspace } }, generatesMetadataFilesAtProjectRoot: false },
    } };
  }
  async waitReady(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const current = this.readiness();
      if (current !== undefined) return current;
      if (this.serviceReady && this.progress.size === 0 && Date.now() - this.serviceReadyAt >= 250) {
        this.startSemanticProbe();
        const remaining = Math.max(1, deadline - Date.now());
        await Promise.race([this.semanticProbe, new Promise(resolve => setTimeout(resolve, Math.min(50, remaining)))]).catch(() => {});
      } else await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))));
    }
    return this.readiness() ?? false;
  }
  private readiness(): boolean | undefined { return this.state === "degraded" || this.state === "failed" ? false : this.state === "ready" || this.semanticReady ? true : undefined; }
  get ready(): boolean { return this.state !== "degraded" && this.state !== "failed" && (this.semanticReady || this.state === "ready" || this.state === "busy"); }
  get activity(): string | undefined { return [...this.progress.values()].at(-1); }
  private startSemanticProbe(): void {
    if (this.semanticReady || this.semanticProbe) return;
    this.state = "indexing"; this.statusMessage = "Waiting for JDT semantic index";
    this.semanticProbe = (this.requireConnection().sendRequest("workspace/symbol", { query: "__java_lsp_mcp_readiness_probe__" }) as Promise<unknown>).then(() => { this.semanticReady = true; this.state = "ready"; this.statusMessage = "Ready"; }).catch(error => { this.state = "degraded"; this.statusMessage = `Semantic readiness probe failed: ${error instanceof Error ? error.message : String(error)}`; throw error; });
  }
  private trackProgress(id: string | undefined, task: string | undefined, complete: boolean): void {
    const key = id ?? task ?? "jdt";
    if (complete) this.progress.delete(key); else this.progress.set(key, task ?? "Indexing");
    this.updatePendingState();
  }
  private updatePendingState(): void {
    const tasks = [...this.progress.values()]; const task = tasks.at(-1);
    if (this.semanticReady && tasks.length) this.state = "busy";
    else if (tasks.some(value => /import|configur|maven|gradle/iu.test(value))) this.state = "importing";
    else if (tasks.some(value => /build|compil|validat/iu.test(value))) this.state = "building";
    else this.state = this.semanticReady ? "ready" : this.serviceReady ? "indexing" : "starting";
    if (task) this.statusMessage = task;
    else if (this.semanticReady) this.statusMessage = "Ready";
    else if (this.serviceReady) this.statusMessage = "Waiting for JDT semantic index";
  }
  async syncDocument(snapshot: Snapshot, old?: Snapshot): Promise<void> {
    const c = this.requireConnection();
    if (!this.opened.has(snapshot.uri)) { snapshot.syncedAt = Date.now(); c.sendNotification("textDocument/didOpen", { textDocument: { uri: snapshot.uri, languageId: "java", version: snapshot.version, text: snapshot.content } }); this.opened.add(snapshot.uri); }
    else if (!old || old.hash !== snapshot.hash) { snapshot.syncedAt = Date.now(); c.sendNotification("textDocument/didChange", { textDocument: { uri: snapshot.uri, version: snapshot.version }, contentChanges: [{ text: snapshot.content }] }); }
  }
  isDocumentOpen(uri: string): boolean { return this.opened.has(uri); }
  async closeDocument(snapshot: Snapshot): Promise<void> { if (this.opened.delete(snapshot.uri)) this.requireConnection().sendNotification("textDocument/didClose", { textDocument: { uri: snapshot.uri } }); }
  async watchedFile(path: string, type: 1 | 2 | 3): Promise<void> { this.requireConnection().sendNotification("workspace/didChangeWatchedFiles", { changes: [{ uri: pathToFileURL(resolve(this.config.workspace, path)).href, type }] }); }
  async refreshProjects(): Promise<void> {
    if (!this.config.trustWorkspace) return;
    this.semanticReady = false; this.semanticProbe = undefined; this.state = "importing"; this.statusMessage = "Refreshing Java projects";
    try { await this.request("workspace/executeCommand", { command: "java.project.import", arguments: [] }, this.config.timeoutMs); }
    catch (error) { this.state = "degraded"; this.statusMessage = `Project refresh failed: ${error instanceof Error ? error.message : String(error)}`; this.logger.warn("Project refresh failed", String(error)); }
  }
  extendedOutline(uri: string, timeout: number): Promise<DocumentSymbol[]> { return this.request("java/extendedDocumentSymbol", { textDocument: { uri } }, timeout); }
  symbols(query: string, timeout: number): Promise<SymbolInformation[]> { return this.request("workspace/symbol", { query }, timeout); }
  definition(uri: string, position: object, timeout: number): Promise<Location | Location[] | null> { return this.request("textDocument/definition", { textDocument: { uri }, position }, timeout); }
  references(uri: string, position: object, includeDeclaration: boolean, timeout: number): Promise<Location[]> { return this.request("textDocument/references", { textDocument: { uri }, position, context: { includeDeclaration } }, timeout); }
  documentHighlights(uri: string, position: object, timeout: number): Promise<DocumentHighlight[]> { return this.request("textDocument/documentHighlight", { textDocument: { uri }, position }, timeout); }
  hover(uri: string, position: object, timeout: number): Promise<unknown> { return this.request("textDocument/hover", { textDocument: { uri }, position }, timeout); }
  prepareCall(uri: string, position: object, timeout: number): Promise<HierarchyItem[]> { return this.request("textDocument/prepareCallHierarchy", { textDocument: { uri }, position }, timeout); }
  callIncoming(item: HierarchyItem, timeout: number): Promise<CallEdge[]> { return this.request("callHierarchy/incomingCalls", { item }, timeout); }
  callOutgoing(item: HierarchyItem, timeout: number): Promise<CallEdge[]> { return this.request("callHierarchy/outgoingCalls", { item }, timeout); }
  prepareType(uri: string, position: object, timeout: number): Promise<HierarchyItem[]> { return this.request("textDocument/prepareTypeHierarchy", { textDocument: { uri }, position }, timeout); }
  supertypes(item: HierarchyItem, timeout: number): Promise<TypeEdge[]> { return this.request("typeHierarchy/supertypes", { item }, timeout); }
  subtypes(item: HierarchyItem, timeout: number): Promise<TypeEdge[]> { return this.request("typeHierarchy/subtypes", { item }, timeout); }
  codeActions(uri: string, range: object, diagnostics: Diagnostic[], only: string[] | undefined, timeout: number): Promise<CodeAction[]> { return this.request("textDocument/codeAction", { textDocument: { uri }, range, context: { diagnostics, ...(only && { only }) } }, timeout); }
  resolveCodeAction(action: CodeAction, timeout: number): Promise<CodeAction> { return this.request("codeAction/resolve", action, timeout); }
  rename(uri: string, position: object, newName: string, timeout: number): Promise<WorkspaceEdit> { return this.request("textDocument/rename", { textDocument: { uri }, position, newName }, timeout); }
  format(uri: string, range: object | undefined, timeout: number): Promise<TextEdit[]> { return this.request(range ? "textDocument/rangeFormatting" : "textDocument/formatting", { textDocument: { uri }, ...(range && { range }), options: { tabSize: 4, insertSpaces: true } }, timeout); }
  isTestFile(uri: string, timeout: number): Promise<boolean> { return this.request("workspace/executeCommand", { command: "java.project.isTestFile", arguments: [uri] }, timeout); }
  updateProjectConfiguration(uri: string, timeout: number): Promise<void> { return this.request("workspace/executeCommand", { command: "java.projectConfiguration.update", arguments: [uri] }, timeout); }
  importProjects(timeout: number): Promise<void> { return this.request("workspace/executeCommand", { command: "java.project.import", arguments: [] }, timeout); }
  testClasspaths(uri: string, timeout: number): Promise<{ projectRoot?: string; classpaths?: string[]; modulepaths?: string[] }> { return this.request("workspace/executeCommand", { command: "java.project.getClasspaths", arguments: [uri, JSON.stringify({ scope: "test" })] }, timeout); }
  build(clean: boolean, timeout: number): Promise<number> { return this.request("java/buildWorkspace", clean, timeout); }
  projects(timeout: number): Promise<string[]> { return this.request("workspace/executeCommand", { command: "java.project.getAll", arguments: [] }, timeout); }
  buildProjects(uris: string[], clean: boolean, timeout: number): Promise<number> { return this.request("java/buildProjects", { identifiers: uris.map(uri => ({ uri })), isFullBuild: clean }, timeout); }
  async shutdown(): Promise<void> { if (!this.connection) return; try { await this.request("shutdown", null, 5_000); this.connection.sendNotification("exit"); } catch { /* child exit */ } finally { this.connection.dispose(); this.connection = undefined; } }
  private request<T = unknown>(method: string, params: unknown, timeout: number): Promise<T> {
    const c = this.requireConnection();
    const pending = c.sendRequest(method, params) as Promise<T>;
    return new Promise<T>((resolve, reject) => {
      const boundedTimeout = timeout > 500 ? timeout - 250 : timeout;
      const timer = setTimeout(() => reject(new Error(`${method} timed out after ${boundedTimeout}ms`)), boundedTimeout);
      timer.unref();
      pending.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
    });
  }
  private requireConnection(): MessageConnection { if (!this.connection) throw new Error("JDT LS is not running"); return this.connection; }
}

function configurationValue(settings: object, section: string): unknown { return section.split(".").reduce<unknown>((value, key) => value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined, settings); }

export function jdtImportExclusions(workspace: string, selectors: string[]): string[] {
  return [...new Set(selectors.map(selector => {
    let value = selector.trim().replaceAll("\\", "/").replace(/\/$/u, "");
    if (isAbsolute(selector) && pathWithin(selector, workspace)) value = relative(resolve(workspace), resolve(selector)).split(sep).join("/");
    value = value.replace(/^\.\//u, "").replace(/^\/+|\/+$/gu, ""); return value && value !== "." ? `**/${value}/**` : "**";
  }).filter(Boolean))];
}

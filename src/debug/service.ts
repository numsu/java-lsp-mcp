import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Config } from "../config/config.js";
import type { Logger } from "../logging.js";
import { JavaLspMcpError } from "../types.js";
import type { JavaService, TestInput } from "../mcp/service.js";
import { DebugBridgeClient } from "./bridge-client.js";
import { launchJUnit } from "../testing/junit.js";

export class DebugService {
  private readonly bridge: DebugBridgeClient;
  constructor(private readonly config: Config, logger: Logger, private readonly java: JavaService) { this.bridge = new DebugBridgeClient(config, logger); }
  targets(input: { query?: string | undefined; includeUnavailable: boolean }): Promise<object> { return this.bridge.request("targets", [input.query, input.includeUnavailable]); }
  attach(input: { targetId: string; timeoutMs: number }): Promise<object> { return this.bridge.request("attach", [input.targetId, input.timeoutMs], input.timeoutMs + 2_000); }
  sessions(): Promise<object> { return this.bridge.request("sessions"); }
  setBreakpoints(input: { sessionId: string; sourcePath: string; breakpoints: Array<{ line: number }>; timeoutMs: number }): Promise<object> { return this.bridge.request("breakpoints", [input.sessionId, workspacePath(this.config.workspace, input.sourcePath), input.breakpoints.map(v => v.line).join(","), input.timeoutMs], input.timeoutMs + 2_000); }
  threads(input: { sessionId: string; includeSystemThreads: boolean; packagePrefix?: string | undefined; namePattern?: string | undefined }): Promise<object> { return this.bridge.request("threads", [input.sessionId, input.includeSystemThreads, input.packagePrefix, input.namePattern]); }
  wait(input: { sessionId: string; timeoutMs: number }): Promise<object> { return this.bridge.request("wait", [input.sessionId, input.timeoutMs], input.timeoutMs + 2_000); }
  stack(input: { sessionId: string; stopId: string; threadId: number; startFrame: number; maxFrames: number; packagePrefix?: string | undefined; includeInfrastructure: boolean }): Promise<object> { return this.bridge.request("stack", [input.sessionId, input.stopId, input.threadId, input.startFrame, input.maxFrames, input.packagePrefix, input.includeInfrastructure]); }
  variables(input: { sessionId: string; stopId: string; frameId?: string | undefined; valueId?: string | undefined; scope?: string | undefined; start: number; limit: number; inlineFields: boolean; maxInlineFields: number; includeGetters: boolean }): Promise<object> { return this.bridge.request("variables", [input.sessionId, input.stopId, input.frameId, input.valueId, input.scope, input.start, input.limit, input.inlineFields, input.maxInlineFields, input.includeGetters]); }
  execute(input: { sessionId: string; action: string; threadId?: number | undefined; stopId?: string | undefined; waitTimeoutMs: number }): Promise<object> { return this.bridge.request("execute", [input.sessionId, input.action, input.threadId, input.stopId, input.waitTimeoutMs], input.waitTimeoutMs + 2_000); }
  detach(input: { sessionId: string }): Promise<object> { return this.bridge.request("detach", [input.sessionId]); }
  async runTests(input: TestInput, signal: AbortSignal): Promise<object> {
    if (input.debug !== true) throw new JavaLspMcpError("INVALID_STATE", "Debug test launch requires debug=true");
    const launches = await this.java.debugTestLaunches(input, signal);
    const sessions: Array<{ sessionId: string; targetId: string; pid: number; selectors: string[]; activeThreadId?: number; stopId?: string; attachRequired: boolean }> = [];
    const children: Array<{ kill(): boolean }> = [];
    try {
      for (const options of launches) {
        if (signal.aborted) throw signal.reason;
        const launch = await launchJUnit(options);
        children.push(launch.child);
        const targetId = `local:${launch.pid}`;
        const deadline = Date.now() + Math.min(60_000, input.timeoutMs);
        let attached: Record<string, unknown> | undefined;
        let lastError: unknown;
        while (!attached && Date.now() < deadline) {
          try { attached = await this.bridge.request("attach", [targetId, Math.max(250, Math.min(2_000, deadline - Date.now()))], 3_000); }
          catch (error) { lastError = error; await new Promise(resolvePromise => setTimeout(resolvePromise, 100)); }
        }
        if (!attached) throw lastError instanceof Error ? lastError : new JavaLspMcpError("ATTACH_TIMEOUT", `Could not attach to debug test JVM ${launch.pid}`);
        const session = attached.session as Record<string, unknown>;
        sessions.push({ sessionId: String(session.sessionId), targetId, pid: launch.pid, selectors: options.selectors.map(selector => selector.methodName ? `${selector.className}#${selector.methodName}` : selector.className), ...(typeof session.activeThreadId === "number" && { activeThreadId: session.activeThreadId }), ...(typeof session.stopId === "string" && { stopId: session.stopId }), attachRequired: false });
      }
      return { status: "debugging", debugSessions: sessions };
    } catch (error) {
      await Promise.all(sessions.map(session => this.bridge.request("detach", [session.sessionId], 3_000).catch(() => undefined)));
      for (const child of children) child.kill();
      throw error;
    }
  }
  async hotSwap(input: { sessionId: string; sourcePaths: string[]; dryRun: boolean }, signal: AbortSignal): Promise<object> {
    const sourceFiles = input.sourcePaths.map(path => workspacePath(this.config.workspace, path));
    for (const path of sourceFiles) if (!existsSync(path)) throw new JavaLspMcpError("SOURCE_NOT_FOUND", `Source file not found: ${relative(this.config.workspace, path)}`);
    if (signal.aborted) throw signal.reason;
    const compilation = await this.java.compile({ kind: "incremental", minimumSeverity: "error", includeText: true, timeoutMs: this.config.timeoutMs, limit: 200, includeTotal: true }) as Record<string, unknown>;
    if (compilation.success !== true) {
      const diagnostics = ((compilation.diagnostics as Array<Record<string, unknown>> | undefined) ?? []).map(item => ({ ...(typeof item.path === "string" && { sourcePath: item.path }), ...(typeof item.line === "number" && { line: item.line }), ...(typeof item.column === "number" && { column: item.column }), severity: item.severity === "warning" ? "warning" : "error", message: String(item.message ?? item.text ?? "Compilation failed") }));
      return { outcome: "compile_failed", classes: [], diagnostics, breakpoints: { restored: [], pending: [], rejected: [] }, activeFrames: [] };
    }
    const classFiles = findClassFiles(this.config.workspace, sourceFiles);
    if (!classFiles.length) throw new JavaLspMcpError("CLASS_FILES_NOT_FOUND", "Compilation succeeded but no class files were found for the selected sources");
    return this.bridge.request("hotswap", [input.sessionId, input.dryRun, classFiles.join("\n")], 60_000);
  }
  close(): Promise<void> { return this.bridge.close(); }
}

function workspacePath(workspace: string, path: string): string { const target = resolve(workspace, path); const rel = relative(resolve(workspace), target); if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new JavaLspMcpError("PATH_OUTSIDE_WORKSPACE", `Debug source path must be a workspace-relative file: ${path}`); return target; }

export function findClassFiles(workspace: string, sources: string[]): string[] {
  const wanted = sources.map(path => { const source = readFileSync(path, "utf8"); const packageName = /^\s*package\s+([\w.]+)\s*;/mu.exec(source)?.[1] ?? ""; return { name: basename(path, ".java"), packagePath: packageName.split(".").filter(Boolean).join(sep) }; });
  const matches = new Map<string, { path: string; mtime: number }>();
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && [".git", "node_modules", ".metadata"].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".class")) {
        const normalized = path.split(sep).join("/"); const target = wanted.find(item => (entry.name === `${item.name}.class` || entry.name.startsWith(`${item.name}$`)) && (!item.packagePath || normalized.endsWith(`${item.packagePath.split(sep).join("/")}/${entry.name}`)));
        if (!target) continue;
        const key = `${target.packagePath}/${entry.name}`; const mtime = statSync(path).mtimeMs; const previous = matches.get(key); if (!previous || mtime > previous.mtime) matches.set(key, { path, mtime });
      }
    }
  };
  visit(workspace); return [...matches.values()].map(value => value.path);
}

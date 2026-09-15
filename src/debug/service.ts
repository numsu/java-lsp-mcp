import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Config } from "../config/config.js";
import type { Logger } from "../logging.js";
import { JavaLspMcpError } from "../types.js";
import type { JavaService } from "../mcp/service.js";
import { DebugBridgeClient } from "./bridge-client.js";

export class DebugService {
  private readonly bridge: DebugBridgeClient;
  constructor(private readonly config: Config, logger: Logger, private readonly java: JavaService) { this.bridge = new DebugBridgeClient(config, logger); }
  targets(input: { query?: string | undefined; includeUnavailable: boolean }): Promise<object> { return this.bridge.request("targets", [input.query, input.includeUnavailable]); }
  attach(input: { targetId: string; timeoutMs: number }): Promise<object> { return this.bridge.request("attach", [input.targetId, input.timeoutMs], input.timeoutMs + 2_000); }
  sessions(): Promise<object> { return this.bridge.request("sessions"); }
  setBreakpoints(input: { sessionId: string; sourcePath: string; breakpoints: Array<{ line: number }> }): Promise<object> { return this.bridge.request("breakpoints", [input.sessionId, workspacePath(this.config.workspace, input.sourcePath), input.breakpoints.map(v => v.line).join(",")]); }
  threads(input: { sessionId: string; includeSystemThreads: boolean }): Promise<object> { return this.bridge.request("threads", [input.sessionId, input.includeSystemThreads]); }
  wait(input: { sessionId: string; timeoutMs: number }): Promise<object> { return this.bridge.request("wait", [input.sessionId, input.timeoutMs], input.timeoutMs + 2_000); }
  stack(input: { sessionId: string; stopId: string; threadId: number; startFrame: number; maxFrames: number }): Promise<object> { return this.bridge.request("stack", [input.sessionId, input.stopId, input.threadId, input.startFrame, input.maxFrames]); }
  variables(input: { sessionId: string; stopId: string; frameId?: string | undefined; valueId?: string | undefined; scope?: string | undefined; start: number; limit: number }): Promise<object> { return this.bridge.request("variables", [input.sessionId, input.stopId, input.frameId, input.valueId, input.scope, input.start, input.limit]); }
  execute(input: { sessionId: string; action: string; threadId?: number | undefined; stopId?: string | undefined; waitTimeoutMs: number }): Promise<object> { return this.bridge.request("execute", [input.sessionId, input.action, input.threadId, input.stopId, input.waitTimeoutMs], input.waitTimeoutMs + 2_000); }
  detach(input: { sessionId: string }): Promise<object> { return this.bridge.request("detach", [input.sessionId]); }
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

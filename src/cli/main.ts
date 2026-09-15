import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadConfig, type Config } from "../config/config.js";
import { JdtSupervisor } from "../jdtls/supervisor.js";
import { Logger } from "../logging.js";
import { buildMcpServer, describeTools } from "../mcp/server.js";
import { JavaService } from "../mcp/service.js";
import { DebugService } from "../debug/service.js";
import { defaultJdtlsHome, workspaceCacheDirectory } from "../runtime/resolver.js";
import { application } from "../version.js";
import { WorkspacePaths } from "../workspace/paths.js";
import { WorkspaceSynchronizer } from "../workspace/watcher.js";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const command = argv.shift() ?? "help";
  if (command === "version") { const data = { name: application.name, version: application.version, mcpRevision: application.mcpRevision, sdk: application.sdkVersion, node: application.nodeVersion, jdk: "external", jdtls: application.jdtlsVersion, compiler: "ecj" }; process.stdout.write(argv.includes("--json") ? `${JSON.stringify(data)}\n` : `${data.name} ${data.version} (MCP ${data.mcpRevision}, JDT LS ${data.jdtls}, ECJ)\n`); return 0; }
  if (command === "describe-tools") { process.stdout.write(`${JSON.stringify(describeTools(), null, 2)}\n`); return 0; }
  if (command === "help" || command === "--help" || command === "-h") { process.stdout.write(usage); return 0; }
  const parsed = parseArgs(argv); if (!parsed.workspace) throw new Error("--workspace is required");
  if (command === "print-config" ? parsed.positionals.length > 1 : parsed.positionals.length) throw new Error(`Unexpected argument: ${parsed.positionals.at(command === "print-config" ? 1 : 0)}`);
  const { positionals: _positionals, ...overrides } = parsed; const workspace = resolve(parsed.workspace); const config = loadConfig(workspace, overrides);
  if (command === "print-config") { const host = parsed.positionals[0] ?? "generic"; process.stdout.write(printConfig(host, config)); return 0; }
  if (command === "clear-cache") { const target = workspaceCacheDirectory(config); if (existsSync(target)) rmSync(target, { recursive: true, force: false }); process.stderr.write(`[java-lsp-mcp] cleared ${target}\n`); return 0; }
  if (command === "doctor") return doctor(config);
  if (command !== "serve") throw new Error(`Unknown command: ${command}`);
  return serve(config);
}

async function serve(config: Config): Promise<number> {
  const logger = new Logger(config.logLevel); const paths = new WorkspacePaths(config.workspace); const supervisor = new JdtSupervisor(config, logger); const sync = new WorkspaceSynchronizer(paths, supervisor.client, logger, config.sourceEncoding); await sync.start();
  void supervisor.start().catch(error => { supervisor.client.state = "failed"; supervisor.client.statusMessage = error instanceof Error ? error.message : String(error); logger.error("JDT LS startup failed", supervisor.client.statusMessage); });
  const service = new JavaService(config, paths, sync, supervisor.client); const debug = new DebugService(config, logger, service); const handle = serveStdio(() => buildMcpServer(service, config, logger, debug), { legacy: "serve", onerror: error => logger.error("MCP transport", error.message) });
  let stopping: Promise<void> | undefined; const stop = (): Promise<void> => stopping ??= (async () => { await handle.close(); await debug.close(); await sync.close(); await supervisor.stop(); })();
  process.once("SIGINT", () => void stop()); process.once("SIGTERM", () => void stop()); process.stdin.once("end", () => void stop()); return 0;
}
function doctor(config: Config): number { const checks: { name: string; ok: boolean; detail: string }[] = []; try { const p = new WorkspacePaths(config.workspace); checks.push({ name: "workspace", ok: true, detail: p.root }); } catch (e) { checks.push({ name: "workspace", ok: false, detail: String(e) }); } const jdk = config.toolingJdk ?? process.env.JAVA_HOME; const java = jdk ? join(jdk, "bin", process.platform === "win32" ? "java.exe" : "java") : undefined; const jdtls = config.jdtlsHome ?? defaultJdtlsHome(); checks.push({ name: "tooling JDK", ok: Boolean(java && existsSync(java)), detail: java ? `${java}${!config.toolingJdk ? " (JAVA_HOME)" : ""}` : "JAVA_HOME is not set" }, { name: "JDT LS", ok: existsSync(jdtls), detail: jdtls }, { name: "compiler", ok: true, detail: "ECJ (javac backend disabled)" }, { name: "workspace trust", ok: config.trustWorkspace, detail: config.trustWorkspace ? "enabled" : "build import disabled" }, { name: "source encoding", ok: true, detail: config.sourceEncoding ?? "UTF-8 or Eclipse project settings" }, { name: "excluded projects", ok: true, detail: config.excludedProjects?.length ? config.excludedProjects.join(", ") : "none" }, { name: "additional test classpath", ok: true, detail: config.testClasspathEntries?.length ? config.testClasspathEntries.join(", ") : "none" }); for (const c of checks) process.stdout.write(`${c.ok ? "OK" : "FAIL"} ${c.name}: ${c.detail}\n`); return checks.every(c => c.ok || c.name === "workspace trust") ? 0 : 1; }
function parseArgs(args: string[]): Partial<Config> & { workspace?: string; positionals: string[] } { const out: Partial<Config> & { workspace?: string; positionals: string[] } = { positionals: [] }; const values: Record<string, keyof Config> = { "--workspace": "workspace", "--max-heap": "maxHeap", "--tooling-jdk": "toolingJdk", "--jdtls-home": "jdtlsHome", "--project-jdk": "projectJdk", "--source-encoding": "sourceEncoding", "--result-mode": "resultMode", "--log-level": "logLevel", "--timeout": "timeoutMs", "--result-budget": "resultBudget" }; for (let i = 0; i < args.length; i++) { const arg = args[i]!; if (arg === "--offline") out.offline = true; else if (arg === "--trust-workspace") out.trustWorkspace = true; else if (arg === "--exclude-project") { const value = args[++i]; if (!value) throw new Error(`${arg} requires a value`); out.excludedProjects = [...(out.excludedProjects ?? []), value]; } else if (arg === "--test-classpath-entry") { const value = args[++i]; if (!value) throw new Error(`${arg} requires a value`); out.testClasspathEntries = [...(out.testClasspathEntries ?? []), value]; } else if (values[arg]) { const value = args[++i]; if (!value) throw new Error(`${arg} requires a value`); const key = values[arg]!; (out as Record<string, unknown>)[key] = key === "timeoutMs" || key === "resultBudget" ? Number(value) : value; } else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`); else out.positionals.push(arg); } return out; }
function printConfig(host: string, config: Config): string {
  const command = resolve("bin", process.platform === "win32" ? "java-lsp-mcp.cmd" : "java-lsp-mcp");
  const args = configArgs(config); const value = { mcpServers: { "java-lsp-mcp": { command, args } } };
  return host === "generic" ? `command: ${JSON.stringify(command)}\nargs:\n${args.map(argument => `  - ${JSON.stringify(argument)}\n`).join("")}` : `${JSON.stringify(value, null, 2)}\n`;
}
function configArgs(config: Config): string[] {
  return ["serve", "--workspace", config.workspace, ...(config.offline ? ["--offline"] : []), ...(config.trustWorkspace ? ["--trust-workspace"] : []), ...(config.maxHeap !== "2g" ? ["--max-heap", config.maxHeap] : []), ...(config.toolingJdk ? ["--tooling-jdk", config.toolingJdk] : []), ...(config.jdtlsHome ? ["--jdtls-home", config.jdtlsHome] : []), ...(config.projectJdk ? ["--project-jdk", config.projectJdk] : []), ...(config.sourceEncoding ? ["--source-encoding", config.sourceEncoding] : []), ...(config.resultMode !== "structured" ? ["--result-mode", config.resultMode] : []), ...(config.logLevel !== "warn" ? ["--log-level", config.logLevel] : []), ...(config.timeoutMs !== 120_000 ? ["--timeout", String(config.timeoutMs)] : []), ...(config.resultBudget !== 12_000 ? ["--result-budget", String(config.resultBudget)] : []), ...(config.excludedProjects ?? []).flatMap(project => ["--exclude-project", project]), ...(config.testClasspathEntries ?? []).flatMap(entry => ["--test-classpath-entry", entry])];
}
const usage = `java-lsp-mcp <command> [options]\n\nCommands:\n  serve --workspace <path> [--source-encoding <encoding>] [--exclude-project <name-or-relative-path>]... [--test-classpath-entry <path>]...\n  doctor --workspace <path>\n  version [--json]\n  describe-tools\n  print-config <host> --workspace <path>\n  clear-cache --workspace <path>\n\nOptions:\n  --offline  --trust-workspace  --max-heap <size>  --tooling-jdk <path>\n  --jdtls-home <path>  --project-jdk <path>  --source-encoding <name>\n  --result-mode <structured|text>  --result-budget <bytes>\n  --log-level <error|warn|info|debug>  --timeout <milliseconds>\n`;

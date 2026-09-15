import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node.js";
import type { Config } from "../config/config.js";
import type { Logger } from "../logging.js";
import { resolveRuntime, workspaceCacheDirectory } from "../runtime/resolver.js";
import { LspClient } from "./client.js";

export class JdtSupervisor {
  readonly client: LspClient;
  private child?: ChildProcessWithoutNullStreams;
  private stopping = false;
  private restarts = 0;
  private dataDir = "";
  constructor(private readonly config: Config, private readonly logger: Logger) { this.client = new LspClient(undefined, config, logger); }
  async start(): Promise<void> {
    const runtime = resolveRuntime(this.config);
    this.dataDir = workspaceCacheDirectory(this.config);
    await mkdir(this.dataDir, { recursive: true });
    const args = [
      "-Declipse.application=org.eclipse.jdt.ls.core.id1", "-Dosgi.bundles.defaultStartLevel=4", "-Declipse.product=org.eclipse.jdt.ls.core.product",
      "-Dlog.level=WARNING", "-Djava.import.generatesMetadataFilesAtProjectRoot=false", ...(this.config.sourceEncoding ? [`-Dfile.encoding=${this.config.sourceEncoding}`] : []), `-Xmx${this.config.maxHeap}`,
      "--add-modules=ALL-SYSTEM", "--add-opens", "java.base/java.util=ALL-UNNAMED", "--add-opens", "java.base/java.lang=ALL-UNNAMED",
      "-jar", runtime.launcher, "-configuration", runtime.configuration, "-data", this.dataDir,
    ];
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, LANG: process.env.LANG, JAVA_HOME: undefined, JDTLS_CLIENT_PORT: undefined, JDTLS_CLIENT_HOST: undefined };
    const child = spawn(runtime.java, args, { stdio: ["pipe", "pipe", "pipe"], env }); this.child = child;
    child.stderr.on("data", chunk => this.logger.warn("JDT LS", String(chunk).trim()));
    const connection = createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
    this.client.attach(connection); connection.listen();
    try { await this.client.initialize(pathToFileURL(this.config.workspace).href, process.pid, this.config.timeoutMs); }
    catch (error) { connection.dispose(); if (child.exitCode === null) child.kill(); this.client.state = "failed"; this.client.statusMessage = error instanceof Error ? error.message : String(error); throw error; }
    if (child.exitCode === null) child.once("exit", (code, signal) => void this.onExit(code, signal));
    else void this.onExit(child.exitCode, child.signalCode);
  }
  private async onExit(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    if (this.stopping) return;
    this.logger.error("JDT LS exited", { code, signal });
    if (this.restarts++ < 1) { await new Promise(resolve => setTimeout(resolve, 500)); try { await this.start(); } catch (error) { this.client.state = "failed"; this.client.statusMessage = String(error); } }
    else { this.client.state = "failed"; this.client.statusMessage = `JDT LS repeatedly exited (${code ?? signal ?? "unknown"})`; }
  }
  async stop(): Promise<void> { this.stopping = true; await this.client.shutdown(); if (this.child && this.child.exitCode === null) { const child = this.child; child.kill(); await Promise.race([new Promise<void>(resolve => child.once("exit", () => resolve())), new Promise<void>(resolve => setTimeout(resolve, 2_000))]); } }
}

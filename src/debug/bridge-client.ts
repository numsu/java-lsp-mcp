import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Config } from "../config/config.js";
import type { Logger } from "../logging.js";
import { JavaLspMcpError, type Json } from "../types.js";

type Pending = { resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer: NodeJS.Timeout };

export class DebugBridgeClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private sequence = 0;
  private readonly pending = new Map<string, Pending>();
  constructor(private readonly config: Config, private readonly logger: Logger) {}

  async request(command: string, args: Array<string | number | boolean | undefined> = [], timeoutMs = 60_000): Promise<Record<string, unknown>> {
    this.start();
    const id = String(++this.sequence);
    const fields = [id, command, ...args.map(value => encode(String(value ?? "")))];
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new JavaLspMcpError("DEBUG_TIMEOUT", `${command} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      this.child!.stdin.write(`${fields.join("\t")}\n`);
    });
  }

  async close(): Promise<void> {
    const child = this.child; this.child = undefined;
    if (!child) return;
    child.stdin.end();
    await new Promise<void>(resolvePromise => { child.once("exit", () => resolvePromise()); setTimeout(() => { child.kill(); resolvePromise(); }, 2_000).unref(); });
  }

  private start(): void {
    if (this.child) return;
    const jdk = this.config.toolingJdk ?? process.env.JAVA_HOME;
    if (!jdk) throw new JavaLspMcpError("RUNTIME_MISSING", "Debugging requires a tooling JDK", { hint: "Set JAVA_HOME or --tooling-jdk" });
    const java = join(jdk, "bin", process.platform === "win32" ? "java.exe" : "java");
    const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const packaged = join(appRoot, "runtime", "debug", "DebugBridge.java");
    const development = resolve("java-debug-bridge", "DebugBridge.java");
    const source = existsSync(packaged) ? packaged : development;
    if (!existsSync(java) || !existsSync(source)) throw new JavaLspMcpError("RUNTIME_MISSING", `JDI debug runtime not found: ${!existsSync(java) ? java : source}`);
    const child = spawn(java, ["--add-modules", "jdk.jdi,jdk.attach", source], { cwd: this.config.workspace, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    createInterface({ input: child.stdout }).on("line", line => this.onLine(line));
    createInterface({ input: child.stderr }).on("line", line => this.logger.debug("debug bridge", line));
    child.once("exit", (code, signal) => {
      if (this.child === child) this.child = undefined;
      const error = new JavaLspMcpError("DEBUG_BRIDGE_EXITED", `Debug bridge exited (${code ?? signal ?? "unknown"})`);
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
      this.pending.clear();
    });
  }

  private onLine(line: string): void {
    const [id, status, payload = ""] = line.split("\t"); if (!id) return;
    const pending = this.pending.get(id); if (!pending) return;
    this.pending.delete(id); clearTimeout(pending.timer);
    let value: Record<string, unknown>;
    try { value = JSON.parse(decode(payload)) as Record<string, unknown>; }
    catch { pending.reject(new JavaLspMcpError("DEBUG_PROTOCOL_ERROR", "Debug bridge returned malformed data")); return; }
    if (status === "OK") pending.resolve(value);
    else pending.reject(new JavaLspMcpError(String(value.code ?? "DEBUG_ERROR"), String(value.message ?? "Debug operation failed"), value.details as Json | undefined));
  }
}

function encode(value: string): string { return Buffer.from(value, "utf8").toString("base64url"); }
function decode(value: string): string { return Buffer.from(value, "base64url").toString("utf8"); }

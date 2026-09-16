import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join, resolve } from "node:path";
import { outputs } from "../../src/mcp/schemas.js";

function javaBin(name: string): string {
  const fromHome = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", process.platform === "win32" ? `${name}.exe` : name) : "";
  if (fromHome && existsSync(fromHome)) return fromHome;
  const found = spawnSync(process.platform === "win32" ? "where" : "which", [name], { encoding: "utf8" });
  const first = found.stdout.split(/\r?\n/u)[0]?.trim();
  return found.status === 0 && first ? first : "";
}

const java = javaBin("java");
const javac = javaBin("javac");

test("JDI bridge source-launches and returns protocol JSON", { skip: !java || !existsSync(java), timeout: 30_000 }, () => {
  const request = `1\ttargets\t\t${Buffer.from("false").toString("base64url")}\n`;
  const result = spawnSync(java, ["--add-modules", "jdk.jdi,jdk.attach", resolve("java-debug-bridge", "DebugBridge.java")], { input: request, encoding: "utf8", timeout: 25_000 });
  assert.equal(result.status, 0, result.stderr);
  const [id, status, payload] = result.stdout.trim().split("\t");
  assert.equal(id, "1"); assert.equal(status, "OK");
  const value = outputs.java_debug_targets.parse(JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"))) as { targets: unknown[] };
  assert.ok(Array.isArray(value.targets));
});

const TARGET_SOURCE = `public class Target {
  static class Holder { int value = 42; boolean ready = true; }
  static volatile int count = 0;
  static int square(int x) { return x * x; }
  public static void main(String[] args) {
    while (true) {
      int v = square(count);
      Holder holder = new Holder();
      if (v < 0) System.out.println(holder);
      count++;
    }
  }
}
`;

class Bridge {
  private readonly child: ChildProcessWithoutNullStreams; private readonly waiters = new Map<string, (value: { status: string; payload: Record<string, unknown> }) => void>(); private buffer = ""; private nextId = 0; private stderr = "";
  constructor(javaPath: string) {
    this.child = spawn(javaPath, ["--add-modules", "jdk.jdi,jdk.attach", resolve("java-debug-bridge", "DebugBridge.java")], { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.on("data", chunk => {
      this.buffer += String(chunk);
      let index: number; while ((index = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 1);
        const [id, status, payload] = line.split("\t");
        if (!id || !status || !payload) continue;
        const waiter = this.waiters.get(id); if (!waiter) continue;
        this.waiters.delete(id);
        try { waiter({ status, payload: JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown> }); }
        catch (error) { this.failAll(error instanceof Error ? error : new Error("Bridge returned malformed data")); }
      }
    });
    this.child.stderr.on("data", chunk => { this.stderr += String(chunk); });
    this.child.on("error", error => this.failAll(error));
    this.child.stdin.on("error", error => this.failAll(error));
    this.child.on("exit", code => this.failAll(new Error(`Bridge exited early with status ${code}\n${this.stderr}`)));
  }
  private failAll(error: Error): void { for (const [id, waiter] of this.waiters) { this.waiters.delete(id); waiter({ status: "ERR", payload: { code: "BRIDGE_UNAVAILABLE", message: error.message } }); } }
  request(command: string, timeoutMs = 30_000, ...values: string[]): Promise<{ status: string; payload: Record<string, unknown> }> {
    const id = String(++this.nextId);
    return new Promise((resolveValue, reject) => {
      const timer = setTimeout(() => { this.waiters.delete(id); reject(new Error(`Bridge request ${command} timed out`)); }, timeoutMs);
      this.waiters.set(id, value => { clearTimeout(timer); resolveValue(value); });
      this.child.stdin.write([id, command, ...values.map(value => Buffer.from(value).toString("base64url"))].join("\t") + "\n");
    });
  }
  async ok(command: string, timeoutMs = 30_000, ...values: string[]): Promise<Record<string, unknown>> {
    const reply = await this.request(command, timeoutMs, ...values);
    assert.equal(reply.status, "OK", JSON.stringify(reply.payload));
    return reply.payload;
  }
  close(): void { try { this.child.stdin.end(); } catch { /* already closed */ } this.child.kill(); }
}

test("JDI bridge drives breakpoints, filtering, stale stops, and pending execution requests", { skip: !java || !javac, timeout: 120_000 }, async t => {
  const root = join(resolve("."), ".tmp-debug-bridge-test"); const classes = join(root, "classes");
  const targetSource = join(root, "Target.java");
  mkdirSync(classes, { recursive: true }); writeFileSync(targetSource, TARGET_SOURCE);
  const compiled = spawnSync(javac, ["-g", "-d", classes, targetSource], { encoding: "utf8", timeout: 30_000 });
  assert.equal(compiled.status, 0, compiled.stderr);
  const target = spawn(java, ["-cp", classes, "-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=*:0", "Target"], { stdio: ["ignore", "pipe", "pipe"] });
  let targetStderr = ""; target.stderr.on("data", chunk => { targetStderr += String(chunk); }); target.stdout.on("data", chunk => { targetStderr += String(chunk); });
  const bridge = new Bridge(java);
  t.after(() => { target.kill(); bridge.close(); rmSync(root, { recursive: true, force: true }); });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !targetStderr.includes("Listening for transport dt_socket at address:")) await new Promise(resolveDelay => setTimeout(resolveDelay, 50));
  assert.ok(targetStderr.includes("Listening for transport dt_socket at address:"), targetStderr);
  assert.ok(target.pid);
  const [targetId] = (outputs.java_debug_targets.parse(await bridge.ok("targets", 30_000, "", "false")) as { targets: Array<{ targetId: string; pid: number; attachable: boolean; jdwp: { server: boolean | null } }> }).targets.filter(entry => entry.pid === target.pid);
  assert.ok(targetId, "launched target must be discovered as attachable");
  assert.equal(targetId!.attachable, true); assert.equal(targetId!.jdwp.server, true);

  const attached = outputs.java_debug_attach.parse(await bridge.ok("attach", 30_000, `local:${target.pid}`, "15000")) as { session: { sessionId: string; state: string; stopId?: string; activeThreadId?: number } };
  const sessionId = attached.session.sessionId;
  assert.equal(attached.session.state, "stopped");
  assert.ok(attached.session.stopId); assert.equal(typeof attached.session.activeThreadId, "number");

  const started = outputs.java_debug_execute.parse(await bridge.ok("execute", 30_000, sessionId, "continue", "", "", "0")) as { outcome: string };
  assert.equal(started.outcome, "running");
  const breakpoint = outputs.java_debug_set_breakpoints.parse(await bridge.ok("breakpoints", 30_000, sessionId, targetSource, "8", "10000")) as { breakpoints: Array<{ state: string; resolvedLine?: number }> };
  assert.equal(breakpoint.breakpoints[0]?.state, "verified"); assert.equal(breakpoint.breakpoints[0]?.resolvedLine, 8);

  const hit = outputs.java_debug_wait_for_stop.parse(await bridge.ok("wait", 60_000, sessionId, "20000")) as { outcome: string; reason: string; stopId: string; threadId: number; location: { className: string; methodName: string; line?: number } };
  assert.equal(hit.outcome, "stopped"); assert.equal(hit.reason, "breakpoint");
  assert.equal(hit.location.className, "Target"); assert.equal(hit.location.methodName, "main"); assert.equal(hit.location.line, 8);
  const stopA = String(hit.stopId); const threadId = Number(hit.threadId);

  const mainOnly = outputs.java_debug_threads.parse(await bridge.ok("threads", 30_000, sessionId, "false", "", "main")) as { threads: Array<{ name: string; suspended: boolean }> };
  assert.deepEqual(mainOnly.threads.map(thread => thread.name), ["main"]); assert.equal(mainOnly.threads[0]?.suspended, true);
  const badPattern = await bridge.request("threads", 30_000, sessionId, "false", "", "[");
  assert.equal(badPattern.status, "ERR"); assert.equal(badPattern.payload.code, "INVALID_PATTERN");

  const trace = outputs.java_debug_stack_trace.parse(await bridge.ok("stack", 30_000, sessionId, stopA, String(threadId), "0", "20", "", "false")) as { frames: Array<{ frameId: string; className: string; methodName: string }>; totalFrames: number; truncated: boolean };
  assert.equal(trace.frames[0]?.className, "Target"); assert.equal(trace.frames[0]?.methodName, "main");
  assert.equal(trace.truncated, false); assert.equal(trace.frames.length, trace.totalFrames);
  assert.ok(trace.frames.every(frame => !/^(java\.|javax\.|jdk\.|sun\.|com\.sun\.)/u.test(frame.className)), "infrastructure frames must be filtered by default");

  const locals = outputs.java_debug_variables.parse(await bridge.ok("variables", 30_000, sessionId, stopA, trace.frames[0]!.frameId, "", "all", "0", "50", "true", "10", "false")) as unknown as { stopId: string; variables: Array<{ name: string; kind: string; value: string; valueId?: string; declaredType?: string; runtimeType?: string; lazy?: boolean; gettersEvaluated?: boolean }> };
  assert.equal(locals.stopId, stopA);
  const local = locals.variables.find(variable => variable.name === "v");
  assert.equal(local?.declaredType, "int"); assert.equal(local?.runtimeType, "int"); assert.equal(local?.kind, "primitive"); assert.equal(local?.lazy, false); assert.equal(local?.gettersEvaluated, false);
  assert.match(String(local?.value), /^-?\d+$/u);
  assert.ok(locals.variables.find(variable => variable.name === "args")?.valueId);

  const stepped = outputs.java_debug_wait_for_stop.parse(await bridge.ok("execute", 60_000, sessionId, "step_over", String(threadId), stopA, "20000")) as Record<string, unknown>;
  assert.equal(stepped.outcome, "stopped"); assert.equal(stepped.reason, "step");
  const stopB = String(stepped.stopId); assert.notEqual(stopB, stopA);
  assert.equal((stepped as { location: { line?: number } }).location.line, 9);

  const inlined = outputs.java_debug_variables.parse(await bridge.ok("variables", 30_000, sessionId, stopB, `${stopB}:${threadId}:0`, "", "all", "0", "50", "true", "10", "false")) as unknown as { variables: Array<{ name: string; kind: string; lazy?: boolean; fields?: Array<{ name: string; value: string; kind: string }> }> };
  const holder = inlined.variables.find(variable => variable.name === "holder");
  assert.equal(holder?.kind, "object"); assert.equal(holder?.lazy, false);
  assert.deepEqual(holder?.fields?.map(field => [field.name, field.value]), [["value", "42"], ["ready", "true"]]);

  const stale = await bridge.request("stack", 30_000, sessionId, stopA, String(threadId), "0", "20", "", "false");
  assert.equal(stale.status, "ERR"); assert.equal(stale.payload.code, "STALE_STOP");
  const details = stale.payload.details as { requestedStopId: string; currentStopId: string; state: string; location: { className: string; methodName: string; line?: number }; hint: string };
  assert.equal(details.requestedStopId, stopA); assert.equal(details.currentStopId, stopB); assert.equal(details.state, "stopped");
  assert.equal(details.location.className, "Target"); assert.equal(details.location.methodName, "main"); assert.equal(details.location.line, 9);
  assert.match(String(stale.payload.message), /stale/u);

  const cleared = outputs.java_debug_set_breakpoints.parse(await bridge.ok("breakpoints", 30_000, sessionId, targetSource, "", "2000")) as { breakpoints: unknown[] };
  assert.deepEqual(cleared.breakpoints, []);
  const running = outputs.java_debug_execute.parse(await bridge.ok("execute", 30_000, sessionId, "continue", "", "", "0")) as { outcome: string; activeRequest?: { action: string } };
  assert.equal(running.outcome, "running"); assert.equal(running.activeRequest?.action, "continue");
  const pending = await bridge.request("execute", 30_000, sessionId, "continue", "", "", "0");
  assert.equal(pending.status, "ERR"); assert.equal(pending.payload.code, "EXECUTION_REQUEST_PENDING");
  const sessions = outputs.java_debug_sessions.parse(await bridge.ok("sessions", 30_000)) as { sessions: Array<{ sessionId: string; state: string; activeRequest?: { action: string } }> };
  assert.equal(sessions.sessions.find(session => session.sessionId === sessionId)?.state, "running");
  assert.equal(sessions.sessions.find(session => session.sessionId === sessionId)?.activeRequest?.action, "continue");
  const detached = outputs.java_debug_detach.parse(await bridge.ok("detach", 30_000, sessionId)) as { detached: boolean; targetState: string };
  assert.equal(detached.detached, true); assert.equal(detached.targetState, "running");
});

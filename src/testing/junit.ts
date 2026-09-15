import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { compact, truncateUtf8 } from "../results/budget.js";

export interface JunitFailure {
  test: string;
  className?: string;
  durationMs?: number;
  message?: string;
  path?: string;
  line?: number;
  stackTrace?: string;
}
export interface JunitRunResult {
  status: "passed" | "failed" | "error" | "timed-out";
  durationMs: number;
  counts: Record<string, number>;
  failures: JunitFailure[];
  message?: string;
  output?: { stdout?: string; stderr?: string; truncated?: boolean };
  /** Raw JaCoCo execution data retained only inside the server until reporting. */
  coverageData?: Buffer;
}
export interface JunitRunOptions {
  java: string;
  console: string;
  classpaths: string[];
  selectors: Array<{ className: string; methodName?: string | undefined; sourcePath: string }>;
  cwd: string;
  vmArgs: string[];
  systemProperties: Record<string, string>;
  timeoutMs: number;
  includeOutput: boolean;
  includeStackTrace: boolean;
  signal?: AbortSignal;
  outputLimit: number;
  coverage?: { agent: string; includes: string[] };
}

export interface JunitDebugLaunch {
  pid: number;
  reports: string;
  child: ChildProcess;
}

export async function runJUnit(options: JunitRunOptions): Promise<JunitRunResult> {
  const reports = await mkdtemp(join(tmpdir(), "java-lsp-mcp-junit-"));
  const started = Date.now();
  const coverageFile = join(reports, "jacoco.exec");
  try {
    const argumentFile = await writeJUnitArgumentFile(options, reports);
    const processResult = await execute(options.java, [`@${argumentFile}`], options.cwd, options.timeoutMs, options.signal, options.outputLimit);
    const parsed = await parseJUnitReports(reports, Object.fromEntries(options.selectors.map(selector => [selector.className, selector.sourcePath])), options.includeStackTrace);
    const failures = parsed.failures;
    const counts = parsed.counts;
    const coverageData = options.coverage ? await readFile(coverageFile).catch(error => isMissingFile(error) ? undefined : Promise.reject(error)) : undefined;
    const status = processResult.timedOut ? "timed-out" : failures.length || processResult.code === 1 ? "failed" : processResult.code === 0 ? "passed" : "error";
    const diagnostic = processResult.stderr.trim() || processResult.stdout.trim();
    return {
      status,
      durationMs: Date.now() - started,
      counts,
      failures,
      ...(status === "error" && diagnostic && { message: diagnostic.slice(0, 2000) }),
      ...(options.includeOutput && { output: compactOutput(processResult) }),
      ...(coverageData && { coverageData }),
    };
  } finally {
    await rm(reports, { recursive: true, force: true });
  }
}

export async function launchJUnit(options: JunitRunOptions): Promise<JunitDebugLaunch> {
  const reports = await mkdtemp(join(tmpdir(), "java-lsp-mcp-junit-debug-"));
  try {
    const argumentFile = await writeJUnitArgumentFile(options, reports);
    const child = spawn(options.java, [`@${argumentFile}`], { cwd: options.cwd, env: process.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.resume(); child.stderr.resume();
    child.once("exit", () => { void rm(reports, { recursive: true, force: true }); });
    child.once("error", () => { void rm(reports, { recursive: true, force: true }); });
    if (child.pid === undefined) { await rm(reports, { recursive: true, force: true }); throw new Error("JUnit debug process did not expose a PID"); }
    return { pid: child.pid, reports, child };
  } catch (error) { await rm(reports, { recursive: true, force: true }); throw error; }
}

async function writeJUnitArgumentFile(options: JunitRunOptions, reports: string): Promise<string> {
  const selectors = options.selectors.flatMap(selector => selector.methodName ? [`--select-method=${selector.className}#${selector.methodName}`] : [`--select-class=${selector.className}`]);
  const coverageFile = join(reports, "jacoco.exec");
  const coverageOptions = [`destfile=${coverageFile}`, "append=false", ...(options.coverage?.includes.length ? [`includes=${options.coverage.includes.join(":")}`] : [])].join(",");
  const args = [
    ...options.vmArgs,
    ...Object.entries(options.systemProperties).map(([key, value]) => `-D${key}=${value}`),
    "-Dfile.encoding=UTF-8", "-Dstdout.encoding=UTF-8", "-Dstderr.encoding=UTF-8",
    ...(options.coverage ? [`-javaagent:${options.coverage.agent}=${coverageOptions}`] : []),
    "-jar", options.console, "execute", "--disable-banner", "--disable-ansi-colors", "--details=none",
    "--config=junit.jupiter.execution.parallel.enabled=true", "--config=junit.jupiter.execution.parallel.mode.default=concurrent", "--config=junit.jupiter.execution.parallel.mode.classes.default=concurrent",
    `--reports-dir=${reports}`, `--class-path=${options.classpaths.join(delimiter)}`, ...selectors,
  ];
  const argumentFile = join(reports, "java.args");
  await writeFile(argumentFile, args.map(argumentFileValue).join("\n"), "utf8");
  return argumentFile;
}

async function execute(java: string, args: string[], cwd: string, timeoutMs: number, signal: AbortSignal | undefined, outputLimit: number): Promise<{ code: number | null; stdout: string; stderr: string; truncated: boolean; timedOut: boolean }> {
  if (signal?.aborted) throw signal.reason ?? new Error("Request cancelled");
  return new Promise((resolve, reject) => {
    const child = spawn(java, args, { cwd, env: process.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", truncated = false, timedOut = false, settled = false; const stdoutDecoder = new StringDecoder("utf8"), stderrDecoder = new StringDecoder("utf8");
    const append = (current: string, chunk: string): string => { const selected = truncateUtf8(`${current}${chunk}`, outputLimit); if (selected.truncated) truncated = true; return selected.text; };
    child.stdout.on("data", chunk => { stdout = append(stdout, stdoutDecoder.write(chunk as Buffer)); });
    child.stderr.on("data", chunk => { stderr = append(stderr, stderrDecoder.write(chunk as Buffer)); });
    const stop = (): void => { if (child.exitCode === null) child.kill(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs); timer.unref();
    const aborted = (): void => stop();
    signal?.addEventListener("abort", aborted, { once: true });
    child.once("error", error => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", aborted); reject(error); });
    child.once("exit", code => { if (settled) return; settled = true; stdout = append(stdout, stdoutDecoder.end()); stderr = append(stderr, stderrDecoder.end()); clearTimeout(timer); signal?.removeEventListener("abort", aborted); if (signal?.aborted) { reject(signal.reason ?? new Error("Request cancelled")); return; } resolve({ code, stdout, stderr, truncated, timedOut }); });
  });
}

async function reportFiles(directory: string): Promise<string[]> {
  return (await readdir(directory, { recursive: true })).filter(name => name.endsWith(".xml")).map(name => join(directory, name));
}
export async function parseJUnitReports(directory: string, sourcePaths: string | Record<string, string>, includeStackTrace: boolean): Promise<{ counts: Record<string, number>; failures: JunitFailure[] }> {
  const paths: Record<string, string> = typeof sourcePaths === "string" ? { "": sourcePaths } : sourcePaths;
  const failures: JunitFailure[] = [];
  const counts = { passed: 0, failed: 0, skipped: 0 };
  for (const file of await reportFiles(directory)) {
    const xml = await readFile(file, "utf8");
    for (const match of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/gu)) {
      const body = match[2] ?? ""; const failure = /<(failure|error)\b([^>]*)>([\s\S]*?)<\/\1>/u.exec(body);
      if (!failure) { counts[/<skipped\b/u.test(body) ? "skipped" : "passed"]++; continue; }
      counts.failed++;
      const attributes = xmlAttributes(match[1] ?? ""); const failureAttributes = xmlAttributes(failure[2] ?? ""); const stackTrace = stripXml(failure[3] ?? "").trim();
      const sourcePath = paths[attributes.classname ?? ""] ?? paths[""] ?? Object.values(paths)[0]; const location = sourcePath ? stackLocation(stackTrace, sourcePath) : {};
      failures.push(compact({ test: attributes.name ?? "unknown", className: attributes.classname, durationMs: seconds(attributes.time), message: failureAttributes.message, ...location, stackTrace: includeStackTrace ? stackTrace : undefined }) as JunitFailure);
    }
  }
  return { counts: Object.fromEntries(Object.entries(counts).filter(([, value]) => value > 0)), failures };
}
function xmlAttributes(value: string): Record<string, string> { return Object.fromEntries([...value.matchAll(/([\w:-]+)="([^"]*)"/gu)].map(match => [match[1]!, decodeXml(match[2]!) ])); }
function decodeXml(value: string): string { return value.replace(/&(?:#(\d+)|#x([\da-f]+)|quot|apos|lt|gt|amp);/giu, (entity, decimal: string | undefined, hex: string | undefined) => decimal ? String.fromCodePoint(Number(decimal)) : hex ? String.fromCodePoint(Number.parseInt(hex, 16)) : ({ "&quot;": '"', "&apos;": "'", "&lt;": "<", "&gt;": ">", "&amp;": "&" }[entity] ?? entity)); }
function stripXml(value: string): string { return decodeXml(value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, "$1").replace(/<[^>]+>/gu, "")); }
function seconds(value: string | undefined): number | undefined { if (!value) return undefined; const number = Number(value); return Number.isFinite(number) ? Math.round(number * 1000) : undefined; }
function stackLocation(stack: string, sourcePath: string): { path?: string; line?: number } { const file = basename(sourcePath); const escaped = file.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"); const match = new RegExp(`\\(${escaped}:(\\d+)\\)`, "u").exec(stack); return match ? { path: sourcePath, line: Number(match[1]) } : {}; }
function compactOutput(value: { stdout: string; stderr: string; truncated: boolean }): { stdout?: string; stderr?: string; truncated?: boolean } { return compact({ stdout: value.stdout || undefined, stderr: value.stderr || undefined, truncated: value.truncated || undefined }) as { stdout?: string; stderr?: string; truncated?: boolean }; }
export function argumentFileValue(value: string): string { return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\r", "\\r").replaceAll("\n", "\\n")}"`; }
function isMissingFile(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"; }

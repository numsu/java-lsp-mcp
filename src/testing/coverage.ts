import { spawn } from "node:child_process";
import { stat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize, sep } from "node:path";
import { argumentFileValue } from "./junit.js";

export interface CoverageMetric { covered: number; missed: number; percent: number }
export interface CoverageFile { path: string; coveredLines: number; missedLines: number[] }
export interface CoverageReport {
  complete: boolean;
  summary?: { instructions: CoverageMetric; branches: CoverageMetric; lines: CoverageMetric };
  files: CoverageFile[];
  message?: string;
}
export interface CoverageReportOptions {
  java: string;
  cli: string;
  executionData: Buffer[];
  classpaths: string[];
  sourceFiles: string[];
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export async function createCoverageReport(options: CoverageReportOptions): Promise<CoverageReport> {
  if (!options.executionData.length) return { complete: false, files: [], message: "JaCoCo did not produce execution data" };
  const classDirectories = await coverageClassDirectories(options.classpaths);
  if (!classDirectories.length) return { complete: false, files: [], message: "No production class directories were found on the JDT test classpath" };
  const directory = await mkdtemp(join(tmpdir(), "java-lsp-mcp-coverage-"));
  try {
    const executionFiles = await Promise.all(options.executionData.map(async (data, index) => { const path = join(directory, `${index}.exec`); await writeFile(path, data); return path; }));
    const xml = join(directory, "report.xml");
    const args = ["-Dfile.encoding=UTF-8", "-jar", options.cli, "report", ...executionFiles, ...classDirectories.flatMap(path => ["--classfiles", path]), "--xml", xml];
    const argumentFile = join(directory, "java.args");
    await writeFile(argumentFile, args.map(argumentFileValue).join("\n"), "utf8");
    const result = await execute(options.java, [`@${argumentFile}`], options.cwd, options.timeoutMs, options.signal);
    if (result.code !== 0) return { complete: false, files: [], message: result.stderr.trim().slice(0, 2000) || `JaCoCo report exited with code ${result.code}` };
    return parseCoverageXml(await readFile(xml, "utf8"), options.sourceFiles);
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason ?? error;
    return { complete: false, files: [], message: error instanceof Error ? error.message : String(error) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function parseCoverageXml(xml: string, sourceFiles: string[]): CoverageReport {
  const counters = new Map<string, CoverageMetric>();
  for (const match of xml.matchAll(/<counter\b([^>]*?)\/>/gu)) {
    const attributes = xmlAttributes(match[1] ?? ""); const type = attributes.type; const missed = Number(attributes.missed); const covered = Number(attributes.covered);
    if (type && Number.isFinite(missed) && Number.isFinite(covered)) counters.set(type, metric(covered, missed));
  }
  const normalizedSources = sourceFiles.map(path => path.split("\\").join("/"));
  const files: CoverageFile[] = [];
  for (const packageMatch of xml.matchAll(/<package\b([^>]*)>([\s\S]*?)<\/package>/gu)) {
    const packageName = xmlAttributes(packageMatch[1] ?? "").name ?? "";
    for (const sourceMatch of (packageMatch[2] ?? "").matchAll(/<sourcefile\b([^>]*)>([\s\S]*?)<\/sourcefile>/gu)) {
      const name = xmlAttributes(sourceMatch[1] ?? "").name; if (!name) continue;
      const suffix = `${packageName ? `${packageName}/` : ""}${name}`; const candidates = normalizedSources.filter(path => path.endsWith(suffix));
      const path = candidates.sort((left, right) => sourceRank(left) - sourceRank(right) || left.localeCompare(right))[0]; if (!path) continue;
      let coveredLines = 0; const missedLines: number[] = [];
      for (const lineMatch of (sourceMatch[2] ?? "").matchAll(/<line\b([^>]*?)\/>/gu)) {
        const attributes = xmlAttributes(lineMatch[1] ?? ""); const line = Number(attributes.nr); const missed = Number(attributes.mi); const covered = Number(attributes.ci);
        if (!Number.isInteger(line)) continue; if (covered > 0) coveredLines++; else if (missed > 0) missedLines.push(line);
      }
      files.push({ path, coveredLines, missedLines });
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  const instructions = counters.get("INSTRUCTION"), branches = counters.get("BRANCH") ?? metric(0, 0), lines = counters.get("LINE");
  return { complete: Boolean(instructions && lines), ...(instructions && lines && { summary: { instructions, branches, lines } }), files, ...(!(instructions && lines) && { message: "JaCoCo report did not contain instruction and line root counters" }) };
}

async function coverageClassDirectories(classpaths: string[]): Promise<string[]> {
  const unique = [...new Set(classpaths.map(path => normalize(path)))]; const values: string[] = [];
  for (const path of unique) {
    const slash = path.split(sep).join("/").toLowerCase();
    if (/\/(?:test-classes|classes\/java\/test|classes\/kotlin\/test|bin\/test)(?:\/|$)/u.test(slash)) continue;
    if (await stat(path).then(value => value.isDirectory()).catch(() => false)) values.push(path);
  }
  return values;
}
function metric(covered: number, missed: number): CoverageMetric { const total = covered + missed; return { covered, missed, percent: total ? Math.round(covered * 10_000 / total) / 100 : 100 }; }
function sourceRank(path: string): number { return path.includes("/src/main/") ? 0 : path.includes("/src/test/") ? 2 : 1; }
function xmlAttributes(value: string): Record<string, string> { return Object.fromEntries([...value.matchAll(/([\w:-]+)="([^"]*)"/gu)].map(match => [match[1]!, match[2]!])); }
async function execute(command: string, args: string[], cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<{ code: number | null; stderr: string }> {
  if (signal?.aborted) throw signal.reason ?? new Error("Request cancelled");
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: process.env, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] }); let stderr = "", settled = false, timedOut = false;
    child.stderr.setEncoding("utf8"); child.stderr.on("data", value => { if (stderr.length < 4000) stderr += String(value); });
    const stop = (): void => { if (child.exitCode === null) child.kill(); }; const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs); timer.unref(); const aborted = (): void => stop(); signal?.addEventListener("abort", aborted, { once: true });
    child.once("error", error => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", aborted); reject(error); });
    child.once("exit", code => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", aborted); if (signal?.aborted) reject(signal.reason ?? new Error("Request cancelled")); else resolve({ code: timedOut ? null : code, stderr: timedOut ? `JaCoCo report timed out after ${timeoutMs}ms` : stderr }); });
  });
}

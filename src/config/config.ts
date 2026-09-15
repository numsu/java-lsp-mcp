import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type { LogLevel } from "../logging.js";

export interface Config {
  workspace: string;
  offline: boolean;
  trustWorkspace: boolean;
  maxHeap: string;
  toolingJdk?: string;
  jdtlsHome?: string;
  projectJdk?: string;
  resultMode: "structured" | "text";
  logLevel: LogLevel;
  timeoutMs: number;
  resultBudget: number;
  excludedProjects?: string[];
  testClasspathEntries?: string[];
  sourceEncoding?: string;
}

const defaults: Omit<Config, "workspace"> = {
  offline: false, trustWorkspace: false, maxHeap: "2g", resultMode: "structured",
  logLevel: "warn", timeoutMs: 120_000, resultBudget: 12_000, excludedProjects: [], testClasspathEntries: [],
};

const configSchema = z.object({
  workspace: z.string().min(1),
  offline: z.boolean(),
  trustWorkspace: z.boolean(),
  maxHeap: z.string().min(1),
  toolingJdk: z.string().min(1).optional(),
  jdtlsHome: z.string().min(1).optional(),
  projectJdk: z.string().min(1).optional(),
  resultMode: z.enum(["structured", "text"]),
  logLevel: z.enum(["error", "warn", "info", "debug"]),
  timeoutMs: z.number().int().min(1).max(3_600_000),
  resultBudget: z.number().int().min(1_024).max(10_000_000),
  excludedProjects: z.array(z.string().min(1)),
  testClasspathEntries: z.array(z.string().min(1)),
  sourceEncoding: z.string().min(1).optional(),
}).strict();

export function loadConfig(workspace: string, cli: Partial<Config>): Config {
  let file: Partial<Config> = {};
  for (const name of ["java-lsp-mcp.json", "java-lsp-mcp.toml"]) {
    try {
      const text = readFileSync(resolve(workspace, name), "utf8");
      file = name.endsWith(".json") ? JSON.parse(text) as Partial<Config> : parseToml(text);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const offline = envBoolean("JAVA_LSP_MCP_OFFLINE"), trustWorkspace = envBoolean("JAVA_LSP_MCP_TRUST_WORKSPACE"), timeoutMs = envNumber("JAVA_LSP_MCP_TIMEOUT_MS"), resultBudget = envNumber("JAVA_LSP_MCP_RESULT_BUDGET");
  const env: Partial<Config> = {
    ...(offline !== undefined && { offline }),
    ...(trustWorkspace !== undefined && { trustWorkspace }),
    ...(process.env.JAVA_LSP_MCP_MAX_HEAP && { maxHeap: process.env.JAVA_LSP_MCP_MAX_HEAP }),
    ...(process.env.JAVA_LSP_MCP_TOOLING_JDK && { toolingJdk: process.env.JAVA_LSP_MCP_TOOLING_JDK }),
    ...(process.env.JAVA_LSP_MCP_JDTLS_HOME && { jdtlsHome: process.env.JAVA_LSP_MCP_JDTLS_HOME }),
    ...(process.env.JAVA_LSP_MCP_PROJECT_JDK && { projectJdk: process.env.JAVA_LSP_MCP_PROJECT_JDK }),
    ...(process.env.JAVA_LSP_MCP_SOURCE_ENCODING && { sourceEncoding: process.env.JAVA_LSP_MCP_SOURCE_ENCODING }),
    ...(process.env.JAVA_LSP_MCP_RESULT_MODE && { resultMode: process.env.JAVA_LSP_MCP_RESULT_MODE as Config["resultMode"] }),
    ...(process.env.JAVA_LSP_MCP_LOG_LEVEL && { logLevel: process.env.JAVA_LSP_MCP_LOG_LEVEL as LogLevel }),
    ...(timeoutMs !== undefined && { timeoutMs }),
    ...(resultBudget !== undefined && { resultBudget }),
  };
  return configSchema.parse({ ...defaults, ...file, ...env, ...cli, workspace }) as Config;
}

function parseToml(text: string): Partial<Config> {
  const out: Record<string, unknown> = {};
  for (const raw of text.split(/\r?\n/u)) {
    const line = stripTomlComment(raw).trim();
    if (!line) continue;
    const match = /^([A-Za-z][\w-]*)\s*=\s*(.+)$/u.exec(line);
    if (!match) throw new Error(`Unsupported TOML line: ${raw}`);
    const key = match[1]!.replace(/-([a-z])/gu, (_, c: string) => c.toUpperCase());
    out[key] = parseTomlValue(match[2]!.trim());
  }
  return out as Partial<Config>;
}

function envBoolean(name: string): boolean | undefined { const value = process.env[name]?.trim().toLowerCase(); if (!value) return undefined; if (["1", "true"].includes(value)) return true; if (["0", "false"].includes(value)) return false; throw new Error(`${name} must be true, false, 1, or 0`); }
function envNumber(name: string): number | undefined { const value = process.env[name]?.trim(); return value ? Number(value) : undefined; }
function stripTomlComment(value: string): string { let quote = ""; for (let index = 0; index < value.length; index++) { const character = value[index]!; if (quote && character === "\\" && quote === '"') index++; else if (character === '"' || character === "'") quote = quote === character ? "" : quote || character; else if (character === "#" && !quote) return value.slice(0, index); } return value; }
function parseTomlValue(value: string): unknown {
  if (value === "true" || value === "false") return value === "true";
  if (/^[+-]?\d+$/u.test(value)) return Number(value);
  if (value.startsWith("[") && value.endsWith("]")) return splitTomlArray(value.slice(1, -1)).map(parseTomlValue);
  if (value.startsWith('"') && value.endsWith('"')) return JSON.parse(value) as unknown;
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value;
}
function splitTomlArray(value: string): string[] { const items: string[] = []; let start = 0, quote = ""; for (let index = 0; index < value.length; index++) { const character = value[index]!; if (quote && character === "\\" && quote === '"') index++; else if (character === '"' || character === "'") quote = quote === character ? "" : quote || character; else if (character === "," && !quote) { items.push(value.slice(start, index).trim()); start = index + 1; } } const last = value.slice(start).trim(); if (last) items.push(last); return items; }

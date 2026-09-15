import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JavaLspMcpError } from "../types.js";
import type { Config } from "../config/config.js";
import { application } from "../version.js";

export interface RuntimePaths { java: string; jdtlsHome: string; launcher: string; configuration: string }
export interface TestRuntimePaths { java: string; console: string }
export interface CoverageRuntimePaths { agent: string; cli: string }
export function jdkExecutionEnvironment(jdk: string): string {
  let release: string; try { release = readFileSync(join(jdk, "release"), "utf8"); } catch { throw new JavaLspMcpError("RUNTIME_INVALID", `JDK release metadata not found: ${jdk}`); }
  const version = /^JAVA_VERSION="([^"]+)"/mu.exec(release)?.[1]; const major = version ? Number(/^1\.(\d+)|^(\d+)/u.exec(version)?.slice(1).find(Boolean)) : Number.NaN;
  if (!Number.isInteger(major) || major < 1) throw new JavaLspMcpError("RUNTIME_INVALID", `Could not determine the JDK version from ${join(jdk, "release")}`);
  return `JavaSE-${major <= 8 ? `1.${major}` : major}`;
}
export function workspaceCacheDirectory(config: Config): string {
  const exclusions = [...(config.excludedProjects ?? [])].sort().join("\0");
  const runtime = config.jdtlsHome ?? `bundled-${application.jdtlsVersion}`;
  const key = createHash("sha256").update(`selective-import-v2\0${config.workspace}\0${runtime}\0${config.trustWorkspace}\0${config.sourceEncoding ?? "project-default"}\0${exclusions}`).digest("hex").slice(0, 24);
  const cache = process.env.JAVA_LSP_MCP_CACHE_DIR ?? process.env.LOCALAPPDATA ?? process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(cache, application.name, "workspaces", key);
}
export function defaultJdtlsHome(): string {
  // In both development (`dist/server.mjs`) and packaged releases
  // (`app/server.mjs`), the application root is the bundle's parent.
  const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  return join(appRoot, "runtime", "jdtls");
}
export function resolveRuntime(config: Config): RuntimePaths {
  const jdk = config.toolingJdk ?? process.env.JAVA_HOME;
  if (!jdk) {
    throw new JavaLspMcpError("RUNTIME_MISSING", "No external JDK configured", {
      hint: "Set JAVA_HOME to a JDK installation or use --tooling-jdk/JAVA_LSP_MCP_TOOLING_JDK",
    });
  }
  const jdtlsHome = config.jdtlsHome ?? defaultJdtlsHome();
  const java = join(jdk, "bin", process.platform === "win32" ? "java.exe" : "java");
  const platform = process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : "linux";
  const configuration = join(jdtlsHome, `config_${platform}`);
  const locked = readLauncher(jdtlsHome);
  const launcher = join(jdtlsHome, "plugins", locked);
  for (const [name, value] of Object.entries({ java, jdtlsHome, launcher, configuration })) {
    if (!existsSync(value)) throw new JavaLspMcpError("RUNTIME_MISSING", `${name} not found: ${value}`, { hint: name === "java" ? "Set JAVA_HOME to a valid JDK or use --tooling-jdk" : "Run java-lsp-mcp fetch-runtime or use --jdtls-home" });
  }
  return { java, jdtlsHome, launcher, configuration };
}
export function resolveTestRuntime(config: Config): TestRuntimePaths {
  const jdk = config.projectJdk ?? config.toolingJdk ?? process.env.JAVA_HOME;
  if (!jdk) throw new JavaLspMcpError("RUNTIME_MISSING", "No external project JDK configured", { hint: "Set JAVA_HOME or use --project-jdk" });
  const java = join(jdk, "bin", process.platform === "win32" ? "java.exe" : "java");
  const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const packaged = join(appRoot, "runtime", "junit-console", "junit-platform-console-standalone.jar");
  const development = resolve(".runtime", "junit-console", "junit-platform-console-standalone.jar");
  const console = existsSync(packaged) ? packaged : development;
  for (const [name, value] of Object.entries({ java, console })) if (!existsSync(value)) throw new JavaLspMcpError("RUNTIME_MISSING", `${name} not found: ${value}`, { hint: name === "java" ? "Set JAVA_HOME or use --project-jdk" : "Run java-lsp-mcp fetch-runtime or rebuild the release" });
  return { java, console };
}
export function resolveCoverageRuntime(): CoverageRuntimePaths {
  const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const packaged = join(appRoot, "runtime", "jacoco");
  const development = resolve(".runtime", "jacoco");
  const root = existsSync(join(packaged, "lib", "jacocoagent.jar")) ? packaged : development;
  const agent = join(root, "lib", "jacocoagent.jar"); const cli = join(root, "lib", "jacococli.jar");
  for (const [name, value] of Object.entries({ agent, cli })) if (!existsSync(value)) throw new JavaLspMcpError("RUNTIME_MISSING", `${name} not found: ${value}`, { hint: "Run java-lsp-mcp fetch-runtime or rebuild the release" });
  return { agent, cli };
}
function readLauncher(home: string): string {
  const lock = join(home, "launcher.lock");
  if (existsSync(lock)) return readFileSync(lock, "utf8").trim();
  const plugins = join(home, "plugins");
  if (!existsSync(plugins)) return "org.eclipse.equinox.launcher.jar";
  const matches = readdirSync(plugins).filter(n => /^org\.eclipse\.equinox\.launcher_[\w.-]+\.jar$/u.test(n));
  if (matches.length !== 1) throw new JavaLspMcpError("RUNTIME_INVALID", "JDT LS launcher.lock missing and launcher is ambiguous");
  return matches[0]!;
}

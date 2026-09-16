import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const bundleIndex = process.argv.indexOf("--bundle"); const bundleArgument = process.argv[bundleIndex + 1]; if (bundleIndex < 0 || !bundleArgument || bundleArgument.startsWith("--")) throw new Error("--bundle is required");
let bundle = resolve(bundleArgument); const extracted = bundle.endsWith(".zip") || bundle.endsWith(".tar.gz"); let cleanup = undefined;
if (extracted) {
  cleanup = await mkdtemp(join(tmpdir(), "java-lsp-mcp-smoke-"));
  // bsdtar (macOS/Windows) extracts both containers; fall back to unzip for
  // zip archives when only GNU tar is available.
  try { execFileSync("tar", ["-xf", bundle, "-C", cleanup], { stdio: "inherit" }); }
  catch { execFileSync("unzip", ["-q", "-o", bundle, "-d", cleanup], { stdio: "inherit" }); }
  bundle = join(cleanup, "java-lsp-mcp");
}
try {
  const bin = process.platform === "win32" ? `${bundle}\\bin\\java-lsp-mcp.cmd` : `${bundle}/bin/java-lsp-mcp`; const env = { PATH: "", SystemRoot: process.env.SystemRoot }; const output = process.platform === "win32" ? execFileSync(join(process.env.SystemRoot, "System32", "cmd.exe"), ["/d", "/c", bin, "version", "--json"], { encoding: "utf8", env }) : execFileSync(bin, ["version", "--json"], { encoding: "utf8", env }); const version = JSON.parse(output); if (version.name !== "java-lsp-mcp" || version.compiler !== "ecj") throw new Error("Release smoke test failed"); process.stdout.write(`smoke ok: ${version.version}\n`);
} finally { if (cleanup) await rm(cleanup, { recursive: true, force: true }); }

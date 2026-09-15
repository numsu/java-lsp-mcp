import { access, chmod, cp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

const platformIndex = process.argv.indexOf("--platform");
const platform = process.argv[platformIndex + 1];
if (platformIndex < 0 || !platform || platform.startsWith("--")) throw new Error("--platform is required");

// Release names are deliberately versionless so editor configuration never changes.
const finalRoot = resolve("artifacts", `java-lsp-mcp-${platform}`);
const stageRoot = resolve("artifacts", `.java-lsp-mcp-${platform}-staging`);
const bundle = join(stageRoot, "java-lsp-mcp");
await rm(stageRoot, { recursive: true, force: true });

execFileSync(process.execPath, ["scripts/fetch-runtime.mjs", "--platform", platform, "--output", join(bundle, "runtime"), "--cache", resolve(".runtime/downloads")], { stdio: "inherit" });
await Promise.all([mkdir(join(bundle, "app"), { recursive: true }), mkdir(join(bundle, "bin"), { recursive: true }), mkdir(join(bundle, "licenses"), { recursive: true })]);
await cp("dist/server.mjs", join(bundle, "app", "server.mjs"));
await cp("dist/runtime/debug", join(bundle, "runtime", "debug"), { recursive: true });
await cp("third_party/notices/THIRD_PARTY_NOTICES.md", join(bundle, "licenses", "THIRD_PARTY_NOTICES.md"));
await cp("README.md", join(bundle, "README.txt"));
await cp("runtime/versions.lock.json", join(bundle, "manifest.json"));
await writeFile(join(bundle, "bin", "java-lsp-mcp"), '#!/bin/sh\nD="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"\nexec "$D/runtime/node/bin/node" "$D/app/server.mjs" "$@"\n');
await chmod(join(bundle, "bin", "java-lsp-mcp"), 0o755);
await writeFile(join(bundle, "bin", "java-lsp-mcp.cmd"), '@echo off\r\nset "D=%~dp0.."\r\n"%D%\\runtime\\node\\node.exe" "%D%\\app\\server.mjs" %*\r\n');

const windows = platform.startsWith("windows-");
const finalArchive = `${finalRoot}${windows ? ".zip" : ".tar.gz"}`;
const stagedArchive = `${finalRoot}.tmp${windows ? ".zip" : ".tar.gz"}`;
await rm(stagedArchive, { force: true });
if (windows) execFileSync("tar", ["-a", "-cf", stagedArchive, "-C", stageRoot, "java-lsp-mcp"]);
else execFileSync("tar", ["-czf", stagedArchive, "-C", stageRoot, "java-lsp-mcp"]);
await rm(finalArchive, { force: true });
await rename(stagedArchive, finalArchive);

try {
  await rm(finalRoot, { recursive: true, force: true });
  await rename(stageRoot, finalRoot);
} catch (error) {
  if (error?.code !== "EPERM" && error?.code !== "EBUSY") throw error;
  // Windows cannot replace a running bundled node.exe. Refresh application
  // files in place and retain an already-installed runtime until VS Code stops.
  await mkdir(join(finalRoot, "java-lsp-mcp"), { recursive: true });
  for (const name of ["app", "bin", "licenses", "README.txt", "manifest.json"]) {
    await rm(join(finalRoot, "java-lsp-mcp", name), { recursive: true, force: true });
    await cp(join(bundle, name), join(finalRoot, "java-lsp-mcp", name), { recursive: true });
  }
  for (const name of ["node", "jdtls", "junit-console", "jacoco", "debug"]) {
    const destination = join(finalRoot, "java-lsp-mcp", "runtime", name);
    if (!await exists(destination)) await cp(join(bundle, "runtime", name), destination, { recursive: true });
  }
  // Remove JDKs left by releases from before Java became an external prerequisite.
  await rm(join(finalRoot, "java-lsp-mcp", "runtime", "jdk"), { recursive: true, force: true });
  await rm(stageRoot, { recursive: true, force: true });
  process.stderr.write("[java-lsp-mcp] updated application files at stable path; retained runtime files held open by a running process\n");
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

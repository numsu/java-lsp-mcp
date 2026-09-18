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
// Node.js is an external prerequisite: the launchers use the system node from PATH.
await writeFile(join(bundle, "bin", "java-lsp-mcp"), '#!/bin/sh\nd="$0"\ncase $d in */*) d=${d%/*};; esac\nD="$(CDPATH= cd -- "$d/.." && pwd)"\nexec node "$D/app/server.mjs" "$@"\n');
await chmod(join(bundle, "bin", "java-lsp-mcp"), 0o755);
await writeFile(join(bundle, "bin", "java-lsp-mcp.cmd"), '@echo off\r\nset "D=%~dp0.."\r\nnode "%D%\\app\\server.mjs" %*\r\n');

const windows = platform.startsWith("windows-");
const finalArchive = `${finalRoot}${windows ? ".zip" : ".tar.gz"}`;
const stagedArchive = `${finalRoot}.tmp${windows ? ".zip" : ".tar.gz"}`;
await rm(stagedArchive, { force: true });
if (windows) {
  // GNU tar cannot write zip archives (it silently emits a plain tar), so only
  // use tar when it is bsdtar; prefer the zip CLI, which both write and verify.
  if (commandSucceeds("zip", ["-v"])) execFileSync("zip", ["-q", "-r", "-X", stagedArchive, "java-lsp-mcp"], { cwd: stageRoot, stdio: "inherit" });
  else if (isBsdTar()) execFileSync("tar", ["-a", "-cf", stagedArchive, "-C", stageRoot, "java-lsp-mcp"], { stdio: "inherit" });
  else throw new Error("Creating the Windows zip requires the zip command or bsdtar; GNU tar cannot write zip archives");
} else execFileSync("tar", ["-czf", stagedArchive, "-C", stageRoot, "java-lsp-mcp"], { stdio: "inherit" });
await rm(finalArchive, { force: true });
await rename(stagedArchive, finalArchive);

try {
  await rm(finalRoot, { recursive: true, force: true });
  await rename(stageRoot, finalRoot);
} catch (error) {
  if (error?.code !== "EPERM" && error?.code !== "EBUSY") throw error;
  // Files held open by a running process cannot be replaced. Refresh application
  // files in place and retain an already-installed runtime until VS Code stops.
  await mkdir(join(finalRoot, "java-lsp-mcp"), { recursive: true });
  for (const name of ["app", "bin", "licenses", "README.txt", "manifest.json"]) {
    await rm(join(finalRoot, "java-lsp-mcp", name), { recursive: true, force: true });
    await cp(join(bundle, name), join(finalRoot, "java-lsp-mcp", name), { recursive: true });
  }
  for (const name of ["jdtls", "junit-console", "jacoco", "debug"]) {
    const destination = join(finalRoot, "java-lsp-mcp", "runtime", name);
    if (!await exists(destination)) await cp(join(bundle, "runtime", name), destination, { recursive: true });
  }
  // Remove runtimes left by releases from before they became external prerequisites.
  await rm(join(finalRoot, "java-lsp-mcp", "runtime", "node"), { recursive: true, force: true });
  await rm(join(finalRoot, "java-lsp-mcp", "runtime", "jdk"), { recursive: true, force: true });
  await rm(stageRoot, { recursive: true, force: true });
  process.stderr.write("[java-lsp-mcp] updated application files at stable path; retained runtime files held open by a running process\n");
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}
function commandSucceeds(command, args) {
  try { execFileSync(command, args, { stdio: "ignore" }); return true; } catch { return false; }
}
function isBsdTar() {
  try { return execFileSync("tar", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).startsWith("bsdtar"); } catch { return false; }
}

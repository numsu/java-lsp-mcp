import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { execFileSync } from "node:child_process";

const args = parseArgs(process.argv.slice(2));
const platform = String(args.platform ?? hostPlatform()); const output = resolve(String(args.output ?? ".runtime")); const cache = resolve(String(args.cache ?? join(output, "downloads"))); const lock = JSON.parse(await readFile(new URL("../runtime/versions.lock.json", import.meta.url), "utf8"));
// Java is an external prerequisite. Only application-owned runtimes belong here.
for (const name of ["node", "jdtls", "junit-console", "jacoco"]) {
  const artifact = lock.components[name].artifacts[platform] ?? lock.components[name].artifacts.all;
  if (!artifact) throw new Error(`${name} is unavailable for ${platform}`);
  const archive = join(cache, basename(new URL(artifact.url).pathname)); await mkdir(cache, { recursive: true });
  if (!existsSync(archive) || await hash(archive) !== artifact.sha256) {
    if (args.offline) throw new Error(`Missing verified offline artifact: ${archive}`);
    const partial = `${archive}.part`; await download(artifact.url, partial);
    if (await hash(partial) !== artifact.sha256) { await rm(partial, { force: true }); throw new Error(`SHA-256 mismatch: ${archive}`); }
    await rm(archive, { force: true }); await rename(partial, archive);
  }
  if (await hash(archive) !== artifact.sha256) throw new Error(`SHA-256 mismatch: ${archive}`);
  const target = join(output, name); await rm(target, { recursive: true, force: true }); await mkdir(target, { recursive: true });
  if (name === "junit-console") { await copyFile(archive, join(target, "junit-platform-console-standalone.jar")); continue; }
  extract(archive, target);
  await flatten(target);
  if (name === "jdtls") { const plugins = await import("node:fs/promises").then(fs => fs.readdir(join(target, "plugins"))); const launchers = plugins.filter(n => /^org\.eclipse\.equinox\.launcher_.+\.jar$/u.test(n)); if (launchers.length !== 1) throw new Error("Could not determine Equinox launcher"); await writeFile(join(target, "launcher.lock"), `${launchers[0]}\n`); }
}
async function download(url, path) { const response = await fetch(url, { redirect: "follow" }); if (!response.ok || !response.body) throw new Error(`Download failed: ${response.status} ${url}`); await pipeline(Readable.fromWeb(response.body), createWriteStream(path)); }
async function hash(path) { const h = createHash("sha256"); for await (const chunk of (await import("node:fs")).createReadStream(path)) h.update(chunk); return h.digest("hex"); }
function extract(archive, target) { if (archive.endsWith(".zip")) { if (process.platform !== "win32") execFileSync("unzip", ["-q", archive, "-d", target]); else execFileSync("powershell", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${archive.replaceAll("'", "''")}' -DestinationPath '${target.replaceAll("'", "''")}'`]); } else execFileSync("tar", ["-xzf", archive, "-C", target]); }
async function flatten(target) { const fs = await import("node:fs/promises"); const entries = await fs.readdir(target, { withFileTypes: true }); if (entries.length === 1 && entries[0].isDirectory()) { const nested = join(target, entries[0].name); for (const name of await fs.readdir(nested)) await fs.rename(join(nested, name), join(target, name)); await fs.rmdir(nested); } if (existsSync(join(target, "Contents", "Home"))) { const tmp = `${target}-home`; await fs.rename(join(target, "Contents", "Home"), tmp); await fs.rm(target, { recursive: true }); await fs.rename(tmp, target); } }
function hostPlatform() { const os = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux"; const arch = process.arch === "arm64" ? "arm64" : "x64"; return `${os}-${arch}`; }
function parseArgs(argv) { const result = {}; for (let index = 0; index < argv.length; index++) { const argument = argv[index]; if (argument === "--offline") result.offline = true; else if (["--platform", "--output", "--cache"].includes(argument)) { const value = argv[++index]; if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`); result[argument.slice(2)] = value; } else throw new Error(`Unknown option: ${argument}`); } return result; }

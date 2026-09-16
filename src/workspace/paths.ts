import { realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { JavaLspMcpError } from "../types.js";

export class WorkspacePaths {
  readonly root: string;
  constructor(root: string) {
    this.root = realpathSync(resolve(root));
    if (!statSync(this.root).isDirectory()) throw new JavaLspMcpError("INVALID_WORKSPACE", "Workspace is not a directory");
  }
  resolve(input: string, mustExist = true): string {
    if (!input || input.includes("\0")) throw new JavaLspMcpError("INVALID_PATH", "Invalid workspace path");
    const candidate = resolve(this.root, input);
    const checked = mustExist ? realpathSync(candidate) : this.realExistingParent(candidate);
    if (!this.contains(checked)) throw new JavaLspMcpError("PATH_OUTSIDE_WORKSPACE", `Path escapes workspace: ${input}`);
    return candidate;
  }
  fromUri(uri: string): { path: string; origin: "workspace" | "dependency"; editable: boolean } {
    if (!uri.startsWith("file:")) return { path: dependencyPath(uri), origin: "dependency", editable: false };
    const file = this.realExistingParent(fileURLToPath(uri));
    if (!this.contains(file)) return { path: dependencyPath(uri), origin: "dependency", editable: false };
    return { path: this.relative(file), origin: "workspace", editable: true };
  }
  relative(path: string): string { return relative(this.root, path).split(sep).join("/") || "."; }
  contains(path: string): boolean { return pathWithin(path, this.root); }
  private realExistingParent(candidate: string): string {
    let current = candidate;
    for (;;) {
      try { return resolve(realpathSync(current), relative(current, candidate)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const parent = dirname(current);
        if (parent === current) throw error;
        current = parent;
      }
    }
  }
}

export function foldPath(value: string): string { return process.platform === "win32" ? value.toLowerCase() : value; }
export function pathWithin(child: string, root: string): boolean {
  const path = relative(resolve(root), resolve(child));
  return path === "" || !path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path);
}
export function fileUriWithin(childUri: string, rootUri: string): boolean {
  try { return pathWithin(fileURLToPath(childUri), fileURLToPath(rootUri)); } catch { return false; }
}
function dependencyPath(uri: string): string {
  try {
    const u = new URL(uri);
    return `${u.protocol.slice(0, -1)}:${decodeURIComponent(u.pathname)}`;
  } catch { return uri; }
}

import { readdirSync } from "node:fs";
import { resolve } from "node:path";

export const ignoredDirectories = [".git", ".metadata", ".gradle", "node_modules", "target", "build", "out"] as const;
export const projectConfigurationFiles = ["pom.xml", "build.gradle", "build.gradle.kts", ".project"] as const;
export const watchedProjectFiles = [...projectConfigurationFiles, "settings.gradle", "settings.gradle.kts", ".classpath", "module-info.java"] as const;

export function workspaceFiles(root: string, wanted: (name: string) => boolean, maxDepth = Number.POSITIVE_INFINITY): string[] {
  const found: string[] = []; const ignored = new Set<string>(ignoredDirectories);
  const walk = (directory: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: import("node:fs").Dirent[]; try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isFile() && wanted(entry.name)) found.push(path);
      else if (entry.isDirectory() && !ignored.has(entry.name)) walk(path, depth + 1);
    }
  };
  walk(resolve(root), 0); return found;
}

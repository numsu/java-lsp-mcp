import { basename, dirname } from "node:path";
import { projectConfigurationFiles, workspaceFiles } from "./files.js";

export interface ProjectInfo { kind: "maven" | "gradle" | "eclipse" | "modular" | "unmanaged" | "mixed"; modules: number; descriptors: string[] }
export function discoverProject(root: string): ProjectInfo {
  const wanted = new Set<string>([...projectConfigurationFiles, "module-info.java"]); const descriptors = workspaceFiles(root, name => wanted.has(name), 5);
  const buildKinds = new Set<ProjectInfo["kind"]>(); const moduleRoots = new Set<string>(); let modular = false;
  for (const path of descriptors) {
    const name = basename(path); if (name === "pom.xml") buildKinds.add("maven"); else if (name.startsWith("build.gradle")) buildKinds.add("gradle"); else if (name === ".project") buildKinds.add("eclipse"); else { modular = true; continue; }
    moduleRoots.add(dirname(path));
  }
  const kind = buildKinds.size > 1 ? "mixed" : buildKinds.values().next().value ?? (modular ? "modular" : "unmanaged");
  return { kind, modules: moduleRoots.size || 1, descriptors };
}

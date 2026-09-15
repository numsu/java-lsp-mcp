import { basename, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JavaLspMcpError } from "../types.js";
import { projectConfigurationFiles, workspaceFiles } from "./files.js";
import { foldPath, pathWithin } from "./paths.js";

export function normalizeProjectSelector(value: string): string { const normalized = value.trim().replaceAll("\\", "/").replace(/\/$/u, ""); return normalized || "."; }

export function projectMatches(workspaceRoot: string, projectUri: string, selector: string): boolean {
  try {
    const projectPath = fileURLToPath(projectUri); const relativePath = relative(workspaceRoot, projectPath).split(sep).join("/") || "."; const absolutePath = resolve(projectPath).split(sep).join("/"); const candidates = [relativePath, basename(projectPath), absolutePath];
    return candidates.some(candidate => foldPath(candidate) === foldPath(selector));
  } catch { return false; }
}

export function resolveExcludedProjectRoots(workspaceRoot: string, rawSelectors: string[]): { roots: string[]; missing: string[] } {
  const selectors = [...new Set(rawSelectors.map(normalizeProjectSelector).filter(Boolean))]; if (!selectors.length) return { roots: [], missing: [] }; const directories = workspaceProjectDirectories(workspaceRoot); const roots: string[] = []; const missing: string[] = [];
  for (const selector of selectors) { const matched = directories.filter(directory => projectMatches(workspaceRoot, pathToFileURL(directory).href, selector)); if (!matched.length) missing.push(selector); else for (const directory of matched) roots.push(pathToFileURL(directory).href); }
  return { roots: [...new Set(roots)], missing };
}

export function projectConfigurationUris(workspaceRoot: string, rawSelectors: string[]): string[] | undefined {
  if (!rawSelectors.length) return undefined;
  const excluded = resolveExcludedProjectRoots(workspaceRoot, rawSelectors);
  if (excluded.missing.length) throw new JavaLspMcpError("EXCLUDED_PROJECT_NOT_FOUND", `Excluded project not found in workspace: ${excluded.missing.join(", ")}`);
  const excludedPaths = excluded.roots.map(uri => fileURLToPath(uri));
  const configurations = workspaceProjectConfigurations(workspaceRoot).filter(configuration => {
    const directory = resolve(configuration, "..");
    if (excludedPaths.some(root => pathWithin(directory, root))) return false;
    // M2E expands an aggregator pom to every reactor child. Omit aggregators
    // above an excluded module and import the selected child poms directly.
    if (basename(configuration) === "pom.xml" && excludedPaths.some(root => pathWithin(root, directory) && root !== directory)) return false;
    return true;
  });
  return configurations.map(path => pathToFileURL(path).href);
}

export function workspaceProjectDirectories(workspaceRoot: string): string[] { return [...new Set([resolve(workspaceRoot), ...workspaceProjectConfigurations(workspaceRoot).map(path => resolve(path, ".."))])]; }

function workspaceProjectConfigurations(workspaceRoot: string): string[] {
  const wanted = new Set<string>(projectConfigurationFiles); return workspaceFiles(workspaceRoot, name => wanted.has(name));
}

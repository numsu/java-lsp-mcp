import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { JavaLspMcpError } from "../types.js";
import type { WorkspacePaths } from "./paths.js";

const aliases: Record<string, string> = {
  utf8: "utf-8",
  "utf_8": "utf-8",
  cp1252: "windows-1252",
  windows1252: "windows-1252",
  latin1: "windows-1252",
};

export class SourceDecoder {
  constructor(private readonly paths: WorkspacePaths, private readonly override?: string) {
    if (override) createDecoder(override);
  }

  async read(path: string): Promise<string> {
    const bytes = await readFile(path);
    const configured = this.override ?? await this.eclipseEncoding(path);
    if (configured) return decode(bytes, configured, path);
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new JavaLspMcpError("SOURCE_ENCODING_REQUIRED", `Source file is not valid UTF-8: ${this.paths.relative(path)}. Configure Eclipse project encoding or restart with --source-encoding <encoding>`); }
  }

  async readLenient(path: string): Promise<{ content: string; warning?: { code: string; message: string } }> {
    const bytes = await readFile(path);
    const configured = this.override ?? await this.eclipseEncoding(path);
    if (configured) {
      try { return { content: decode(bytes, configured, path) }; }
      catch (error) {
        if (!(error instanceof JavaLspMcpError) || error.code === "UNSUPPORTED_SOURCE_ENCODING") throw error;
        return { content: new TextDecoder("windows-1252").decode(bytes), warning: { code: error.code, message: `Source could not be decoded as ${configured}; Windows-1252 was used only for declaration indexing` } };
      }
    }
    try { return { content: new TextDecoder("utf-8", { fatal: true }).decode(bytes) }; }
    catch {
      return { content: new TextDecoder("windows-1252").decode(bytes), warning: { code: "SOURCE_ENCODING_FALLBACK", message: "Source is not valid UTF-8; Windows-1252 was used for declaration indexing. Configure Eclipse project encoding or --source-encoding for exact source text" } };
    }
  }

  private async eclipseEncoding(path: string): Promise<string | undefined> {
    let directory = dirname(path);
    for (;;) {
      const preferences = join(directory, ".settings", "org.eclipse.core.resources.prefs");
      if (existsSync(preferences)) {
        const encoding = resourceEncoding(await readFile(preferences, "utf8"), directory, path);
        if (encoding) return encoding;
      }
      if (resolve(directory) === resolve(this.paths.root)) return undefined;
      const parent = dirname(directory);
      if (parent === directory || !this.paths.contains(parent)) return undefined;
      directory = parent;
    }
  }
}

function resourceEncoding(text: string, projectRoot: string, path: string): string | undefined {
  const resource = `/${relative(projectRoot, path).split(sep).join("/")}`;
  let projectDefault: string | undefined; let selected: { path: string; encoding: string } | undefined;
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim(); if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    const separator = line.indexOf("="); if (separator < 0) continue;
    const key = line.slice(0, separator).trim(); const encoding = line.slice(separator + 1).trim();
    if (!encoding || !key.startsWith("encoding/")) continue;
    const target = key.slice("encoding/".length);
    if (target === "<project>") { projectDefault = encoding; continue; }
    const normalized = target.startsWith("/") ? target : `/${target}`;
    if ((resource === normalized || resource.startsWith(`${normalized}/`)) && (!selected || normalized.length > selected.path.length)) selected = { path: normalized, encoding };
  }
  return selected?.encoding ?? projectDefault;
}

function createDecoder(label: string): TextDecoder {
  const normalized = aliases[label.trim().toLowerCase()] ?? label.trim();
  try { return new TextDecoder(normalized, { fatal: true }); }
  catch { throw new JavaLspMcpError("UNSUPPORTED_SOURCE_ENCODING", `Unsupported source encoding: ${label}`); }
}

function decode(bytes: Uint8Array, encoding: string, path: string): string {
  try { return createDecoder(encoding).decode(bytes); }
  catch (error) {
    if (error instanceof JavaLspMcpError) throw error;
    throw new JavaLspMcpError("SOURCE_DECODING_FAILED", `Could not decode ${path} as ${encoding}`);
  }
}

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Logger } from "../logging.js";
import { JavaLspMcpError } from "../types.js";
import type { WorkspacePaths } from "./paths.js";

const aliases: Record<string, string> = {
  utf8: "utf-8",
  "utf_8": "utf-8",
  cp1252: "windows-1252",
  windows1252: "windows-1252",
  latin1: "windows-1252",
};

interface DecodedSource { content: string; warning?: { code: string; message: string } }

export class SourceDecoder {
  constructor(private readonly paths: WorkspacePaths, private readonly override?: string, private readonly logger = new Logger("warn")) {
    if (override) createDecoder(override);
  }

  async read(path: string): Promise<string> {
    const bytes = await readFile(path);
    const configured = this.override ?? await this.eclipseEncoding(path);
    if (configured) return decode(bytes, configured, path);
    const decoded = decodeDefault(bytes);
    if (decoded.warning) this.logger.warn(decoded.warning.message, { code: decoded.warning.code, path: this.paths.relative(path) });
    return decoded.content;
  }

  async readLenient(path: string): Promise<DecodedSource> {
    const bytes = await readFile(path);
    const configured = this.override ?? await this.eclipseEncoding(path);
    if (configured) {
      try { return { content: decode(bytes, configured, path) }; }
      catch (error) {
        if (!(error instanceof JavaLspMcpError) || error.code === "UNSUPPORTED_SOURCE_ENCODING") throw error;
        return { content: decodeBytes(bytes, createDecoder("windows-1252")), warning: { code: error.code, message: `Source could not be decoded as ${configured}; Windows-1252 was used only for declaration indexing` } };
      }
    }
    return decodeDefault(bytes);
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

function decodeDefault(bytes: Uint8Array): DecodedSource {
  try { return { content: decodeBytes(bytes, createDecoder("utf-8")) }; }
  catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return { content: decodeBytes(bytes, createDecoder("windows-1252")), warning: { code: "SOURCE_ENCODING_FALLBACK", message: "Source is not valid UTF-8; Windows-1252 was used. Configure Eclipse project encoding or --source-encoding if a different encoding is needed" } };
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

function decodeBytes(bytes: Uint8Array, decoder: TextDecoder): string {
  // Streaming avoids Node's Windows-1252 fast path decoding C1 bytes as Latin-1.
  return decoder.decode(bytes, { stream: true }) + decoder.decode();
}

function decode(bytes: Uint8Array, encoding: string, path: string): string {
  try { return decodeBytes(bytes, createDecoder(encoding)); }
  catch (error) {
    if (error instanceof JavaLspMcpError) throw error;
    throw new JavaLspMcpError("SOURCE_DECODING_FAILED", `Could not decode ${path} as ${encoding}`);
  }
}

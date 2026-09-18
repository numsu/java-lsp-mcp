import { Transform } from "node:stream";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/server";

// The SDK exports the legacy (2025-era and older) handshake list but not the
// modern list, so the modern revisions we can serve natively are pinned here
// and covered by the protocol handshake tests. Extend this when the SDK gains
// a newer wire revision.
export const LATEST_KNOWN_MODERN = "2026-07-28";
const KNOWN_MODERN = [LATEST_KNOWN_MODERN];
const CLAIM_KEY = "io.modelcontextprotocol/protocolVersion";

/**
 * Leniently normalize one newline-delimited JSON-RPC message. Envelope claims
 * naming a newer revision than we know are served as the latest known modern
 * revision (the modern wire codec is many-to-one) with a warning instead of
 * an unsupported-version error. Everything else — including legacy
 * `initialize` handshakes, which the server already negotiates down
 * gracefully — passes through byte-identical.
 */
export function normalizeHandshakeLine(line: string, warn: (message: string) => void): string {
  let message: unknown;
  try { message = JSON.parse(line); } catch { return line; }
  if (!message || typeof message !== "object" || Array.isArray(message)) return line;
  const params = (message as { params?: unknown }).params;
  if (params && typeof params === "object" && !Array.isArray(params)) {
    const meta = (params as Record<string, unknown>)._meta;
    const claimed = meta && typeof meta === "object" && !Array.isArray(meta) ? (meta as Record<string, unknown>)[CLAIM_KEY] : undefined;
    if (typeof claimed === "string" && !KNOWN_MODERN.includes(claimed) && claimed >= LATEST_KNOWN_MODERN) {
      warn(`Unsupported MCP protocol version ${claimed}; serving as ${LATEST_KNOWN_MODERN}`);
      return JSON.stringify({ ...message, params: { ...(params as Record<string, unknown>), _meta: { ...(meta as Record<string, unknown>), [CLAIM_KEY]: LATEST_KNOWN_MODERN } } });
    }
    if ((message as { method?: unknown }).method === "initialize") {
      const requested = (params as Record<string, unknown>).protocolVersion;
      if (typeof requested === "string" && !SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) warn(`Unknown MCP initialize version ${requested}; negotiating a supported revision`);
    }
  }
  return line;
}

/**
 * Wrap stdin so every inbound message passes through {@link normalizeHandshakeLine}.
 * Callers must release the pipe on shutdown (unpipe, destroy the wrapper, pause
 * the source): transport close only pauses the wrapper, which would otherwise
 * leave the source stream flowing and the process alive.
 */
export function lenientStdin(source: NodeJS.ReadableStream, warn: (message: string) => void): Transform {
  const warned = new Set<string>();
  const once = (message: string): void => { if (!warned.has(message)) { warned.add(message); warn(message); } };
  let buffered = "";
  const normalized = new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
      buffered += chunk.toString("utf8");
      const parts = buffered.split("\n");
      buffered = parts.pop() ?? "";
      for (const part of parts) this.push(`${normalizeHandshakeLine(part, once)}\n`);
      callback();
    },
    flush(callback: () => void) {
      if (buffered) this.push(buffered);
      callback();
    },
  });
  source.pipe(normalized);
  return normalized;
}

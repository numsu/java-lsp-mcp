import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { JavaLspMcpError } from "../types.js";

interface CursorData { q: string; o: number; g: number; e: number }
export class CursorSigner {
  constructor(private readonly secret = randomBytes(32), private readonly ttlMs = 300_000) {}
  sign(queryFingerprint: string, offset: number, generation: number, now = Date.now()): string {
    const body = Buffer.from(JSON.stringify({ q: queryFingerprint, o: offset, g: generation, e: now + this.ttlMs } satisfies CursorData)).toString("base64url");
    return `${body}.${this.mac(body)}`;
  }
  verify(cursor: string, queryFingerprint: string, generation: number, now = Date.now()): number {
    const [body, signature, extra] = cursor.split(".");
    if (!body || !signature || extra) throw new JavaLspMcpError("INVALID_CURSOR", "Malformed cursor");
    const expected = Buffer.from(this.mac(body));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new JavaLspMcpError("INVALID_CURSOR", "Invalid cursor signature");
    let data: CursorData;
    try { data = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as CursorData; }
    catch { throw new JavaLspMcpError("INVALID_CURSOR", "Malformed cursor payload"); }
    if (data.q !== queryFingerprint) throw new JavaLspMcpError("CURSOR_QUERY_MISMATCH", "Cursor belongs to a different query");
    if (data.g !== generation) throw new JavaLspMcpError("STALE_CURSOR", "Workspace index changed; restart pagination");
    if (data.e < now) throw new JavaLspMcpError("EXPIRED_CURSOR", "Cursor expired");
    return data.o;
  }
  private mac(body: string): string { return createHmac("sha256", this.secret).update(body).digest("base64url"); }
}

export function fingerprint(value: unknown): string { return createHmac("sha256", "java-lsp-mcp-query").update(stable(value)).digest("base64url"); }
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  return JSON.stringify(value);
}

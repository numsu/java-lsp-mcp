import { randomBytes } from "node:crypto";
import type { CodeAction } from "../jdtls/protocol.js";
import { JavaLspMcpError } from "../types.js";
export class ActionHandles {
  private readonly actions = new Map<string, { action: CodeAction; expires: number; generation: number }>();
  put(action: CodeAction, generation: number): string { const now = Date.now(); for (const [id, value] of this.actions) if (value.expires < now) this.actions.delete(id); const id = randomBytes(18).toString("base64url"); this.actions.set(id, { action, generation, expires: now + 300_000 }); return id; }
  take(id: string, generation: number): CodeAction {
    const value = this.actions.get(id);
    if (!value || value.expires < Date.now() || value.generation !== generation) { this.actions.delete(id); throw new JavaLspMcpError("STALE_ACTION", "Code action handle is stale or expired; request actions again"); }
    return value.action;
  }
}

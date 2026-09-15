import { createServer } from "node:http";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { buildMcpServer } from "../../src/mcp/server.js";
import type { JavaService } from "../../src/mcp/service.js";
import { Logger } from "../../src/logging.js";
import { loadConfig } from "../../src/config/config.js";

const empty = {
  status: () => ({ state: "failed", projectKind: "unmanaged", modules: 1, compiler: "ecj", mcpRevision: "2026-07-28", jdtVersion: "unavailable", toolingJdk: "test", projectJdk: "test", trusted: false, offline: true }),
  outline: async () => ({ symbols: [] }), search: async () => ({ symbols: [] }), definition: async () => ({ definitions: [] }), references: async () => ({ references: [] }), callHierarchy: async () => ({ root: {}, nodes: [], edges: [] }), typeHierarchy: async () => ({ root: {}, nodes: [], edges: [] }), diagnostics: async () => ({ status: "final", diagnostics: [], counts: {} }), compile: async () => ({ kind: "incremental", buildStatus: "succeeded", durationMs: 0, complete: true, success: true, diagnosticsComplete: true, counts: {}, diagnostics: [] }), codeActions: async () => ({ actions: [] }), editPreview: async () => ({ files: [], editCount: 0 }),
} as unknown as JavaService;
const config = loadConfig(process.cwd(), { offline: true }); const logger = new Logger("error"); const handler = createMcpHandler(() => buildMcpServer(empty, config, logger), { legacy: "reject" });
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); const request = new Request(`http://127.0.0.1:3219${req.url ?? "/mcp"}`, { method: req.method ?? "POST", headers: new Headers(Object.entries(req.headers).flatMap(([k, v]) => v === undefined ? [] : [[k, Array.isArray(v) ? v.join(",") : v]])), ...(chunks.length && { body: Buffer.concat(chunks) }) }); const response = await handler.fetch(request); res.statusCode = response.status; response.headers.forEach((v, k) => res.setHeader(k, v)); if (response.body) for await (const chunk of response.body) res.write(chunk); res.end();
});
server.listen(3219, "127.0.0.1"); const close = (): void => { server.close(() => void handler.close()); }; process.once("SIGTERM", close); process.once("SIGINT", close);

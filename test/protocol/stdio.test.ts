import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} };
function start(): { child: ChildProcessWithoutNullStreams; next: () => Promise<Record<string, unknown>> } {
  const child = spawn(process.execPath, [resolve("dist/server.mjs"), "serve", "--workspace", resolve("test/fixtures/unmanaged"), "--tooling-jdk", resolve("missing-jdk"), "--jdtls-home", resolve("missing-jdtls"), "--timeout", "25"], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, JAVA_LSP_MCP_CACHE_DIR: resolve(".runtime/test-cache") } });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  return { child, next: async () => JSON.parse((await lines.next()).value as string) as Record<string, unknown> };
}
test("modern stdio discovery and static tools list", async () => {
  const { child, next } = start();
  try {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: meta } })}\n`); const discover = await next(); const result = discover.result as Record<string, unknown>; assert.deepEqual(result.supportedVersions, ["2026-07-28"]);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: meta } })}\n`); const listed = (await next()).result as { tools: Array<Record<string, unknown>> }; assert.equal(listed.tools.length, 14); assert.ok(Buffer.byteLength(JSON.stringify(listed)) < 24_000); assert.equal((listed.tools[0]!.annotations as Record<string, unknown>).readOnlyHint, true); assert.equal("outputSchema" in listed.tools[0]!, false); const status = listed.tools.find(t => t.name === "java_status")!; assert.ok("waitForReady" in (status.inputSchema as { properties: Record<string, unknown> }).properties); const definition = listed.tools.find(t => t.name === "java_find_definition")!; const target = ((definition.inputSchema as { properties: Record<string, unknown> }).properties.target as Record<string, unknown>); assert.ok(Array.isArray(target.oneOf));
  } finally { child.kill(); }
});
test("VS Code's 2025-11-25 initialize and tool callbacks are supported", async () => {
  const { child, next } = start(); try {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "vscode", version: "1" } } })}\n`); const response = await next(); const result = response.result as Record<string, unknown>; assert.equal(result.protocolVersion, "2025-11-25"); assert.equal((result.serverInfo as Record<string, unknown>).name, "java-lsp-mcp"); assert.match(String(result.instructions), /java_status.*waitForReady=true/u);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "java_status", arguments: { waitForReady: true, timeoutMs: 100 } } })}\n`); const status = (await next()).result as { content: Array<{ text: string }>; structuredContent: { state: string }; isError?: boolean }; assert.notEqual(status.isError, true); assert.equal(status.structuredContent.state, "failed"); assert.equal(status.content[0]?.text, "failed"); assert.doesNotMatch(status.content[0]!.text, /java_status/u);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "java_outline", arguments: { path: "src/Overloads.java", depth: 2, visibility: ["public", "package", "private"], kinds: ["class", "constructor", "method"], format: "compact", limit: 100, cursor: null } } })}\n`); const tool = (await next()).result as { content: Array<{ text: string }>; isError?: boolean }; assert.equal(tool.isError, true); assert.match(tool.content[0]!.text, /JDT_NOT_READY/u); assert.doesNotMatch(tool.content[0]!.text, /reading 'aborted'/u);
  } finally { child.kill(); }
});

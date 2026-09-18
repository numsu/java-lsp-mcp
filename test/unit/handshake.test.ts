import test from "node:test";
import assert from "node:assert/strict";
import { LATEST_KNOWN_MODERN, lenientStdin, normalizeHandshakeLine } from "../../src/mcp/handshake.js";

const CLAIM = "io.modelcontextprotocol/protocolVersion";
const discover = (version: unknown): string => JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: { [CLAIM]: version, "io.modelcontextprotocol/clientInfo": { name: "probe", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } } });
const initialize = (protocolVersion?: unknown): string => JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { ...(protocolVersion !== undefined && { protocolVersion }), capabilities: {}, clientInfo: { name: "probe", version: "1" } } });

test("a future envelope claim is served as the latest known revision with a warning", () => {
  const warnings: string[] = [];
  const result = normalizeHandshakeLine(discover("2030-05-05"), message => warnings.push(message));
  assert.equal(JSON.parse(result).params._meta[CLAIM], LATEST_KNOWN_MODERN);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /2030-05-05/u);
});

test("known claims and legacy handshakes pass through untouched", () => {
  const warnings: string[] = [];
  const warn = (message: string): void => { warnings.push(message); };
  assert.equal(normalizeHandshakeLine(discover("2026-07-28"), warn), discover("2026-07-28"));
  assert.equal(normalizeHandshakeLine(discover("2025-11-25"), warn), discover("2025-11-25"));
  assert.equal(normalizeHandshakeLine(initialize("2024-11-05"), warn), initialize("2024-11-05"));
  assert.equal(normalizeHandshakeLine(initialize(), warn), initialize());
  assert.deepEqual(warnings, []);
});

test("an unknown initialize version warns but leaves negotiation to the server", () => {
  const warnings: string[] = [];
  const line = initialize("1999-01-01");
  assert.equal(normalizeHandshakeLine(line, message => warnings.push(message)), line);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /1999-01-01/u);
});

test("non-JSON and non-object lines pass through untouched", () => {
  const warnings: string[] = [];
  const warn = (message: string): void => { warnings.push(message); };
  for (const line of ["not json", "", "[1,2]", "42", '"claim"']) assert.equal(normalizeHandshakeLine(line, warn), line);
  assert.equal(normalizeHandshakeLine(discover(42), warn), discover(42));
  assert.deepEqual(warnings, []);
});

test("the stdin wrapper reassembles chunked lines and warns once per version", async () => {
  const warnings: string[] = [];
  const { Readable } = await import("node:stream");
  const source = new Readable({ read() {} });
  const wrapped = lenientStdin(source, message => warnings.push(message));
  const output: string[] = [];
  wrapped.on("data", chunk => output.push(chunk.toString("utf8")));
  const first = discover("2030-05-05");
  source.push(`${first.slice(0, 20)}`);
  source.push(`${first.slice(20)}\n${initialize("2024-11-05")}\n${discover("2030-05-05")}\n`);
  source.push(null);
  await new Promise(resolve => setTimeout(resolve, 50));
  const text = output.join("");
  assert.equal(text.split("\n").filter(Boolean).length, 3);
  assert.equal((text.match(new RegExp(LATEST_KNOWN_MODERN.replaceAll(".", "\\."), "gu")) ?? []).length, 2);
  assert.ok(!text.includes("2030-05-05"));
  assert.deepEqual(warnings, [`Unsupported MCP protocol version 2030-05-05; serving as ${LATEST_KNOWN_MODERN}`]);
});

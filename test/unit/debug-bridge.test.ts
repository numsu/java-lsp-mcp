import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { outputs } from "../../src/mcp/schemas.js";

const java = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", process.platform === "win32" ? "java.exe" : "java") : "";

test("JDI bridge source-launches and returns protocol JSON", { skip: !java || !existsSync(java), timeout: 30_000 }, () => {
  const request = `1\ttargets\t\t${Buffer.from("false").toString("base64url")}\n`;
  const result = spawnSync(java, ["--add-modules", "jdk.jdi,jdk.attach", resolve("java-debug-bridge", "DebugBridge.java")], { input: request, encoding: "utf8", timeout: 25_000 });
  assert.equal(result.status, 0, result.stderr);
  const [id, status, payload] = result.stdout.trim().split("\t");
  assert.equal(id, "1"); assert.equal(status, "OK");
  const value = outputs.java_debug_targets.parse(JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"))) as { targets: unknown[] };
  assert.ok(Array.isArray(value.targets));
});

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("Node.js is an external prerequisite, not a bundled runtime", () => {
  const lock = JSON.parse(readFileSync(resolve("runtime/versions.lock.json"), "utf8")) as { components: Record<string, { version: string }> };
  assert.ok(!("node" in lock.components), "versions.lock.json must not pin a Node.js runtime");
  assert.deepEqual(Object.keys(lock.components).sort(), ["jacoco", "jdtls", "junit-console", "mcp-conformance"]);
  const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { engines: { node: string } };
  assert.match(pkg.engines.node, /^\s*>=\s*24/u);
  const release = readFileSync(resolve("scripts/build-release.mjs"), "utf8");
  assert.ok(!release.includes("runtime/node"), "release launchers must not reference a bundled node");
  const fetch = readFileSync(resolve("scripts/fetch-runtime.mjs"), "utf8");
  assert.ok(!fetch.includes('"node"'), "fetch-runtime must not download node");
});

test("doctor reports the Node.js prerequisite", () => {
  const result = spawnSync(process.execPath, [resolve("dist/server.mjs"), "doctor", "--workspace", resolve("test/fixtures/unmanaged")], { encoding: "utf8" });
  assert.match(result.stdout, /^OK Node\.js: /mu);
});

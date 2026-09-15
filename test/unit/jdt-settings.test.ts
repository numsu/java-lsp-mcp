import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { jdtImportExclusions } from "../../src/jdtls/client.js";
import { projectConfigurationUris } from "../../src/workspace/projects.js";

test("startup project exclusions are also JDT import exclusions", () => {
  const workspace = resolve("workspace");
  assert.deepEqual(jdtImportExclusions(workspace, ["tests", "modules/legacy", resolve(workspace, "generated")]), ["**/tests/**", "**/modules/legacy/**", "**/generated/**"]);
});

test("selective project configurations omit excluded Maven modules and their aggregator", () => {
  const workspace = resolve("test/fixtures/selective-maven");
  const configurations = projectConfigurationUris(workspace, ["excluded"])?.map(uri => new URL(uri).pathname.replace(/^\/[A-Za-z]:/u, value => value.slice(1)).replaceAll("/", "\\"));
  assert.ok(configurations?.some(path => path.endsWith("included\\pom.xml"))); assert.ok(!configurations?.some(path => path.endsWith("selective-maven\\pom.xml"))); assert.ok(!configurations?.some(path => path.endsWith("excluded\\pom.xml")));
});

test("unknown project exclusions fail during initialization", () => {
  const workspace = resolve("test/fixtures/selective-maven");
  assert.throws(() => projectConfigurationUris(workspace, ["typo"]), /Excluded project not found/u);
});

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { LspClient } from "../../src/jdtls/client.js";
import { JavaService } from "../../src/mcp/service.js";
import type { WorkspaceSynchronizer } from "../../src/workspace/watcher.js";
import { WorkspacePaths } from "../../src/workspace/paths.js";

const root = resolve(".tmp-update-projects-test");
const config = { workspace: root, offline: true, trustWorkspace: true, maxHeap: "1g", resultMode: "structured", logLevel: "error", timeoutMs: 1000, resultBudget: 12_000 } as const;

after(() => { rmSync(root, { recursive: true, force: true }); });

function fixture(): WorkspacePaths {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "a", "src"), { recursive: true });
  writeFileSync(join(root, "a", "pom.xml"), "<project/>");
  writeFileSync(join(root, "a", "src", "Main.java"), "class Main {}");
  mkdirSync(join(root, "b"), { recursive: true });
  writeFileSync(join(root, "b", "build.gradle"), "plugins {}");
  return new WorkspacePaths(root);
}

function service(paths: WorkspacePaths, client: object, extraConfig: object = {}): { service: JavaService; sync: { indexGeneration: number } } {
  const sync = { indexGeneration: 1 } as unknown as WorkspaceSynchronizer & { indexGeneration: number };
  return { service: new JavaService({ ...config, ...extraConfig }, paths, sync, client as LspClient), sync };
}

test("targeted update resolves Maven and Gradle descriptors from source and descriptor paths", async () => {
  const paths = fixture();
  const updated: string[] = [];
  const client = { state: "ready", ready: true, waitReady: async () => true, updateProjectConfiguration: async (uri: string) => { updated.push(uri); }, importProjects: async () => { throw new Error("must not run a full reimport"); } };
  const { service: update, sync } = service(paths, client);
  const result = await update.updateProjects({ paths: ["a/src/Main.java", "b/build.gradle"], all: false, force: false, timeoutMs: 1000 }) as { projects: object[]; durationMs: number; ready: boolean };
  assert.deepEqual(updated, [pathToFileURL(paths.resolve("a/pom.xml")).href, pathToFileURL(paths.resolve("b/build.gradle")).href]);
  assert.deepEqual(result.projects, [{ path: "a/pom.xml", updated: true }, { path: "b/build.gradle", updated: true }]);
  assert.equal(result.ready, true);
  assert.equal(typeof result.durationMs, "number");
  assert.equal(sync.indexGeneration, 2);
});

test("duplicate selectors in one project update once", async () => {
  const paths = fixture();
  const updated: string[] = [];
  const client = { state: "ready", ready: true, waitReady: async () => true, updateProjectConfiguration: async (uri: string) => { updated.push(uri); }, importProjects: async () => { throw new Error("must not run a full reimport"); } };
  const { service: update } = service(paths, client);
  const result = await update.updateProjects({ paths: ["a/pom.xml", "a"], all: false, force: false, timeoutMs: 1000 }) as { projects: object[] };
  assert.deepEqual(updated, [pathToFileURL(paths.resolve("a/pom.xml")).href]);
  assert.deepEqual(result.projects, [{ path: "a/pom.xml", updated: true }]);
});

test("force runs a full workspace reimport and lists imported projects", async () => {
  const paths = fixture();
  let imported = false;
  const client = {
    state: "ready", ready: true, waitReady: async () => true,
    updateProjectConfiguration: async () => { throw new Error("must not run targeted updates"); },
    importProjects: async () => { imported = true; },
    projects: async () => [pathToFileURL(paths.resolve("a")).href, pathToFileURL(paths.resolve("b")).href],
  };
  const { service: update, sync } = service(paths, client);
  const result = await update.updateProjects({ all: false, force: true, timeoutMs: 1000 }) as { projects: object[]; ready: boolean };
  assert.equal(imported, true);
  assert.deepEqual(result.projects, [{ path: "a/pom.xml", updated: true }, { path: "b/build.gradle", updated: true }]);
  assert.equal(result.ready, true);
  assert.equal(sync.indexGeneration, 2);
});

test("missing paths are reported per project without failing the batch", async () => {
  const paths = fixture();
  const updated: string[] = [];
  const client = { state: "ready", ready: true, waitReady: async () => true, updateProjectConfiguration: async (uri: string) => { updated.push(uri); }, importProjects: async () => { throw new Error("must not run a full reimport"); } };
  const { service: update, sync } = service(paths, client);
  const result = await update.updateProjects({ paths: ["missing/pom.xml"], all: false, force: false, timeoutMs: 1000 }) as { projects: Array<{ path: string; updated: boolean; message?: string }>; ready: boolean };
  assert.deepEqual(updated, []);
  assert.equal(result.projects.length, 1);
  assert.equal(result.projects[0]?.updated, false);
  assert.match(result.projects[0]?.message ?? "", /does not exist/u);
  assert.equal(sync.indexGeneration, 1);
});

test("excluded projects are skipped with an explicit message", async () => {
  const paths = fixture();
  const updated: string[] = [];
  const client = { state: "ready", ready: true, waitReady: async () => true, updateProjectConfiguration: async (uri: string) => { updated.push(uri); }, importProjects: async () => { throw new Error("must not run a full reimport"); } };
  const { service: update } = service(paths, client, { excludedProjects: ["b"] });
  const result = await update.updateProjects({ paths: ["b/build.gradle"], all: false, force: false, timeoutMs: 1000 }) as { projects: Array<{ path: string; updated: boolean; message?: string }> };
  assert.deepEqual(updated, []);
  assert.equal(result.projects[0]?.updated, false);
  assert.match(result.projects[0]?.message ?? "", /excluded/u);
});

test("all:true updates every non-excluded descriptor without asking JDT", async () => {
  const paths = fixture();
  const updated: string[] = [];
  const client = { state: "ready", ready: true, waitReady: async () => true, updateProjectConfiguration: async (uri: string) => { updated.push(uri); }, importProjects: async () => { throw new Error("must not run a full reimport"); }, projects: async () => { throw new Error("must not enumerate JDT projects"); } };
  const { service: update } = service(paths, client);
  const result = await update.updateProjects({ all: true, force: false, timeoutMs: 1000 }) as { projects: object[]; ready: boolean };
  assert.deepEqual(updated, [pathToFileURL(paths.resolve("a/pom.xml")).href, pathToFileURL(paths.resolve("b/build.gradle")).href]);
  assert.deepEqual(result.projects, [{ path: "a/pom.xml", updated: true }, { path: "b/build.gradle", updated: true }]);
  assert.equal(result.ready, true);
});

test("a wildcard path updates every non-excluded descriptor", async () => {
  const paths = fixture();
  const updated: string[] = [];
  const client = { state: "ready", ready: true, waitReady: async () => true, updateProjectConfiguration: async (uri: string) => { updated.push(uri); }, importProjects: async () => { throw new Error("must not run a full reimport"); } };
  const { service: update } = service(paths, client);
  const result = await update.updateProjects({ paths: ["*"], all: false, force: false, timeoutMs: 1000 }) as { projects: object[] };
  assert.deepEqual(updated, [pathToFileURL(paths.resolve("a/pom.xml")).href, pathToFileURL(paths.resolve("b/build.gradle")).href]);
  assert.deepEqual(result.projects, [{ path: "a/pom.xml", updated: true }, { path: "b/build.gradle", updated: true }]);
});

test("all:true skips projects excluded at startup", async () => {
  const paths = fixture();
  const updated: string[] = [];
  const client = { state: "ready", ready: true, waitReady: async () => true, updateProjectConfiguration: async (uri: string) => { updated.push(uri); }, importProjects: async () => { throw new Error("must not run a full reimport"); } };
  const { service: update } = service(paths, client, { excludedProjects: ["b"] });
  const result = await update.updateProjects({ all: true, force: false, timeoutMs: 1000 }) as { projects: Array<{ path: string; updated: boolean; message?: string }> };
  assert.deepEqual(updated, [pathToFileURL(paths.resolve("a/pom.xml")).href]);
  assert.deepEqual(result.projects, [{ path: "a/pom.xml", updated: true }, { path: "b/build.gradle", updated: false, message: "Project is excluded at startup via --exclude-project" }]);
});

test("updating without workspace trust is rejected", async () => {
  const paths = fixture();
  const client = { state: "ready", ready: true, waitReady: async () => true, updateProjectConfiguration: async () => {}, importProjects: async () => {} };
  const { service: update } = service(paths, client, { trustWorkspace: false });
  const error = await update.updateProjects({ all: false, force: false, timeoutMs: 1000 }).then(() => undefined, error => error as { code?: string });
  assert.equal(error?.code, "UNTRUSTED_WORKSPACE");
});

test("update-projects schemas have bounded safe defaults", async () => {
  const { inputs, outputs } = await import("../../src/mcp/schemas.js");
  const parsed = inputs.java_update_projects.parse({});
  assert.equal(parsed.force, false);
  assert.equal(parsed.all, false);
  assert.equal(parsed.timeoutMs, 120_000);
  assert.equal(parsed.paths, undefined);
  assert.equal(inputs.java_update_projects.safeParse({ paths: [] }).success, false);
  assert.equal(inputs.java_update_projects.safeParse({ paths: ["a/pom.xml"], force: true }).success, true);
  assert.equal(inputs.java_update_projects.safeParse({ all: true }).success, true);
  assert.equal(inputs.java_update_projects.safeParse({ paths: ["*"] }).success, true);
  assert.equal(inputs.java_update_projects.safeParse({ all: true, paths: ["a/pom.xml"] }).success, false);
  assert.deepEqual(outputs.java_update_projects.parse({ projects: [{ path: "a/pom.xml", updated: true }], durationMs: 5, ready: true }).ready, true);
});

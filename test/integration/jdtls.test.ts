import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { loadConfig } from "../../src/config/config.js";
import { Logger } from "../../src/logging.js";
import { JdtSupervisor } from "../../src/jdtls/supervisor.js";
import { WorkspacePaths } from "../../src/workspace/paths.js";
import { SnapshotStore } from "../../src/workspace/snapshots.js";
import { JavaService } from "../../src/mcp/service.js";
import type { WorkspaceSynchronizer } from "../../src/workspace/watcher.js";

test("real JDT LS starts with ECJ configuration", { skip: !process.env.JAVA_LSP_MCP_INTEGRATION }, async () => {
  process.env.JAVA_LSP_MCP_CACHE_DIR = resolve(".runtime/cache");
  if (!process.env.JAVA_HOME) throw new Error("JAVA_HOME must point to an external JDK for integration tests");
  const workspace = resolve("test/fixtures/unmanaged"); const config = loadConfig(workspace, { trustWorkspace: true, toolingJdk: process.env.JAVA_HOME, timeoutMs: 120_000 }); const supervisor = new JdtSupervisor(config, new Logger("error"));
  const source = resolve(workspace, "src/Overloads.java"); const before = await readFile(source, "utf8");
  try {
    await supervisor.start(); assert.equal(await supervisor.client.waitReady(120_000), true); assert.notEqual(supervisor.client.serverVersion, "unknown");
    const paths = new WorkspacePaths(workspace); const snapshots = new SnapshotStore(paths);
    const overloads = (await snapshots.verify("src/Overloads.java")).snapshot; await supervisor.client.syncDocument(overloads); const outline = await supervisor.client.extendedOutline(overloads.uri, 30_000); const root = outline.find(symbol => symbol.name === "Overloads"); assert.ok(root); assert.ok((root.children?.length ?? 0) >= 3, "outline should include the overloaded methods, not only the top-level declaration");
    assert.equal(typeof await supervisor.client.isTestFile(overloads.uri, 30_000), "boolean");
    const testClasspath = await supervisor.client.testClasspaths(overloads.uri, 30_000); assert.ok(Array.isArray(testClasspath.classpaths)); assert.equal(typeof testClasspath.projectRoot, "string");
    const broken = (await snapshots.verify("src/Unicode.java")).snapshot; await supervisor.client.syncDocument(broken); const diagnostics = await supervisor.client.diagnostics.waitFor(broken.uri, broken.version, 30_000); assert.ok(diagnostics?.diagnostics.some(d => d.range.start.line === 2), "ECJ diagnostic should identify public line 3");
    for (const path of ["src/org/junit/jupiter/api/Test.java", "src/OverloadsTest.java"]) { const snapshot = (await snapshots.verify(path)).snapshot; await supervisor.client.syncDocument(snapshot); }
    const sync = { indexGeneration: 1, snapshots, flush: async () => {}, verify: async (path: string) => { const known = snapshots.get(path); const snapshot = (await snapshots.verify(path)).snapshot; await supervisor.client.syncDocument(snapshot); await supervisor.client.watchedFile(path, known ? 2 : 1); return snapshot; } } as unknown as WorkspaceSynchronizer;
    const service = new JavaService(config, paths, sync, supervisor.client);
    const methods = await service.search({ query: "caller", mode: "exact", scope: "workspace", kinds: ["method"], includeImplementation: true, limit: 50, includeTotal: true }) as { symbols: Array<{ name: string; kind: string; startLine?: number; endLine?: number; implementation?: string }>; total: number };
    const caller = methods.symbols.find(symbol => symbol.name === "caller" && symbol.kind === "method"); assert.ok(caller, JSON.stringify(methods)); assert.equal(caller.startLine, 10); assert.equal(caller.endLine, 10); assert.match(caller.implementation ?? "", /return usedField \+ work\("text"\)/u); assert.ok(methods.total >= 1);
    const classes = await service.search({ query: "Overloads", mode: "exact", scope: "workspace", kinds: ["class"], includeImplementation: true, limit: 50, includeTotal: false }) as { symbols: Array<{ name: string; kind: string; startLine?: number; endLine?: number; implementation?: string }> };
    const overloadsClass = classes.symbols.find(symbol => symbol.name === "Overloads" && symbol.kind === "class"); assert.ok(overloadsClass, JSON.stringify(classes)); assert.equal(overloadsClass.startLine, 5); assert.equal(overloadsClass.endLine, 12); assert.match(overloadsClass.implementation ?? "", /public class Overloads implements Worker/u);
    const definition = await service.definition({ target: { path: "src/Overloads.java", line: 10, column: 64 }, expand: ["members"], contextLines: 10, maxSourceCharacters: 4000, includeDocumentation: false, maxDocumentationCharacters: 1000, limit: 10, includeTotal: false }) as { definitions: Array<{ kind: string; name: string; declarationStartLine: number; declarationEndLine: number; members?: object[] }> };
    assert.equal(definition.definitions[0]?.kind, "method"); assert.equal(definition.definitions[0]?.declarationStartLine, 8); assert.equal(definition.definitions[0]?.declarationEndLine, 8); assert.ok(definition.definitions[0]?.members?.length);
    const reads = await service.references({ target: { path: "src/Overloads.java", line: 6, column: 17 }, includeDeclaration: false, scope: "workspace", usageKinds: ["read"], includeEnclosing: true, includeText: false, contextLines: 1, maxSnippetCharacters: 1000, limit: 10, includeTotal: false }) as { references: Array<{ usageKind: string; enclosing?: { name?: string }; snippet?: object }> };
    assert.ok(reads.references.some(item => item.usageKind === "read" && item.enclosing?.name === "caller()" && item.snippet));
    const unused = await service.unusedCode({ path: "src/Overloads.java", kinds: ["method", "field"], includeWriteOnly: true, timeoutMs: 30_000, limit: 50, includeTotal: false }) as { candidates: Array<{ name: string; reason: string }> };
    assert.ok(unused.candidates.some(item => item.name === "unusedMethod()" && item.reason === "no-semantic-references")); assert.ok(unused.candidates.some(item => item.name === "unusedField")); assert.ok(!unused.candidates.some(item => item.name === "usedField"));
    const prepared = await supervisor.client.prepareCall(overloads.uri, { line: 9, character: 18 }, 30_000); const incoming = prepared[0] ? await supervisor.client.callIncoming(prepared[0], 30_000) : []; const testSnapshot = snapshots.get("src/OverloadsTest.java")!;
    assert.equal(typeof await supervisor.client.isTestFile(testSnapshot.uri, 30_000), "boolean"); assert.ok(incoming.length, JSON.stringify({ prepared, incoming }));
    const affected = await service.affectedTests({ target: { path: "src/Overloads.java", line: 10, column: 19 }, transitive: true, maxDepth: 10, timeoutMs: 30_000, limit: 50, includeTotal: false }) as { tests: Array<{ className: string; methodName: string }> };
    assert.ok(affected.tests.some(item => item.className === "OverloadsTest" && item.methodName === "exercisesCaller"), JSON.stringify(affected));
    const organizeBefore = await readFile(resolve(workspace, "src/Organize.java"), "utf8");
    const organized = await service.editPreview({ operation: "organizeImports", path: "src/Organize.java", includeDiff: true, limit: 10, includeTotal: false }) as { editCount: number; unifiedDiff?: string };
    assert.ok(organized.editCount > 0); assert.match(organized.unifiedDiff ?? "", /-import java\.util\.List;/u); assert.equal(await readFile(resolve(workspace, "src/Organize.java"), "utf8"), organizeBefore);
    const status = await supervisor.client.build(false, 120_000); assert.equal(typeof status, "number");
    const projects = await supervisor.client.projects(30_000); assert.ok(projects.length); const projectStatus = await supervisor.client.buildProjects(projects, false, 120_000); assert.equal(typeof projectStatus, "number");
    assert.equal(await readFile(source, "utf8"), before, "semantic queries and ECJ build must not change source");
  }
  finally { await supervisor.stop(); }
});

test("real JDT LS selectively imports Maven modules excluded at startup", { skip: !process.env.JAVA_LSP_MCP_INTEGRATION }, async () => {
  process.env.JAVA_LSP_MCP_CACHE_DIR = resolve(".runtime/cache");
  if (!process.env.JAVA_HOME) throw new Error("JAVA_HOME must point to an external JDK for integration tests");
  const workspace = resolve("test/fixtures/selective-maven"); const config = loadConfig(workspace, { trustWorkspace: true, toolingJdk: process.env.JAVA_HOME, excludedProjects: ["excluded"], timeoutMs: 120_000 }); const supervisor = new JdtSupervisor(config, new Logger("error"));
  try {
    await supervisor.start(); assert.equal(await supervisor.client.waitReady(120_000), true); const projects = await supervisor.client.projects(30_000);
    assert.ok(projects.some(uri => /\/included\/?$/u.test(new URL(uri).pathname)), JSON.stringify(projects)); assert.ok(!projects.some(uri => /\/excluded\/?$/u.test(new URL(uri).pathname)), JSON.stringify(projects));
  } finally { await supervisor.stop(); }
});

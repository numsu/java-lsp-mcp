import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runJUnit } from "../../src/testing/junit.js";
import { createCoverageReport } from "../../src/testing/coverage.js";

const execute = promisify(execFile);
test("targeted JUnit methods run in the external JDK", { skip: !process.env.JAVA_LSP_MCP_INTEGRATION }, async () => {
  if (!process.env.JAVA_HOME) throw new Error("JAVA_HOME must point to an external JDK for integration tests");
  const directory = await mkdtemp(join(tmpdir(), "java-lsp-mcp-junit-run-"));
  const classes = join(directory, "classes");
  const source = join(directory, "SampleTest.java");
  const console = resolve(".runtime/junit-console/junit-platform-console-standalone.jar");
  const coverageAgent = resolve(".runtime/jacoco/lib/jacocoagent.jar"); const coverageCli = resolve(".runtime/jacoco/lib/jacococli.jar");
  const executable = (name: string): string => join(process.env.JAVA_HOME!, "bin", process.platform === "win32" ? `${name}.exe` : name);
  try {
    await mkdir(classes);
    await writeFile(source, `import org.junit.jupiter.api.Test; import static org.junit.jupiter.api.Assertions.*; class SampleTest { @Test void passes() { System.out.print("löytyi"); assertEquals(1, 1); } @Test void fails() { assertEquals(1, 2); } }`);
    await execute(executable("javac"), ["-cp", console, "-d", classes, source]);
    const common = { java: executable("java"), console, classpaths: [classes, console], cwd: directory, vmArgs: [], systemProperties: {}, timeoutMs: 30_000, includeOutput: false, includeStackTrace: false, outputLimit: 12_000 };
    const passed = await runJUnit({ ...common, selectors: [{ className: "SampleTest", methodName: "passes", sourcePath: "SampleTest.java" }], includeOutput: true });
    assert.equal(passed.status, "passed"); assert.deepEqual(passed.counts, { passed: 1 }); assert.match(passed.output?.stdout ?? "", /löytyi/u);
    const failed = await runJUnit({ ...common, selectors: [{ className: "SampleTest", methodName: "fails", sourcePath: "SampleTest.java" }] });
    assert.equal(failed.status, "failed"); assert.deepEqual(failed.counts, { failed: 1 }); assert.equal(failed.failures.length, 1);
    const batch = await runJUnit({ ...common, selectors: [{ className: "SampleTest", methodName: "passes", sourcePath: "SampleTest.java" }, { className: "SampleTest", methodName: "fails", sourcePath: "SampleTest.java" }] });
    assert.equal(batch.status, "failed"); assert.deepEqual(batch.counts, { passed: 1, failed: 1 });
    const instrumented = await runJUnit({ ...common, selectors: [{ className: "SampleTest", methodName: "passes", sourcePath: "SampleTest.java" }], coverage: { agent: coverageAgent, includes: ["SampleTest"] } });
    assert.ok(instrumented.coverageData?.length);
    const coverage = await createCoverageReport({ java: executable("java"), cli: coverageCli, executionData: [instrumented.coverageData!], classpaths: [classes], sourceFiles: ["SampleTest.java"], cwd: directory, timeoutMs: 30_000 });
    assert.equal(coverage.complete, true); assert.ok((coverage.summary?.lines.covered ?? 0) > 0); assert.equal(coverage.files[0]?.path, "SampleTest.java");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJUnitReports } from "../../src/testing/junit.js";
import { parseCoverageXml } from "../../src/testing/coverage.js";

test("JUnit XML is compacted into counts and source line failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "java-lsp-mcp-junit-xml-"));
  try {
    await writeFile(join(directory, "TEST-Sample.xml"), `<?xml version="1.0"?><testsuite><testcase name="ok" classname="p.Sample" time="0.01"/><testcase name="bad" classname="p.Sample" time="0.02"><failure message="expected &lt;1&gt;"><![CDATA[java.lang.AssertionError\n at p.Sample.bad(Sample.java:17)]]></failure></testcase><testcase name="skip" classname="p.Sample"><skipped/></testcase></testsuite>`);
    const result = await parseJUnitReports(directory, "src/test/java/p/Sample.java", false);
    assert.deepEqual(result.counts, { passed: 1, failed: 1, skipped: 1 });
    assert.deepEqual(result.failures, [{ test: "bad", className: "p.Sample", durationMs: 20, message: "expected <1>", path: "src/test/java/p/Sample.java", line: 17 }]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("JaCoCo XML is compacted into summary and source locations", () => {
  const xml = `<?xml version="1.0"?><report name="sample"><package name="p"><sourcefile name="Sample.java"><line nr="3" mi="0" ci="4" mb="1" cb="1"/><line nr="4" mi="2" ci="0" mb="0" cb="0"/><counter type="INSTRUCTION" missed="2" covered="4"/><counter type="BRANCH" missed="1" covered="1"/><counter type="LINE" missed="1" covered="1"/></sourcefile></package><counter type="INSTRUCTION" missed="2" covered="4"/><counter type="BRANCH" missed="1" covered="1"/><counter type="LINE" missed="1" covered="1"/></report>`;
  assert.deepEqual(parseCoverageXml(xml, ["module/src/main/java/p/Sample.java"]), { complete: true, summary: { instructions: { covered: 4, missed: 2, percent: 66.67 }, branches: { covered: 1, missed: 1, percent: 50 }, lines: { covered: 1, missed: 1, percent: 50 } }, files: [{ path: "module/src/main/java/p/Sample.java", coveredLines: 1, missedLines: [4] }] });
});

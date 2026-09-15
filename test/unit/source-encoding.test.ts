import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SnapshotStore } from "../../src/workspace/snapshots.js";
import { WorkspacePaths } from "../../src/workspace/paths.js";

const legacySource = Buffer.concat([Buffer.from('class Legacy { String value = "l', "ascii"), Buffer.from([0xf6]), Buffer.from('ytyi"; }\n', "ascii")]);

test("source snapshots honor the Eclipse project encoding", async () => {
  const directory = await mkdtemp(join(tmpdir(), "java-lsp-mcp-encoding-"));
  try {
    await mkdir(join(directory, ".settings"));
    await writeFile(join(directory, ".settings", "org.eclipse.core.resources.prefs"), "eclipse.preferences.version=1\nencoding/<project>=windows-1252\n", "utf8");
    await writeFile(join(directory, "Legacy.java"), legacySource);
    const snapshot = (await new SnapshotStore(new WorkspacePaths(directory)).verify("Legacy.java")).snapshot;
    assert.match(snapshot.content, /löytyi/u); assert.doesNotMatch(snapshot.content, /�/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("startup source encoding overrides the UTF-8 default", async () => {
  const directory = await mkdtemp(join(tmpdir(), "java-lsp-mcp-encoding-"));
  try {
    await writeFile(join(directory, "Legacy.java"), legacySource);
    const snapshot = (await new SnapshotStore(new WorkspacePaths(directory), "windows-1252").verify("Legacy.java")).snapshot;
    assert.match(snapshot.content, /löytyi/u);
    await assert.rejects(new SnapshotStore(new WorkspacePaths(directory)).verify("Legacy.java"), /not valid UTF-8/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

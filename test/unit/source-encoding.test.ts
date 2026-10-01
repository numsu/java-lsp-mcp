import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger } from "../../src/logging.js";
import { SourceDecoder } from "../../src/workspace/encoding.js";
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
    await assert.rejects(new SnapshotStore(new WorkspacePaths(directory), "utf-8").verify("Legacy.java"), { code: "SOURCE_DECODING_FAILED" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("unconfigured legacy source reads use Windows-1252 and log an explicit warning", async t => {
  const directory = await mkdtemp(join(tmpdir(), "java-lsp-mcp-encoding-"));
  try {
    await writeFile(join(directory, "Legacy.java"), legacySource);
    const logger = new Logger("warn"); const warn = t.mock.method(logger, "warn", () => {});
    const paths = new WorkspacePaths(directory); const store = new SnapshotStore(paths, undefined, logger);
    const first = await store.verify("Legacy.java"); const second = await store.verify("Legacy.java");
    assert.equal(first.snapshot.content, legacySource.toString("latin1"));
    assert.equal(first.changed, true); assert.equal(second.changed, false);
    assert.equal(first.snapshot.version, second.snapshot.version);
    assert.ok(warn.mock.calls.length > 0);
    assert.match(warn.mock.calls[0]!.arguments[0] ?? "", /Windows-1252/u);
    assert.deepEqual(warn.mock.calls[0]!.arguments[1], { code: "SOURCE_ENCODING_FALLBACK", path: "Legacy.java" });
    const indexed = await new SourceDecoder(paths).readLenient(join(directory, "Legacy.java"));
    assert.equal(indexed.content, first.snapshot.content);
    assert.equal(indexed.warning?.code, "SOURCE_ENCODING_FALLBACK");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("fallback preserves Windows-1252 punctuation without modifying source bytes", async t => {
  const directory = await mkdtemp(join(tmpdir(), "java-lsp-mcp-encoding-"));
  try {
    const bytes = Buffer.from([0x80, 0x93, 0x94, 0x96, 0xe4, 0xf6]);
    const path = join(directory, "Legacy.java"); await writeFile(path, bytes);
    const logger = new Logger("warn"); t.mock.method(logger, "warn", () => {});
    const decoded = await new SourceDecoder(new WorkspacePaths(directory), undefined, logger).read(path);
    assert.equal(decoded, "\u20ac\u201c\u201d\u2013\u00e4\u00f6");
    assert.equal(await new SourceDecoder(new WorkspacePaths(directory), "windows-1252").read(path), decoded);
    assert.deepEqual(await readFile(path), bytes);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("valid UTF-8 keeps Unicode and emits no fallback warning", async t => {
  const directory = await mkdtemp(join(tmpdir(), "java-lsp-mcp-encoding-"));
  try {
    const source = 'class Unicode { String value = "\u00f6\u3042\ud83d\ude00"; }\r\n';
    await writeFile(join(directory, "Unicode.java"), source);
    const logger = new Logger("warn"); const warn = t.mock.method(logger, "warn", () => {});
    const snapshot = (await new SnapshotStore(new WorkspacePaths(directory), undefined, logger).verify("Unicode.java")).snapshot;
    assert.equal(snapshot.content, source); assert.equal(warn.mock.calls.length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("explicit encoding takes precedence over Eclipse settings and fallback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "java-lsp-mcp-encoding-"));
  try {
    await mkdir(join(directory, ".settings"));
    await writeFile(join(directory, ".settings", "org.eclipse.core.resources.prefs"), "encoding/<project>=windows-1252\n");
    await writeFile(join(directory, "Legacy.java"), Buffer.from([0x82, 0xa0]));
    const snapshot = (await new SnapshotStore(new WorkspacePaths(directory), "shift_jis").verify("Legacy.java")).snapshot;
    assert.equal(snapshot.content, "\u3042");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("unsupported encodings and unreadable files remain explicit errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "java-lsp-mcp-encoding-"));
  try {
    const paths = new WorkspacePaths(directory);
    assert.throws(() => new SourceDecoder(paths, "not-an-encoding"), { code: "UNSUPPORTED_SOURCE_ENCODING" });
    await assert.rejects(new SourceDecoder(paths).read(join(directory, "Missing.java")), { code: "ENOENT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

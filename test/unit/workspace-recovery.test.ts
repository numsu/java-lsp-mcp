import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecoverableWorkspaceLog, waitForRecoverableWorkspaceFailure, workspaceLogOffset } from "../../src/jdtls/workspace-recovery.js";

const brokenWorkspace = [
  "!SESSION 2026-10-01 11:31:54.862",
  "!MESSAGE The workspace exited with unsaved changes in the previous session; refreshing workspace to recover changes.",
  "!MESSAGE Exception in org.eclipse.core.resources.ResourcesPlugin.start() of bundle org.eclipse.core.resources.",
  "Caused by: org.eclipse.core.internal.dtree.ObjectNotFoundException: Tree element '/module/target/generated.xml' not found.",
  "at org.eclipse.core.internal.resources.SaveManager.restore(SaveManager.java:834)",
  "at org.eclipse.core.resources.ResourcesPlugin.start(ResourcesPlugin.java:565)",
].join("\n");

test("detects unrecoverable saved workspace deltas, not unrelated missing resources", () => {
  assert.equal(isRecoverableWorkspaceLog(brokenWorkspace), true);
  assert.equal(isRecoverableWorkspaceLog("ObjectNotFoundException: Tree element '/x' not found."), false);
  assert.equal(isRecoverableWorkspaceLog(brokenWorkspace.replace("SaveManager.restore(", "Other.restore(")), false);
});

test("monitors only new log entries and detects workspace corruption promptly", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "java-lsp-mcp-jdt-recovery-"));
  try {
    await mkdir(join(dataDir, ".metadata"));
    const log = join(dataDir, ".metadata", ".log");
    await writeFile(log, brokenWorkspace);
    const offset = await workspaceLogOffset(dataDir);
    const controller = new AbortController();
    const waiting = waitForRecoverableWorkspaceFailure(dataDir, offset, controller.signal);
    await appendFile(log, `\n${brokenWorkspace}`);
    assert.equal(await waiting, true);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("monitor stops cleanly when initialization succeeds", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "java-lsp-mcp-jdt-recovery-"));
  try {
    const controller = new AbortController();
    const waiting = waitForRecoverableWorkspaceFailure(dataDir, 0, controller.signal);
    controller.abort();
    assert.equal(await waiting, false);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import type { LspClient } from "../../src/jdtls/client.js";
import { JavaService } from "../../src/mcp/service.js";
import { WorkspacePaths } from "../../src/workspace/paths.js";
import { SnapshotStore } from "../../src/workspace/snapshots.js";
import type { WorkspaceSynchronizer } from "../../src/workspace/watcher.js";

test("code-action previews resolve lazy JDT edits", async () => {
  const workspace = resolve("test/fixtures/unmanaged"); const paths = new WorkspacePaths(workspace); const snapshots = new SnapshotStore(paths); const snapshot = (await snapshots.verify("src/Overloads.java")).snapshot; let resolutions = 0;
  const edit = { changes: { [snapshot.uri]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "// resolved\n" }] } };
  const client = { state: "ready", waitReady: async () => true, diagnostics: { get: () => undefined }, codeActions: async () => [{ title: "Resolve me", kind: "quickfix", data: { id: 1 } }], resolveCodeAction: async (action: object) => { resolutions++; return { ...action, edit }; } } as unknown as LspClient;
  const sync = { indexGeneration: 1, flush: async () => {}, verify: async () => snapshot, snapshots } as unknown as WorkspaceSynchronizer;
  const config = { workspace, offline: true, trustWorkspace: false, maxHeap: "1g", resultMode: "structured", logLevel: "error", timeoutMs: 1000, resultBudget: 12_000 } as const;
  const service = new JavaService(config, paths, sync, client);
  const actions = await service.codeActions({ path: snapshot.path, range: { line: 1, column: 1, endLine: 1, endColumn: 1 }, diagnosticCodes: [], kinds: ["quickfix"], limit: 50, includeTotal: false }) as { actions: Array<{ id: string }> };
  const preview = await service.editPreview({ operation: "codeAction", id: actions.actions[0]!.id, includeDiff: false, limit: 50, includeTotal: false }) as { editCount: number; files: Array<{ edits: object[] }> };
  assert.equal(resolutions, 1); assert.equal(preview.editCount, 1); assert.equal(preview.files[0]!.edits.length, 1);
});

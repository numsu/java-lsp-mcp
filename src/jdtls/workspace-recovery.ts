import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const pollIntervalMs = 250;
const maxBufferedLogCharacters = 256_000;

export async function workspaceLogOffset(dataDir: string): Promise<number> {
  try { return (await stat(join(dataDir, ".metadata", ".log"))).size; }
  catch (error) {
    if (isMissingFile(error)) return 0;
    throw error;
  }
}

export async function waitForRecoverableWorkspaceFailure(dataDir: string, initialOffset: number, signal: AbortSignal): Promise<boolean> {
  const path = join(dataDir, ".metadata", ".log");
  let offset = initialOffset;
  let buffered = "";
  while (!signal.aborted) {
    const appended = await readAppended(path, offset);
    offset = appended.offset;
    buffered = (buffered + appended.text).slice(-maxBufferedLogCharacters);
    if (isRecoverableWorkspaceLog(buffered)) return true;
    try { await delay(pollIntervalMs, undefined, { signal }); }
    catch (error) { if (signal.aborted) return false; throw error; }
  }
  return false;
}

export function isRecoverableWorkspaceLog(log: string): boolean {
  return log.includes("The workspace exited with unsaved changes in the previous session")
    && /org\.eclipse\.core\.internal\.dtree\.ObjectNotFoundException: Tree element '[^\r\n]+' not found\./u.test(log)
    && log.includes("org.eclipse.core.internal.resources.SaveManager.restore(")
    && log.includes("org.eclipse.core.resources.ResourcesPlugin.start(");
}

async function readAppended(path: string, offset: number): Promise<{ offset: number; text: string }> {
  let file;
  try { file = await open(path, "r"); }
  catch (error) {
    if (isMissingFile(error)) return { offset, text: "" };
    throw error;
  }
  try {
    const { size } = await file.stat();
    const start = size < offset ? 0 : offset;
    const length = size - start;
    if (!length) return { offset: size, text: "" };
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, start);
    return { offset: start + bytesRead, text: buffer.subarray(0, bytesRead).toString("utf8") };
  } finally { await file.close(); }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

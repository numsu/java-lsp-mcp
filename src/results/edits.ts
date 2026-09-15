import { createHash } from "node:crypto";
import { createTwoFilesPatch } from "diff";
import { JavaLspMcpError, type LspRange } from "../types.js";
import { lines, utf16ToCodePointColumn } from "./positions.js";

export interface TextEdit { range: LspRange; newText: string }
export function sha256(content: string): string { return createHash("sha256").update(content).digest("hex"); }
export function offsetAt(content: string, line: number, character: number): number {
  const ls = content.split(/(?<=\n)/u);
  if (line < 0 || line >= ls.length) throw new JavaLspMcpError("INVALID_EDIT", "Edit line is outside file");
  const prefix = ls.slice(0, line).join("");
  const logical = ls[line]!.replace(/\r?\n$/u, "");
  if (character < 0 || character > logical.length) throw new JavaLspMcpError("INVALID_EDIT", "Edit column is outside line");
  try { utf16ToCodePointColumn(logical, character); } catch { throw new JavaLspMcpError("INVALID_EDIT", "Edit column splits a Unicode surrogate pair"); }
  return prefix.length + character;
}
export function validateAndSortEdits(content: string, edits: readonly TextEdit[]): TextEdit[] {
  const sorted = [...edits].sort((a, b) => offsetAt(content, b.range.start.line, b.range.start.character) - offsetAt(content, a.range.start.line, a.range.start.character));
  let previousStart = content.length + 1;
  for (const edit of sorted) {
    const start = offsetAt(content, edit.range.start.line, edit.range.start.character);
    const end = offsetAt(content, edit.range.end.line, edit.range.end.character);
    if (end < start || end > previousStart) throw new JavaLspMcpError("OVERLAPPING_EDITS", "JDT returned overlapping text edits");
    previousStart = start;
  }
  return sorted;
}
export function applyEdits(content: string, edits: readonly TextEdit[]): string {
  let result = content;
  for (const edit of validateAndSortEdits(content, edits)) {
    const start = offsetAt(content, edit.range.start.line, edit.range.start.character);
    const end = offsetAt(content, edit.range.end.line, edit.range.end.character);
    result = result.slice(0, start) + edit.newText + result.slice(end);
  }
  return result;
}
export function unifiedDiff(path: string, before: string, edits: readonly TextEdit[]): string {
  return createTwoFilesPatch(`a/${path}`, `b/${path}`, before, applyEdits(before, edits), "", "", { context: 3 });
}
export function publicEdit(content: string, edit: TextEdit): Record<string, unknown> {
  const source = lines(content);
  return {
    startLine: edit.range.start.line + 1,
    startColumn: utf16ToCodePointColumn(source[edit.range.start.line] ?? "", edit.range.start.character),
    endLine: edit.range.end.line + 1,
    endColumn: utf16ToCodePointColumn(source[edit.range.end.line] ?? "", edit.range.end.character),
    newText: edit.newText,
  };
}

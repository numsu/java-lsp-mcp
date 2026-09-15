import type { LspRange, PublicLocation, Snapshot } from "../types.js";
import type { WorkspacePaths } from "../workspace/paths.js";

export function utf16ToCodePointColumn(line: string, utf16Column: number): number {
  if (!Number.isInteger(utf16Column) || utf16Column < 0) throw new RangeError("UTF-16 column must be a non-negative integer");
  let units = 0, points = 0;
  for (const char of line) {
    if (units >= utf16Column) break;
    units += char.length;
    points++;
    if (units > utf16Column) throw new RangeError("UTF-16 column splits a surrogate pair");
  }
  if (units < utf16Column) throw new RangeError("UTF-16 column exceeds line length");
  return points + 1;
}

export function codePointToUtf16Column(line: string, publicColumn: number): number {
  if (!Number.isInteger(publicColumn) || publicColumn < 1) throw new RangeError("Column must be a positive integer");
  const wanted = publicColumn - 1;
  let points = 0, units = 0;
  for (const char of line) {
    if (points === wanted) return units;
    points++; units += char.length;
  }
  if (points === wanted) return units;
  throw new RangeError("Column exceeds line length");
}

export function lines(content: string): string[] { return content.split(/\r\n|\n|\r/u); }

export function publicLocation(paths: WorkspacePaths, snapshot: Snapshot | undefined, uri: string, range: LspRange): PublicLocation {
  const target = paths.fromUri(uri);
  const sourceLines = snapshot ? lines(snapshot.content) : [];
  const start = sourceLines[range.start.line];
  const end = sourceLines[range.end.line];
  const location: PublicLocation = {
    path: target.path, line: range.start.line + 1,
    column: start === undefined ? range.start.character + 1 : utf16ToCodePointColumn(start, range.start.character),
    origin: target.origin, editable: target.editable,
  };
  if (range.end.line !== range.start.line || range.end.character !== range.start.character) {
    location.endLine = range.end.line + 1;
    location.endColumn = end === undefined ? range.end.character + 1 : utf16ToCodePointColumn(end, range.end.character);
  }
  return location;
}

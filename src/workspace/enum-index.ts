import { relative, sep } from "node:path";
import type { WorkspacePaths } from "./paths.js";
import { workspaceFiles } from "./files.js";
import { SourceDecoder } from "./encoding.js";

export interface EnumConstantEntry { name: string; container: string; path: string; line: number; warning?: { code: string; path: string; message: string } }
interface Token { value: string; line: number }

export class EnumConstantIndex {
  private generation = -1;
  private entries: EnumConstantEntry[] = [];
  private readonly decoder: SourceDecoder;

  constructor(private readonly paths: WorkspacePaths, sourceEncoding?: string) { this.decoder = new SourceDecoder(paths, sourceEncoding); }

  async all(generation: number, excludedRoots: string[]): Promise<EnumConstantEntry[]> {
    if (this.generation === generation) return this.entries;
    const entries: EnumConstantEntry[] = [];
    for (const absolute of workspaceFiles(this.paths.root, name => name.endsWith(".java"))) {
      if (excludedRoots.some(root => absolute === root || absolute.startsWith(`${root}${sep}`))) continue;
      const path = relative(this.paths.root, absolute).split(sep).join("/");
      try {
        const decoded = await this.decoder.readLenient(absolute);
        for (const entry of enumConstants(decoded.content)) entries.push({ ...entry, path, ...(decoded.warning && { warning: { ...decoded.warning, path } }) });
      } catch { /* An unreadable file must not make workspace symbol search fail. */ }
    }
    this.entries = entries;
    this.generation = generation;
    return entries;
  }
}

export function enumConstants(source: string): Array<Omit<EnumConstantEntry, "path" | "warning">> {
  const tokens = tokenize(source); const result: Array<Omit<EnumConstantEntry, "path" | "warning">> = [];
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index]!.value !== "enum") continue;
    const name = tokens[index + 1]; if (!name || !identifier(name.value)) continue;
    let open = index + 2; while (open < tokens.length && tokens[open]!.value !== "{") open++;
    if (open === tokens.length) continue;
    let braces = 0, parentheses = 0, brackets = 0; let segment: Token[] = [];
    const emit = (): void => { const constant = firstConstant(segment); if (constant) result.push({ name: constant.value, container: name.value, line: constant.line }); segment = []; };
    for (let cursor = open + 1; cursor < tokens.length; cursor++) {
      const token = tokens[cursor]!;
      if (token.value === "{" ) braces++;
      else if (token.value === "}") { if (braces === 0) { emit(); index = cursor; break; } braces--; }
      else if (token.value === "(") parentheses++;
      else if (token.value === ")") parentheses--;
      else if (token.value === "[") brackets++;
      else if (token.value === "]") brackets--;
      if (braces === 0 && parentheses === 0 && brackets === 0 && (token.value === "," || token.value === ";")) {
        emit(); if (token.value === ";") break;
      } else segment.push(token);
    }
  }
  return result;
}

function firstConstant(tokens: Token[]): Token | undefined {
  let index = 0;
  while (tokens[index]?.value === "@") {
    index++;
    if (identifier(tokens[index]?.value ?? "")) index++;
    while (tokens[index]?.value === "." && identifier(tokens[index + 1]?.value ?? "")) index += 2;
    if (tokens[index]?.value === "(") { let depth = 1; for (index++; index < tokens.length && depth; index++) depth += tokens[index]!.value === "(" ? 1 : tokens[index]!.value === ")" ? -1 : 0; }
  }
  return identifier(tokens[index]?.value ?? "") ? tokens[index] : undefined;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = []; let index = 0, line = 1;
  const advance = (): string => { const value = source[index++]!; if (value === "\n") line++; return value; };
  while (index < source.length) {
    const char = source[index]!;
    if (/\s/u.test(char)) { advance(); continue; }
    if (char === "/" && source[index + 1] === "/") { while (index < source.length && advance() !== "\n") {} continue; }
    if (char === "/" && source[index + 1] === "*") { advance(); advance(); while (index < source.length) { if (source[index] === "*" && source[index + 1] === "/") { advance(); advance(); break; } advance(); } continue; }
    if (char === '"' || char === "'") { const quote = advance(); const textBlock = quote === '"' && source.slice(index - 1, index + 2) === '\"\"\"'; if (textBlock) { advance(); advance(); while (index < source.length && source.slice(index, index + 3) !== '\"\"\"') advance(); for (let n = 0; n < 3 && index < source.length; n++) advance(); } else while (index < source.length) { const value = advance(); if (value === "\\" && index < source.length) advance(); else if (value === quote) break; } continue; }
    const tokenLine = line;
    if (/[$_\p{L}]/u.test(char)) { let value = advance(); while (index < source.length && /[$_\p{L}\p{N}]/u.test(source[index]!)) value += advance(); tokens.push({ value, line: tokenLine }); continue; }
    tokens.push({ value: advance(), line: tokenLine });
  }
  return tokens;
}

function identifier(value: string): boolean { return /^[$_\p{L}][$_\p{L}\p{N}]*$/u.test(value); }

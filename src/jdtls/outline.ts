import type { DocumentSymbol } from "./protocol.js";

/** Detect the transient package-only result JDT LS can return while reconciling. */
export function outlineNeedsReconcile(symbols: DocumentSymbol[], path: string, source: string): boolean {
  if (/(?:^|\/)package-info\.java$/iu.test(path.replaceAll("\\", "/"))) return false;
  if (symbols.length === 0) return true;
  const packageName = /^\s*package\s+([\p{ID_Continue}.$]+)\s*;/mu.exec(source)?.[1];
  return Boolean(packageName) && symbols.every(symbol => symbol.name === packageName);
}
